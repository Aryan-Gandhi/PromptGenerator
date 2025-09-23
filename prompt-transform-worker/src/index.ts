export interface Env {
  OPENAI_API_KEY: string;
  DEFAULT_MODEL?: string;
  MOCK_TRANSFORM?: string;
  ALLOWED_ORIGINS?: string;
}

type TransformBody = {
  prompt?: string;
  mode?: string;
  model?: string;
};

type OpenAIResponsesOutput = {
  id: string;
  type: string;
  role?: string;
  content?: Array<{ type: string; text?: string }>;
};

type OpenAIResponsesResult = {
  output?: OpenAIResponsesOutput[];
  usage?: {
    total_tokens?: number;
  };
};

type CachedTransformRecord = {
  structuredPrompt: string;
  model: string;
  usage?: number | null;
  mocked?: boolean;
  cachedAt: number;
};

const DEFAULT_MODEL = "gpt-4o-mini";
const CACHE_TTL_SECONDS = 60 * 60 * 24 * 15; // 15 days
const CACHE_CACHE_KEY_PREFIX = "https://promptgear-cache.internal/transform/";
const OPENAI_TIMEOUT_MS = 25000;
const OPENAI_TIMEOUT_STEP_MS = 5000;
const INITIAL_BACKOFF_MS = 400;
const MAX_BACKOFF_MS = 6000;
const OPENAI_ENDPOINT = "https://api.openai.com/v1/responses";
const NO_ORIGIN_TOKEN = "<no-origin>";
const DEBUG_PREFIX = "Prompt Transform Worker:";
const MAX_OPENAI_RETRIES = 2;
const RETRYABLE_STATUS = new Set([408, 409, 425, 429, 500, 502, 503, 504, 524]);
let lastSuccessfulTransform: number | null = null;
let lastErrorRecord: { timestamp: number; message: string; status?: number } | null = null;

// const SYSTEM_PROMPT_BASE = `You are Prompt Structurer, an assistant that rewrites raw user prompts into a
// concise sequenced scaffold so that large language models perform reliably.
// Always produce plain text in this exact order:

// Role: <single sentence describing the assistant role>
// Task: <one-sentence restatement of the user request>
// Context: <2-3 bullet points or sentences clarifying important constraints>
// Reasoning: <2-4 bullet points that outline the thought process or checks>
// Output Format: <specific formatting instructions such as bullet list, table, etc.>
// Stop Conditions: <conditions for when the assistant should stop>

// Keep the tone professional and helpful. Do not invent facts. If the user prompt
// is empty, ask them for more detail.
// `; // Mode-specific text appended later.

const SYSTEM_PROMPT_BASE = `You are Prompt Structurer—a meta-assistant that tidies raw prompts so the responding model can do focused work.
Review the user’s request carefully and respond with short, plain-text sections.

Role: Choose the most relevant expert identity for the request (keep it specific whenever possible).
Task: Restate the user’s objective in one sentence and mention missing details if they matter.
Context: Highlight key constraints, background, assumptions, audience hints, or timelines from the prompt (2–3 bullets or short sentences).
Reasoning: List the main checks or thought steps the assistant should follow so the answer stays accurate and useful (2–4 bullets).
Stop Conditions: Explain when the assistant should stop (e.g., once goals are met, if more info is required, or when policy/safety issues arise).

Keep the tone practical, avoid inventing facts, and be concise—no extra sections are required.`;


export function buildSystemPrompt(mode?: string): string {
  if (!mode) return SYSTEM_PROMPT_BASE;

  const modeLower = mode.toLowerCase();
  const modeHintMap: Record<string, string> = {
    coding:
      "When crafting sections, emphasize debugging steps, code safety checks, and preferred languages.",
    research:
      "Prioritize primary sources, methodologies, and clear criteria for evaluating evidence.",
    travel:
      "Highlight location details, logistics, and user preferences for destinations.",
    writing:
      "Focus on tone, narrative structure, and revision guidelines to elevate written outputs."
  };

  const hint = modeHintMap[modeLower] ?? `Incorporate requirements relevant to the "${mode}" domain.`;
  return `${SYSTEM_PROMPT_BASE}\nMode guidance: ${hint}`;
}

const MOCK_ROLE_KEYWORDS: Array<{ role: string; keywords: string[] }> = [
  { role: "neuroscientist", keywords: ["neuro", "brain", "cortex"] },
  { role: "data scientist", keywords: ["data", "model", "analytics"] },
  { role: "software engineer", keywords: ["code", "bug", "script", "refactor"] },
  { role: "cybersecurity analyst", keywords: ["security", "threat", "breach", "malware"] },
  { role: "financial analyst", keywords: ["finance", "investment", "budget", "valuation"] },
  { role: "medical doctor", keywords: ["patient", "symptom", "diagnosis", "treatment"] }
];

function isMockEnabled(env: Env): boolean {
  return env.MOCK_TRANSFORM === "true" || env.OPENAI_API_KEY === "MOCK";
}

function mockRole(prompt: string): string {
  const lower = prompt.toLowerCase();
  for (const entry of MOCK_ROLE_KEYWORDS) {
    if (entry.keywords.some((keyword) => lower.includes(keyword))) {
      return entry.role;
    }
  }
  const noun = lower.match(/[a-z0-9-]+/g)?.find((token) => token.length > 4) ?? "subject";
  return `${noun} specialist`;
}

function buildMockStructuredPrompt(prompt: string, mode?: string): string {
  const trimmed = prompt.trim();
  if (!trimmed) {
    return "Role: subject-matter expert.\nTask: Await further instructions.\nContext: No request provided.\nReasoning:\n- Ask the user for a concrete objective.\nStop Conditions:\n- Stop until the user supplies a prompt.";
  }

  const role = mockRole(trimmed);
  const modeNote = mode ? `Mode: ${mode}. ` : "";

  return [
    `Role: ${role}.`,
    `Task: ${trimmed}`,
    `Context:\n- ${modeNote}This scaffold was generated from the raw prompt while running in local mock mode.`,
    `Reasoning:\n- Highlight missing details before proceeding.\n- Outline the major steps required to satisfy the request.\n- Note any assumptions that must be validated.`,
    "Stop Conditions:\n- Pause if critical information is missing.\n- Finish once all deliverables from the task statement are complete."
  ].join("\n");
}

async function sleep(ms: number): Promise<void> {
  await new Promise((resolve) => setTimeout(resolve, ms));
}

const textEncoder = new TextEncoder();

async function buildCacheKey(prompt: string, mode: string | undefined, model: string): Promise<string> {
  const raw = JSON.stringify({ prompt, mode: mode ?? null, model });
  const digest = await crypto.subtle.digest("SHA-256", textEncoder.encode(raw));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function cacheRequestForKey(key: string): Request {
  return new Request(`${CACHE_CACHE_KEY_PREFIX}${key}`, {
    method: "GET"
  });
}

async function readCachedTransform(key: string): Promise<CachedTransformRecord | null> {
  try {
    const match = await caches.default.match(cacheRequestForKey(key));
    if (!match) {
      return null;
    }
    const data = (await match.json()) as CachedTransformRecord;
    if (!data || typeof data.structuredPrompt !== "string") {
      return null;
    }
    return data;
  } catch (error) {
    console.warn(DEBUG_PREFIX, "failed to read cache", error);
    return null;
  }
}

async function writeCachedTransform(key: string, record: CachedTransformRecord): Promise<void> {
  try {
    const response = new Response(JSON.stringify(record), {
      headers: {
        "cache-control": `max-age=${CACHE_TTL_SECONDS}`,
        "content-type": "application/json"
      }
    });
    await caches.default.put(cacheRequestForKey(key), response);
  } catch (error) {
    console.warn(DEBUG_PREFIX, "failed to write cache", error);
  }
}

class OpenAIRequestError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string, message?: string) {
    super(message ?? `OpenAI request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

function shouldRetry(status: number): boolean {
  return RETRYABLE_STATUS.has(status) || status === 0;
}

function parseErrorBody(body: string): unknown {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

function parseAllowedOrigins(env: Env): Set<string> {
  const raw = env.ALLOWED_ORIGINS ?? "";
  if (!raw.trim()) {
    return new Set();
  }
  return new Set(
    raw
      .split(/[,\s]+/)
      .map((entry) => entry.trim())
      .filter(Boolean)
  );
}

type CorsResolution = {
  allowed: boolean;
  originHeader: string | null;
  vary: boolean;
};

function resolveCors(origin: string | null, allowedOrigins: Set<string>): CorsResolution {
  if (allowedOrigins.size === 0) {
    return { allowed: false, originHeader: null, vary: true };
  }

  if (allowedOrigins.has("*")) {
    return {
      allowed: true,
      originHeader: origin ?? "*",
      vary: true
    };
  }

  if (!origin) {
    return {
      allowed: allowedOrigins.has(NO_ORIGIN_TOKEN),
      originHeader: null,
      vary: true
    };
  }

  if (allowedOrigins.has(origin)) {
    return { allowed: true, originHeader: origin, vary: true };
  }

  for (const candidate of allowedOrigins) {
    if (candidate.endsWith("*") && candidate !== "*") {
      const prefix = candidate.slice(0, -1);
      if (origin.startsWith(prefix)) {
        return { allowed: true, originHeader: origin, vary: true };
      }
    }
  }

  return { allowed: false, originHeader: null, vary: true };
}

function withCorsHeaders(origin: string | null, init: ResponseInit = {}, vary = true): ResponseInit {
  const headers = new Headers(init.headers);
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  headers.set("Access-Control-Allow-Headers", "content-type, authorization");
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (vary) {
    headers.append("Vary", "Origin");
  }
  return { ...init, headers };
}

function jsonResponse(body: unknown, init: ResponseInit = {}, cors?: CorsResolution): Response {
  const responseInit = withCorsHeaders(cors?.originHeader ?? null, init, cors?.vary ?? true);
  const headers = new Headers(responseInit.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...responseInit, headers });
}

function handleOptions(cors: CorsResolution): Response {
  if (!cors.allowed) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, withCorsHeaders(cors.originHeader, { status: 204 }, cors.vary));
}

function buildHealthPayload(env: Env): { payload: Record<string, unknown>; status: number } {
  const now = Date.now();
  const mockMode = isMockEnabled(env);
  const lastSuccessIso = lastSuccessfulTransform ? new Date(lastSuccessfulTransform).toISOString() : null;
  const lastErrorIso = lastErrorRecord ? new Date(lastErrorRecord.timestamp).toISOString() : null;
  const healthy =
    lastSuccessfulTransform !== null &&
    (!lastErrorRecord || lastSuccessfulTransform >= lastErrorRecord.timestamp);

  return {
    payload: {
      status: healthy ? "ok" : "degraded",
      mockMode,
      lastSuccessfulTransform: lastSuccessIso,
      lastError: lastErrorRecord
        ? {
            timestamp: lastErrorIso,
            message: lastErrorRecord.message,
            httpStatus: lastErrorRecord.status ?? null
          }
        : null,
      timestamp: new Date(now).toISOString()
    },
    status: healthy ? 200 : 503
  };
}

async function callOpenAI(prompt: string, mode: string | undefined, model: string, env: Env): Promise<{
  structuredPrompt: string;
  usage?: number;
}> {
  if (!env.OPENAI_API_KEY) {
    throw new Error("OPENAI_API_KEY is not set in the Worker environment");
  }

  const systemPrompt = buildSystemPrompt(mode);

  const payload = {
    model,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: systemPrompt }]
      },
      {
        role: "user",
        content: [{ type: "input_text", text: prompt }]
      }
    ]
  };

  let attempt = 0;
  let backoffMs = INITIAL_BACKOFF_MS;
  let response: Response | null = null;

  while (attempt <= MAX_OPENAI_RETRIES) {
    const attemptTimeoutMs = OPENAI_TIMEOUT_MS + attempt * OPENAI_TIMEOUT_STEP_MS;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), attemptTimeoutMs);
    try {
      response = await fetch(OPENAI_ENDPOINT, {
        method: "POST",
        headers: {
          "content-type": "application/json",
          Authorization: `Bearer ${env.OPENAI_API_KEY}`
        },
        body: JSON.stringify(payload),
        signal: controller.signal
      });
    } catch (networkError) {
      clearTimeout(timeout);
      const isAbortError = networkError instanceof Error && networkError.name === "AbortError";
      const status = isAbortError ? 408 : 0;
      const message = isAbortError
        ? `OpenAI request timed out after ${attemptTimeoutMs}ms`
        : networkError instanceof Error
        ? networkError.message
        : "Network error";
      if (attempt < MAX_OPENAI_RETRIES && shouldRetry(status)) {
        const delay = Math.min(backoffMs, MAX_BACKOFF_MS) + Math.random() * 150;
        await sleep(delay);
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        attempt += 1;
        continue;
      }
      throw new OpenAIRequestError(status, message, message);
    } finally {
      clearTimeout(timeout);
    }

    if (response.ok) {
      break;
    }

    const errorText = await response.text();
    if (attempt < MAX_OPENAI_RETRIES && shouldRetry(response.status)) {
      const retryAfter = response.headers.get("retry-after");
      let delay = Math.min(backoffMs, MAX_BACKOFF_MS);
      if (retryAfter) {
        const retryAfterSeconds = Number(retryAfter);
        if (!Number.isNaN(retryAfterSeconds)) {
          delay = Math.max(retryAfterSeconds * 1000, delay);
        }
      }
      await sleep(Math.min(delay + Math.random() * 200, MAX_BACKOFF_MS));
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      attempt += 1;
      continue;
    }

    throw new OpenAIRequestError(response.status, errorText);
  }

  if (!response) {
    throw new OpenAIRequestError(500, "No response from OpenAI");
  }

  const json = (await response.json()) as OpenAIResponsesResult & { output_text?: string[] };

  let structuredPrompt = "";

  if (Array.isArray(json.output_text) && json.output_text.length > 0) {
    structuredPrompt = json.output_text.join("\n").trim();
  }

  if (!structuredPrompt && Array.isArray(json.output)) {
    const outputEntry = json.output.find((entry) => entry.type === "message") ?? json.output[0];

    if (outputEntry?.content && Array.isArray(outputEntry.content)) {
      structuredPrompt = outputEntry.content
        .filter((part) => part.type === "output_text" || part.type === "text")
        .map((part) => part.text ?? "")
        .join("")
        .trim();
    } else if (
      outputEntry &&
      "text" in outputEntry &&
      typeof (outputEntry as unknown as { text?: string }).text === "string"
    ) {
      structuredPrompt = ((outputEntry as unknown as { text?: string }).text ?? "").trim();
    }
  }

  if (!structuredPrompt) {
    throw new Error("OpenAI response did not include any content");
  }

  return {
    structuredPrompt,
    usage: json.usage?.total_tokens
  };
}

export { isMockEnabled, buildMockStructuredPrompt };

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    const allowedOrigins = parseAllowedOrigins(env);
    const cors = resolveCors(request.headers.get("Origin"), allowedOrigins);

    if (request.method === "OPTIONS") {
      return handleOptions(cors);
    }

    const url = new URL(request.url);
    if (request.method === "GET" && url.pathname === "/health") {
      const { payload, status } = buildHealthPayload(env);
      return jsonResponse(payload, { status }, cors);
    }

    if (url.pathname !== "/transform") {
      return jsonResponse({ error: "Not found" }, { status: 404 }, cors);
    }

    if (request.method !== "POST") {
      return jsonResponse({ error: "Method not allowed" }, { status: 405 }, cors);
    }

    if (!cors.allowed) {
      console.warn(DEBUG_PREFIX, "blocked request from origin", request.headers.get("Origin") ?? "<no-origin>");
      return jsonResponse({ error: "Origin not allowed" }, { status: 403 }, cors);
    }

    let body: TransformBody;
    try {
      body = (await request.json()) as TransformBody;
    } catch (error) {
      return jsonResponse({ error: "Invalid JSON body" }, { status: 400 }, cors);
    }

    const rawPrompt = body.prompt?.trim();
    if (!rawPrompt) {
      return jsonResponse({ error: "Missing required field: prompt" }, { status: 400 }, cors);
    }

    const model = body.model ?? env.DEFAULT_MODEL ?? DEFAULT_MODEL;

    if (isMockEnabled(env)) {
      const mock = buildMockStructuredPrompt(rawPrompt, body.mode);
      lastSuccessfulTransform = Date.now();
      lastErrorRecord = null;
      return jsonResponse({
        structuredPrompt: mock,
        model,
        usage: { totalTokens: null },
        mocked: true
      }, {}, cors);
    }

    try {
      const cacheKey = await buildCacheKey(rawPrompt, body.mode, model);
      const cached = await readCachedTransform(cacheKey);
      if (cached) {
        lastSuccessfulTransform = Date.now();
        lastErrorRecord = null;
        return jsonResponse({
          structuredPrompt: cached.structuredPrompt,
          model: cached.model ?? model,
          usage: { totalTokens: cached.usage ?? null },
          cached: true
        }, {}, cors);
      }

      const result = await callOpenAI(rawPrompt, body.mode, model, env);
      await writeCachedTransform(cacheKey, {
        structuredPrompt: result.structuredPrompt,
        model,
        usage: result.usage ?? null,
        cachedAt: Date.now()
      });
      lastSuccessfulTransform = Date.now();
      lastErrorRecord = null;
      return jsonResponse({
        structuredPrompt: result.structuredPrompt,
        model,
        usage: { totalTokens: result.usage ?? null }
      }, {}, cors);
    } catch (error) {
      console.error(DEBUG_PREFIX, "transform failed", error);

      let status = 502;
      let message = "Unexpected error";
      let details: unknown = null;
      let retryable = false;

      if (error instanceof OpenAIRequestError) {
        status = error.status === 0 ? 502 : error.status;
        details = parseErrorBody(error.body);
        if (details && typeof details === "object" && "error" in (details as Record<string, unknown>)) {
          const extracted = (details as Record<string, any>).error;
          if (extracted && typeof extracted === "object") {
            message = extracted.message ?? message;
          }
        } else if (typeof details === "string" && details.trim().length > 0) {
          message = details;
        } else if (error.body && error.body.trim().length > 0) {
          message = error.body;
        }
        retryable = shouldRetry(status);
      } else if (error instanceof Error) {
        message = error.message || message;
      }

      const responsePayload: Record<string, unknown> = {
        error: message,
        status,
        retryable
      };

      lastErrorRecord = {
        timestamp: Date.now(),
        message,
        status
      };

      if (details && typeof details === "object") {
        responsePayload.details = details;
      }

      return jsonResponse(responsePayload, { status }, cors);
    }
  }
};

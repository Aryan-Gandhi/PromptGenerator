import {
  INITIAL_BACKOFF_MS,
  MAX_BACKOFF_MS,
  MAX_OPENAI_RETRIES,
  OPENAI_RESPONSES_ENDPOINT,
  RETRYABLE_STATUS
} from "./constants";
import {
  buildChatPayload,
  buildResponsesPayload,
  buildSystemPrompt,
  resolveRuntimeConfig
} from "./runtime";
import type { Env, RuntimeConfig } from "./types";

export class LLMRequestError extends Error {
  status: number;
  body: string;

  constructor(status: number, body: string, message?: string) {
    super(message ?? `LLM request failed (${status})`);
    this.status = status;
    this.body = body;
  }
}

function shouldRetry(status: number): boolean {
  return RETRYABLE_STATUS.has(status) || status === 0;
}

function shouldFallbackToOpenAI(config: RuntimeConfig, env: Env, usedFallback: boolean): boolean {
  return !usedFallback && !!env.OPENAI_API_KEY && config.endpoint !== OPENAI_RESPONSES_ENDPOINT;
}

function parseResponsesCompletion(json: any): string {
  if (Array.isArray(json?.output_text) && json.output_text.length > 0) {
    const joined = json.output_text.join("\n").trim();
    if (joined) {
      return joined;
    }
  }

  if (Array.isArray(json?.output)) {
    const outputEntry = json.output.find((entry: any) => entry?.type === "message") ?? json.output[0];
    if (Array.isArray(outputEntry?.content)) {
      const collected = outputEntry.content
        .filter((part: any) => part?.type === "output_text" || part?.type === "text")
        .map((part: any) => (typeof part?.text === "string" ? part.text : ""))
        .join("")
        .trim();
      if (collected) {
        return collected;
      }
    }
    if (typeof outputEntry?.text === "string" && outputEntry.text.trim()) {
      return outputEntry.text.trim();
    }
  }

  return "";
}

function parseChatCompletion(json: any): string {
  const choice = Array.isArray(json?.choices) ? json.choices[0] : undefined;
  const completion =
    choice?.message?.content ??
    (typeof choice?.text === "string" ? choice.text : undefined) ??
    (Array.isArray(choice?.message?.content)
      ? choice.message.content
          .filter((part: any) => typeof part?.text === "string")
          .map((part: any) => part.text)
          .join("")
      : undefined);

  if (typeof completion === "string" && completion.trim()) {
    return completion.trim();
  }

  return "";
}

export async function callLLM(
  prompt: string,
  context: string,
  mode: string | undefined,
  model: string,
  env: Env
): Promise<{ structuredPrompt: string; usage?: number }> {
  let config = resolveRuntimeConfig(env);
  const systemPrompt = buildSystemPrompt(mode);

  let attempt = 0;
  let backoffMs = INITIAL_BACKOFF_MS;
  let response: Response | null = null;
  let usedFallback = false;

  while (attempt <= MAX_OPENAI_RETRIES) {
    const attemptTimeoutMs = config.timeoutMs + attempt * config.timeoutStepMs;
    const controller = new AbortController();
    const timeout = setTimeout(() => controller.abort(), attemptTimeoutMs);

    const requestPayload =
      config.apiType === "responses"
        ? buildResponsesPayload(model, systemPrompt, prompt, context)
        : buildChatPayload(model, systemPrompt, prompt, context);

    try {
      const headers: Record<string, string> = { "content-type": "application/json" };
      if (config.apiKey) {
        headers.Authorization = `Bearer ${config.apiKey}`;
      }

      response = await fetch(config.endpoint, {
        method: "POST",
        headers,
        body: JSON.stringify(requestPayload),
        signal: controller.signal
      });
    } catch (networkError) {
      clearTimeout(timeout);
      const isAbortError = networkError instanceof Error && networkError.name === "AbortError";
      const status = isAbortError ? 408 : 0;
      const message = isAbortError
        ? `LLM request timed out after ${attemptTimeoutMs}ms`
        : networkError instanceof Error
        ? networkError.message
        : "Network error";
      if (attempt < MAX_OPENAI_RETRIES && shouldRetry(status)) {
        const delay = Math.min(backoffMs, MAX_BACKOFF_MS) + Math.random() * 150;
        await new Promise((resolve) => setTimeout(resolve, delay));
        backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
        attempt += 1;
        continue;
      }
      if (shouldFallbackToOpenAI(config, env, usedFallback)) {
        usedFallback = true;
        attempt = 0;
        backoffMs = INITIAL_BACKOFF_MS;
        config = {
          ...config,
          endpoint: OPENAI_RESPONSES_ENDPOINT,
          apiKey: env.OPENAI_API_KEY,
          apiType: "responses"
        };
        continue;
      }
      throw new LLMRequestError(status, message, message);
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
      await new Promise((resolve) => setTimeout(resolve, Math.min(delay + Math.random() * 200, MAX_BACKOFF_MS)));
      backoffMs = Math.min(backoffMs * 2, MAX_BACKOFF_MS);
      attempt += 1;
      continue;
    }

    if (shouldFallbackToOpenAI(config, env, usedFallback)) {
      usedFallback = true;
      attempt = 0;
      backoffMs = INITIAL_BACKOFF_MS;
      config = {
        ...config,
        endpoint: OPENAI_RESPONSES_ENDPOINT,
        apiKey: env.OPENAI_API_KEY,
        apiType: "responses"
      };
      continue;
    }

    throw new LLMRequestError(response.status, errorText);
  }

  if (!response) {
    throw new LLMRequestError(500, "No response from language model");
  }

  const json = await response.json();
  const completion =
    config.apiType === "responses" ? parseResponsesCompletion(json) : parseChatCompletion(json);

  if (!completion) {
    const snippet = JSON.stringify(json).slice(0, 400);
    throw new Error(`Language model response missing message content (snippet: ${snippet})`);
  }

  let usage: number | undefined;
  if (typeof json?.usage?.total_tokens === "number") {
    usage = json.usage.total_tokens;
  } else if (
    typeof json?.usage?.prompt_tokens === "number" &&
    typeof json?.usage?.completion_tokens === "number"
  ) {
    usage = json.usage.prompt_tokens + json.usage.completion_tokens;
  }

  return {
    structuredPrompt: completion,
    usage
  };
}

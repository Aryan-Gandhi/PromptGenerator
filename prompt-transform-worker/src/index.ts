import { DEBUG_PREFIX, DEFAULT_MODEL, RETRYABLE_STATUS } from "./constants";
import {
  buildCacheKey,
  readCachedTransform,
  writeCachedTransform
} from "./cache";
import {
  parseAllowedOrigins,
  resolveCors,
  jsonResponse,
  handleOptions
} from "./cors";
import { callLLM, LLMRequestError } from "./llm";
import {
  buildMockStructuredPrompt,
  buildSystemPrompt,
  isMockEnabled
} from "./runtime";
import {
  buildHealthPayload,
  recordFailure,
  recordSuccess
} from "./health";
import type { Env, TransformBody } from "./types";

function parseErrorBody(body: string): unknown {
  if (!body) return null;
  try {
    return JSON.parse(body);
  } catch {
    return body;
  }
}

export { buildSystemPrompt, buildMockStructuredPrompt, isMockEnabled };

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
      console.warn(
        DEBUG_PREFIX,
        "blocked request from origin",
        request.headers.get("Origin") ?? "<no-origin>"
      );
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
      recordSuccess();
      return jsonResponse(
        {
          structuredPrompt: mock,
          model,
          usage: { totalTokens: null },
          mocked: true
        },
        {},
        cors
      );
    }

    try {
      const contextSnippet = body.context?.trim() ?? "";
      const cacheKey = await buildCacheKey(rawPrompt, contextSnippet, body.mode, model);
      const cached = await readCachedTransform(cacheKey);
      if (cached) {
        recordSuccess();
        return jsonResponse(
          {
            structuredPrompt: cached.structuredPrompt,
            model: cached.model ?? model,
            usage: { totalTokens: cached.usage ?? null },
            cached: true,
            contextIncluded: !!contextSnippet
          },
          {},
          cors
        );
      }

      const result = await callLLM(rawPrompt, contextSnippet, body.mode, model, env);
      await writeCachedTransform(cacheKey, {
        structuredPrompt: result.structuredPrompt,
        model,
        usage: result.usage ?? null,
        cachedAt: Date.now(),
        conversationId: body.conversationId ?? null
      });
      recordSuccess();
      return jsonResponse(
        {
          structuredPrompt: result.structuredPrompt,
          model,
          usage: { totalTokens: result.usage ?? null },
          contextIncluded: !!contextSnippet
        },
        {},
        cors
      );
    } catch (error) {
      let status = 502;
      let message = "Unexpected error";
      let details: unknown = null;
      let retryable = false;

      if (error instanceof LLMRequestError) {
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
        retryable = status === 0 || RETRYABLE_STATUS.has(status);
      } else if (error instanceof Error) {
        message = error.message || message;
      }

      recordFailure(message, status);

      const responsePayload: Record<string, unknown> = {
        error: message,
        status,
        retryable
      };

      if (details && typeof details === "object") {
        responsePayload.details = details;
      }

      return jsonResponse(responsePayload, { status }, cors);
    }
  }
};

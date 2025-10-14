import { NO_ORIGIN_TOKEN } from "./constants";
import type { CorsResolution, Env } from "./types";

export function parseAllowedOrigins(env: Env): Set<string> {
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

export function resolveCors(origin: string | null, allowedOrigins: Set<string>): CorsResolution {
  if (allowedOrigins.size === 0) {
    return { allowed: false, originHeader: null, vary: true };
  }

  if (allowedOrigins.has("*")) {
    return { allowed: true, originHeader: origin ?? "*", vary: true };
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

export function withCorsHeaders(origin: string | null, init: ResponseInit = {}, vary = true): ResponseInit {
  const headers = new Headers(init.headers);
  if (origin) {
    headers.set("Access-Control-Allow-Origin", origin);
  }
  headers.set(
    "Access-Control-Allow-Headers",
    "content-type, authorization, x-promptgear-signature, x-promptgear-timestamp, x-promptgear-client"
  );
  headers.set("Access-Control-Allow-Methods", "POST, OPTIONS");
  if (vary) {
    headers.append("Vary", "Origin");
  }
  return { ...init, headers };
}

export function jsonResponse(body: unknown, init: ResponseInit = {}, cors?: CorsResolution): Response {
  const responseInit = withCorsHeaders(cors?.originHeader ?? null, init, cors?.vary ?? true);
  const headers = new Headers(responseInit.headers);
  headers.set("content-type", "application/json");
  return new Response(JSON.stringify(body), { ...responseInit, headers });
}

export function handleOptions(cors: CorsResolution): Response {
  if (!cors.allowed) {
    return new Response(null, { status: 403 });
  }
  return new Response(null, withCorsHeaders(cors.originHeader, { status: 204 }, cors.vary));
}

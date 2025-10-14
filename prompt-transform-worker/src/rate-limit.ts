import {
  RATE_LIMIT_DEFAULT_MAX,
  RATE_LIMIT_DEFAULT_WINDOW_SECONDS,
  DEBUG_PREFIX
} from "./constants";
import type { Env } from "./types";

type Bucket = { windowStart: number; count: number };

const buckets = new Map<string, Bucket>();

export function checkRateLimit(clientId: string, env: Env): boolean {
  const maxRequests = Math.max(
    1,
    Number(env.RATE_LIMIT_MAX_REQUESTS ?? RATE_LIMIT_DEFAULT_MAX)
  );
  const windowSeconds = Math.max(
    1,
    Number(env.RATE_LIMIT_WINDOW_SECONDS ?? RATE_LIMIT_DEFAULT_WINDOW_SECONDS)
  );
  const windowMs = windowSeconds * 1000;
  const now = Date.now();

  const bucket = buckets.get(clientId);
  if (!bucket) {
    buckets.set(clientId, { windowStart: now, count: 1 });
    return true;
  }

  if (now - bucket.windowStart > windowMs) {
    buckets.set(clientId, { windowStart: now, count: 1 });
    return true;
  }

  if (bucket.count >= maxRequests) {
    return false;
  }

  bucket.count += 1;
  return true;
}

export function logRateLimitRejection(clientId: string): void {
  console.warn(DEBUG_PREFIX, "rate limit exceeded for client", clientId);
}

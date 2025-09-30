import { CACHE_CACHE_KEY_PREFIX, CACHE_TTL_SECONDS } from "./constants";
import type { CachedTransformRecord } from "./types";

const encoder = new TextEncoder();

export async function buildCacheKey(
  prompt: string,
  context: string,
  mode: string | undefined,
  model: string
): Promise<string> {
  const raw = JSON.stringify({ prompt, context, mode: mode ?? null, model });
  const digest = await crypto.subtle.digest("SHA-256", encoder.encode(raw));
  return Array.from(new Uint8Array(digest))
    .map((byte) => byte.toString(16).padStart(2, "0"))
    .join("");
}

function cacheRequestForKey(key: string): Request {
  return new Request(`${CACHE_CACHE_KEY_PREFIX}${key}`, { method: "GET" });
}

export async function readCachedTransform(key: string): Promise<CachedTransformRecord | null> {
  try {
    const match = await caches.default.match(cacheRequestForKey(key));
    if (!match) return null;
    const data = (await match.json()) as CachedTransformRecord;
    if (!data || typeof data.structuredPrompt !== "string") return null;
    return data;
  } catch (error) {
    console.warn("Prompt Transform Worker: failed to read cache", error);
    return null;
  }
}

export async function writeCachedTransform(key: string, record: CachedTransformRecord): Promise<void> {
  try {
    const response = new Response(JSON.stringify(record), {
      headers: {
        "cache-control": `max-age=${CACHE_TTL_SECONDS}`,
        "content-type": "application/json"
      }
    });
    await caches.default.put(cacheRequestForKey(key), response);
  } catch (error) {
    console.warn("Prompt Transform Worker: failed to write cache", error);
  }
}

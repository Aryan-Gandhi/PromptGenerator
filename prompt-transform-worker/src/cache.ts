import {
  CACHE_CACHE_KEY_PREFIX,
  CACHE_TTL_SECONDS,
  CACHE_IV_LENGTH
} from "./constants";
import type { CachedTransformRecord, Env } from "./types";

const encoder = new TextEncoder();
const decoder = new TextDecoder();

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const len = binary.length;
  const bytes = new Uint8Array(len);
  for (let i = 0; i < len; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

function uint8ArrayToBase64(bytes: Uint8Array): string {
  let binary = "";
  for (let i = 0; i < bytes.byteLength; i += 1) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function getEncryptionKey(env: Env): Promise<CryptoKey | null> {
  const secret = env.CACHE_ENCRYPTION_KEY;
  if (!secret) {
    return null;
  }
  try {
    const rawKey = base64ToUint8Array(secret);
    return crypto.subtle.importKey(
      "raw",
      rawKey,
      { name: "AES-GCM", length: 256 },
      false,
      ["encrypt", "decrypt"]
    );
  } catch (error) {
    console.warn("Prompt Transform Worker: invalid CACHE_ENCRYPTION_KEY", error);
    return null;
  }
}

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

export async function readCachedTransform(env: Env, key: string): Promise<CachedTransformRecord | null> {
  try {
    const match = await caches.default.match(cacheRequestForKey(key));
    if (!match) return null;
    const payload = (await match.json()) as { ciphertext?: string; iv?: string };
    if (!payload?.ciphertext || !payload.iv) {
      return null;
    }

    const cryptoKey = await getEncryptionKey(env);
    if (!cryptoKey) {
      return null;
    }

    const iv = base64ToUint8Array(payload.iv);
    const ciphertext = base64ToUint8Array(payload.ciphertext);
    const decrypted = await crypto.subtle.decrypt({ name: "AES-GCM", iv }, cryptoKey, ciphertext);
    const json = JSON.parse(decoder.decode(decrypted)) as CachedTransformRecord;
    if (!json || typeof json.structuredPrompt !== "string") {
      return null;
    }
    return json;
  } catch (error) {
    console.warn("Prompt Transform Worker: failed to read cache", error);
    return null;
  }
}

export async function writeCachedTransform(
  env: Env,
  key: string,
  record: CachedTransformRecord
): Promise<void> {
  try {
    const cryptoKey = await getEncryptionKey(env);
    if (!cryptoKey) {
      return;
    }
    const iv = crypto.getRandomValues(new Uint8Array(CACHE_IV_LENGTH));
    const ciphertext = await crypto.subtle.encrypt(
      { name: "AES-GCM", iv },
      cryptoKey,
      encoder.encode(JSON.stringify(record))
    );
    const payload = {
      iv: uint8ArrayToBase64(iv),
      ciphertext: uint8ArrayToBase64(new Uint8Array(ciphertext))
    };

    const encryptedResponse = new Response(JSON.stringify(payload), {
      headers: {
        "cache-control": `max-age=${CACHE_TTL_SECONDS}`,
        "content-type": "application/json"
      }
    });
    await caches.default.put(cacheRequestForKey(key), encryptedResponse);
  } catch (error) {
    console.warn("Prompt Transform Worker: failed to write cache", error);
  }
}

import { SIGNATURE_TTL_MS, DEBUG_PREFIX } from "./constants";
import type { Env } from "./types";

const encoder = new TextEncoder();

export class AuthenticationError extends Error {
  status: number;

  constructor(status: number, message: string) {
    super(message);
    this.status = status;
  }
}

function timingSafeEqual(a: Uint8Array, b: Uint8Array): boolean {
  if (a.length !== b.length) {
    return false;
  }
  let result = 0;
  for (let i = 0; i < a.length; i += 1) {
    result |= a[i] ^ b[i];
  }
  return result === 0;
}

function base64ToUint8Array(base64: string): Uint8Array {
  const binary = atob(base64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i += 1) {
    bytes[i] = binary.charCodeAt(i);
  }
  return bytes;
}

export async function authenticateRequest(
  request: Request,
  env: Env,
  bodyText: string
): Promise<{ clientId: string }> {
  const secret = env.SIGNING_SECRET;
  if (!secret) {
    console.error(DEBUG_PREFIX, "SIGNING_SECRET is not configured");
    throw new AuthenticationError(500, "Server misconfiguration");
  }

  const signatureHeader = request.headers.get("X-Promptgear-Signature");
  const timestampHeader = request.headers.get("X-Promptgear-Timestamp");
  const clientId = request.headers.get("X-Promptgear-Client") ?? "anonymous";

  if (!signatureHeader || !timestampHeader) {
    throw new AuthenticationError(401, "Missing authentication headers");
  }

  const timestampNumeric = Number(timestampHeader);
  if (!Number.isFinite(timestampNumeric)) {
    throw new AuthenticationError(401, "Invalid signature timestamp");
  }

  const freshness = Math.abs(Date.now() - timestampNumeric);
  if (freshness > SIGNATURE_TTL_MS) {
    throw new AuthenticationError(401, "Signature expired");
  }

  const key = await crypto.subtle.importKey(
    "raw",
    encoder.encode(secret),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign"]
  );

  const expectedBuffer = await crypto.subtle.sign(
    "HMAC",
    key,
    encoder.encode(`${timestampHeader}.${bodyText}`)
  );
  const expectedBytes = new Uint8Array(expectedBuffer);
  let receivedBytes: Uint8Array;

  try {
    receivedBytes = base64ToUint8Array(signatureHeader);
  } catch {
    throw new AuthenticationError(401, "Invalid signature encoding");
  }

  if (!timingSafeEqual(expectedBytes, receivedBytes)) {
    throw new AuthenticationError(401, "Signature mismatch");
  }

  return { clientId };
}

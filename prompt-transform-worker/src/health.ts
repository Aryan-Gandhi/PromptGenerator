import { DEBUG_PREFIX } from "./constants";
import { isMockEnabled } from "./runtime";
import type { Env } from "./types";

let lastSuccessfulTransform: number | null = null;
let lastErrorRecord: { timestamp: number; message: string; status?: number } | null = null;

export function recordSuccess(): void {
  lastSuccessfulTransform = Date.now();
  lastErrorRecord = null;
}

export function recordFailure(message: string, status?: number): void {
  lastErrorRecord = {
    timestamp: Date.now(),
    message,
    status
  };
  console.error(DEBUG_PREFIX, message);
}

export function buildHealthPayload(env: Env): { payload: Record<string, unknown>; status: number } {
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

export function getLastErrorRecord() {
  return lastErrorRecord;
}

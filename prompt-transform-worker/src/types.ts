export interface Env {
  OPENAI_API_KEY?: string;
  DEFAULT_MODEL?: string;
  MOCK_TRANSFORM?: string;
  ALLOWED_ORIGINS?: string;
  LLM_ENDPOINT?: string;
  LLM_API_KEY?: string;
  SIGNING_SECRET?: string;
  CACHE_ENCRYPTION_KEY?: string;
  RATE_LIMIT_MAX_REQUESTS?: string;
  RATE_LIMIT_WINDOW_SECONDS?: string;
}

export type TransformBody = {
  prompt?: string;
  mode?: string;
  model?: string;
  context?: string;
  conversationId?: string | null;
  skipCache?: boolean;
};

export type CachedTransformRecord = {
  structuredPrompt: string;
  model: string;
  usage?: number | null;
  mocked?: boolean;
  cachedAt: number;
  conversationId?: string | null;
};

export type RuntimeConfig = {
  endpoint: string;
  apiKey?: string;
  timeoutMs: number;
  timeoutStepMs: number;
  apiType: "responses" | "chat";
};

export type CorsResolution = {
  allowed: boolean;
  originHeader: string | null;
  vary: boolean;
};

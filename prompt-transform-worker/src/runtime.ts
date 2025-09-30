import {
  DEFAULT_LLM_ENDPOINT,
  INITIAL_TIMEOUT_MS,
  TIMEOUT_STEP_MS
} from "./constants";
import type { Env, RuntimeConfig } from "./types";

const SYSTEM_PROMPT_BASE = `You are Prompt Structurer—a meta-assistant that tidies raw prompts so the responding model can do focused work.
Review the user’s request carefully and respond with short, plain-text sections.

Role: Choose the most relevant expert identity for the request (keep it specific whenever possible).
Task: Restate the user’s objective in one sentence and mention missing details if they matter.
Context: Highlight key constraints, background, assumptions, audience hints, or timelines from the prompt (2–3 bullets or short sentences).
Reasoning: List the main checks or thought steps the assistant should follow so the answer stays accurate and useful (2–4 bullets).
Stop Conditions: Explain when the assistant should stop (e.g., once goals are met, if more info is required, or when policy/safety issues arise).

Keep the tone practical, avoid inventing facts, and be concise—no extra sections are required.
Never include chain-of-thought markers such as <think>, hidden reasoning, or any narrative.
Always respond using only the Role/Task/Context/Reasoning/Stop Conditions sections, each on its own line.`;

const MODE_HINTS: Record<string, string> = {
  coding: "When crafting sections, emphasize debugging steps, code safety checks, and preferred languages.",
  research: "Prioritize primary sources, methodologies, and clear criteria for evaluating evidence.",
  travel: "Highlight location details, logistics, and user preferences for destinations.",
  writing: "Focus on tone, narrative structure, and revision guidelines to elevate written outputs."
};

const MOCK_ROLE_KEYWORDS: Array<{ role: string; keywords: string[] }> = [
  { role: "neuroscientist", keywords: ["neuro", "brain", "cortex"] },
  { role: "data scientist", keywords: ["data", "model", "analytics"] },
  { role: "software engineer", keywords: ["code", "bug", "script", "refactor"] },
  { role: "cybersecurity analyst", keywords: ["security", "threat", "breach", "malware"] },
  { role: "financial analyst", keywords: ["finance", "investment", "budget", "valuation"] },
  { role: "medical doctor", keywords: ["patient", "symptom", "diagnosis", "treatment"] }
];

export function buildSystemPrompt(mode?: string): string {
  if (!mode) return SYSTEM_PROMPT_BASE;
  const hint = MODE_HINTS[mode.toLowerCase()] ?? `Incorporate requirements relevant to the "${mode}" domain.`;
  return `${SYSTEM_PROMPT_BASE}\nMode guidance: ${hint}`;
}

export function isMockEnabled(env: Env): boolean {
  return env.MOCK_TRANSFORM === "true" || env.OPENAI_API_KEY === "MOCK" || env.LLM_API_KEY === "MOCK";
}

export function resolveRuntimeConfig(env: Env): RuntimeConfig {
  const customEndpoint = (env.LLM_ENDPOINT ?? "").trim();
  const hasCustomEndpoint = customEndpoint.length > 0;
  return {
    endpoint: hasCustomEndpoint ? customEndpoint : DEFAULT_LLM_ENDPOINT,
    apiKey: hasCustomEndpoint ? env.LLM_API_KEY ?? "" : env.OPENAI_API_KEY ?? env.LLM_API_KEY ?? "",
    timeoutMs: INITIAL_TIMEOUT_MS,
    timeoutStepMs: TIMEOUT_STEP_MS
  };
}

export function mockRole(prompt: string): string {
  const lower = prompt.toLowerCase();
  for (const entry of MOCK_ROLE_KEYWORDS) {
    if (entry.keywords.some((keyword) => lower.includes(keyword))) {
      return entry.role;
    }
  }
  const noun = lower.match(/[a-z0-9-]+/g)?.find((token) => token.length > 4) ?? "subject";
  return `${noun} specialist`;
}

export function buildMockStructuredPrompt(prompt: string, mode?: string): string {
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

export function buildUserMessage(prompt: string, context: string): string {
  const contextBlock = context.trim();
  if (!contextBlock) {
    return prompt;
  }
  return `Recent conversation context:\n${contextBlock}\n\nUser request:\n${prompt}`;
}

export function buildChatPayload(model: string, systemPrompt: string, prompt: string, context: string) {
  return {
    model,
    messages: [
      { role: "system", content: systemPrompt },
      { role: "user", content: buildUserMessage(prompt, context) }
    ],
    temperature: 0.15,
    stream: false,
    stop: ["</think>", "<think>"]
  };
}

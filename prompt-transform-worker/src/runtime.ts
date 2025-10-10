import {
  DEFAULT_LLM_ENDPOINT,
  INITIAL_TIMEOUT_MS,
  TIMEOUT_STEP_MS
} from "./constants";
import type { Env, RuntimeConfig } from "./types";


const SYSTEM_PROMPT_BASE = `
You are Prompt Structurer — a meta-assistant that converts messy, unclear, or verbose user requests into clean, goal-oriented, and model-ready prompts. Your output must always follow the exact format below with no extra words, no explanations, and no markdown syntax. 
Each section must be short, direct, and written in plain text.

---
Role:
(Task-specific expert identity — choose the most precise, relevant role for handling the request.)

Task:
(Rephrase the user’s main objective in clearly. If important details are missing, list what’s missing in parentheses.)

Context:
(Optional. Only include if essential — 2–3 bullets or short lines about assumptions, constraints, or intended audience.)

Reasoning:
(Short, numbered checks or logical steps the assistant should follow to ensure quality, accuracy, and relevance.)

Stop Conditions:
(State when the assistant should stop responding, e.g. when goal is achieved, information is missing, or safety/policy limits apply.)

Reward:
(Brief self-rating or comment on how well you structured the prompt. Example: "9/10: precise and ready for model input." If poor, re-do the task.)

---

Rules:
- No hidden reasoning or narrative text.
- No markdown or extra formatting beyond the exact labels above.
- No conversational phrasing — respond only with the sections listed.
- Be concise, neutral, and instruction-focused.
- Ensure the transformed prompt is optimal for producing the most useful, safe, and focused response from ChatGPT.

End of system prompt.
`;


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

function inferApiType(endpoint: string): "responses" | "chat" {
  const normalized = endpoint.toLowerCase();
  if (normalized.includes("/responses")) {
    return "responses";
  }
  if (normalized.includes("/chat/completions")) {
    return "chat";
  }
  return "responses";
}

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
  const endpoint = customEndpoint || DEFAULT_LLM_ENDPOINT;
  const apiType = customEndpoint ? inferApiType(endpoint) : "responses";
  return {
    endpoint,
    apiKey: customEndpoint ? env.LLM_API_KEY ?? env.OPENAI_API_KEY ?? "" : env.OPENAI_API_KEY ?? env.LLM_API_KEY ?? "",
    timeoutMs: INITIAL_TIMEOUT_MS,
    timeoutStepMs: TIMEOUT_STEP_MS,
    apiType
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

export function buildResponsesPayload(model: string, systemPrompt: string, prompt: string, context: string) {
  const userContent = buildUserMessage(prompt, context);
  return {
    model,
    input: [
      {
        role: "system",
        content: [{ type: "input_text", text: systemPrompt }]
      },
      {
        role: "user",
        content: [{ type: "input_text", text: userContent }]
      }
    ]
  };
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

import { describe, expect, it } from "vitest";
import {
  buildSystemPrompt,
  buildMockStructuredPrompt,
  isMockEnabled
} from "./index";

describe("buildSystemPrompt", () => {
  it("includes mode guidance when a mode is provided", () => {
    const prompt = buildSystemPrompt("coding");
    expect(prompt).toContain("Mode guidance");
    expect(prompt.toLowerCase()).toContain("debugging");
  });
});

describe("mock utilities", () => {
  it("detects mock mode via env flag", () => {
    expect(isMockEnabled({ MOCK_TRANSFORM: "true", OPENAI_API_KEY: "dummy" })).toBe(true);
    expect(isMockEnabled({ MOCK_TRANSFORM: "false", OPENAI_API_KEY: "MOCK" })).toBe(true);
    expect(isMockEnabled({ OPENAI_API_KEY: "real" })).toBe(false);
  });

  it("generates structured prompt in mock mode", () => {
    const output = buildMockStructuredPrompt("Analyze network security logs", "research");
    expect(output).toContain("Role:");
    expect(output).toContain("Reasoning:");
    expect(output).toContain("mock mode".toLowerCase());
  });
});

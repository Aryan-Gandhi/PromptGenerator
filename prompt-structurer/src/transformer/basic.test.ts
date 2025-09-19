import { describe, expect, it } from "vitest";
import { basicTransform } from "./basic";

const newline = "\n";

function extractLine(label: string, output: string): string {
  return (
    output
      .split(newline)
      .find((line) => line.startsWith(label)) ?? ""
  );
}

describe("basicTransform", () => {
  it("infers a neuroscience role", () => {
    const prompt = "Explain recent breakthroughs in neuroscience for a graduate-level seminar.";
    const output = basicTransform(prompt);
    const roleLine = extractLine("Role:", output);
    expect(roleLine.toLowerCase()).toContain("neuroscientist");
  });

  it("produces a non-generic role", () => {
    const prompt = "Outline strategies to restore coral reef ecosystems in remote islands.";
    const output = basicTransform(prompt);
    const roleLine = extractLine("Role:", output);
    expect(roleLine).not.toContain("subject-matter expert");
  });

  it("adds reasoning bullet points", () => {
    const prompt = "Compare two project management methodologies and flag compliance risks.";
    const output = basicTransform(prompt);
    const reasoningSection = output
      .split("Reasoning:")
      .pop() ?? "";
    expect(reasoningSection.split("-").length).toBeGreaterThan(2);
  });
});

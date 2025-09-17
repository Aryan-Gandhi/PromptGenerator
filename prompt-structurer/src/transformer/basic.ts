export function basicTransform(raw: string) {
  const t = (raw || "").trim();
  if (!t) return "";
  return [
    "Role: Act as a helpful expert relevant to this request.",
    `Task: ${t}`,
    "Context: Be clear, concise, and avoid hallucinations.",
    "Output Format: Use bullets or a compact table if appropriate.",
    "Stop Conditions: Finish when the request is fully satisfied."
  ].join("\n");
}

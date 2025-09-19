const ROLE_KEYWORDS: Array<{ role: string; keywords: string[] }> = [
  { role: "neuroscientist", keywords: ["neuroscience", "neuron", "brain", "cortex", "synapse"] },
  { role: "molecular biologist", keywords: ["genetics", "protein", "dna", "rna", "enzyme", "molecule"] },
  { role: "medical doctor", keywords: ["patient", "diagnosis", "symptom", "treatment", "medicine", "clinical"] },
  { role: "cybersecurity analyst", keywords: ["cyber", "malware", "phishing", "threat", "breach", "penetration"] },
  { role: "software engineer", keywords: ["code", "bug", "algorithm", "api", "refactor", "software", "program"] },
  { role: "data scientist", keywords: ["dataset", "model", "statistics", "prediction", "machine learning", "analytics"] },
  { role: "financial analyst", keywords: ["investment", "finance", "portfolio", "valuation", "budget"] },
  { role: "marketing strategist", keywords: ["campaign", "marketing", "brand", "audience", "seo", "engagement"] },
  { role: "product manager", keywords: ["roadmap", "feature", "user story", "backlog", "product"] },
  { role: "project manager", keywords: ["timeline", "deliverable", "milestone", "project", "stakeholder"] },
  { role: "travel planner", keywords: ["itinerary", "trip", "travel", "vacation", "flights"] },
  { role: "legal advisor", keywords: ["contract", "legal", "compliance", "regulation", "law"] },
  { role: "environmental scientist", keywords: ["climate", "sustainability", "ecosystem", "environment", "emissions"] },
  { role: "educational curriculum designer", keywords: ["lesson", "curriculum", "students", "classroom", "teaching"] },
  { role: "UX researcher", keywords: ["usability", "user research", "interview", "prototype", "ux"] },
  { role: "operations manager", keywords: ["process", "efficiency", "supply chain", "operations", "workflow"] },
  { role: "copywriter", keywords: ["copy", "headline", "tagline", "writing", "blog", "article"] },
  { role: "historian", keywords: ["history", "historical", "era", "century", "ancient"] },
  { role: "statistician", keywords: ["sample", "confidence", "regression", "variance", "probability"] }
];

const STOP_WORDS = new Set([
  "the",
  "a",
  "an",
  "and",
  "or",
  "but",
  "about",
  "into",
  "with",
  "for",
  "from",
  "that",
  "this",
  "those",
  "these",
  "their",
  "your",
  "what",
  "which",
  "when",
  "where",
  "who",
  "whom",
  "how",
  "why",
  "please",
  "help",
  "need",
  "want",
  "make",
  "create"
]);


function tokenize(text: string): string[] {
  return text.toLowerCase().match(/[a-z0-9-]+/g)?.filter(Boolean) ?? [];
}

function inferRole(text: string): string {
  const lower = text.toLowerCase();
  for (const { role, keywords } of ROLE_KEYWORDS) {
    if (keywords.some((keyword) => lower.includes(keyword))) {
      return role;
    }
  }

  const tokens = tokenize(text).filter((token) => !STOP_WORDS.has(token));
  if (tokens.length >= 2) {
    return `${tokens[0]} ${tokens[1]} specialist`.trim();
  }
  if (tokens.length === 1) {
    return `${tokens[0]} expert`;
  }
  return "subject-matter expert focusing on the user’s request";
}

function extractTopic(tokens: string[]): string | null {
  const filtered = tokens.filter((token) => !STOP_WORDS.has(token));
  if (filtered.length === 0) return null;
  return filtered.slice(0, 3).join(" ");
}

function detectAudience(text: string): string | null {
  if (/kids|children|students|classroom/i.test(text)) return "Target audience: younger learners.";
  if (/executive|board|stakeholder|c-level|c suite/i.test(text)) return "Target audience: executive stakeholders.";
  if (/beginner|novice|non-technical/i.test(text)) return "Audience requires non-technical explanations.";
  if (/advanced|experts|researchers/i.test(text)) return "Audience expects advanced technical detail.";
  return null;
}

function detectDeadline(text: string): string | null {
  const withinMatch = text.match(/within \d+\s*(hours?|days?|weeks?)/i);
  if (withinMatch) return `Turnaround expectation: ${withinMatch[0]}.`;
  const byMatch = text.match(/by\s+(\w+\s+\d{1,2}(st|nd|rd|th)?|tomorrow|today|next week|end of (day|week|month))/i);
  if (byMatch) return `Deadline: ${byMatch[0]}.`;
  return null;
}

function detectResearchNeed(text: string): boolean {
  return /(research|analy[sz]e|compare|evaluate|investigate|review)/i.test(text);
}

function detectRisks(text: string): boolean {
  return /(risk|safety|compliance|regulation|legal|ethic)/i.test(text);
}

function buildReasoningSteps(text: string, topic: string | null): string[] {
  const steps: string[] = [];
  if (detectResearchNeed(text)) {
    steps.push("Gather relevant evidence, cite sources when possible, and note any assumptions.");
  }
  if (detectRisks(text)) {
    steps.push("Identify potential risks or compliance issues and recommend mitigations.");
  }
  if (/compare|versus|vs\.?/i.test(text)) {
    steps.push("Compare alternatives against objective criteria before recommending a direction.");
  }
  if (/calculate|estimate|forecast|model/i.test(text)) {
    steps.push("Double-check calculations and explain formulas or models used.");
  }
  if (steps.length < 2) {
    steps.push("Clarify any ambiguous requirements before delivering the final answer.");
  }
  if (steps.length < 3) {
    steps.push(
      topic
        ? `Ensure the final recommendations stay tightly aligned with the ${topic} focus.`
        : "Ensure the final recommendations stay tightly aligned with the user’s stated goal."
    );
  }
  return steps.slice(0, 4);
}

export function basicTransform(raw: string) {
  const cleaned = (raw || "").trim();
  if (!cleaned) return "";

  const tokens = tokenize(cleaned);
  const role = inferRole(cleaned);
  const topic = extractTopic(tokens);
  const audience = detectAudience(cleaned);
  const deadline = detectDeadline(cleaned);
  const reasoning = buildReasoningSteps(cleaned, topic);

  const context: string[] = [];
  if (topic) context.push(`Primary topic: ${topic}.`);
  if (audience) context.push(audience);
  if (deadline) context.push(deadline);
  if (!context.length) {
    context.push("Clarify scope, success metrics, and any missing constraints before responding.");
  }

  const stopConditions = [
    "Stop once every requested deliverable has been produced.",
    "If critical information is missing, pause and request clarification before proceeding.",
    "Do not introduce unsupported claims—flag uncertainties explicitly."
  ];

  return [
    `Role: ${role}.`,
    `Task: ${cleaned}`,
    `Context:\n- ${context.join("\n- ")}`,
    `Reasoning:\n- ${reasoning.join("\n- ")}`,
    `Stop Conditions:\n- ${stopConditions.join("\n- ")}`
  ].join("\n");
}

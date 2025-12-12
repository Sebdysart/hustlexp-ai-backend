import { routeModel } from "./router";

export type ComposeTaskRequest = {
  prompt: string;
  category?: string;
  budget?: number;
};

export type ComposeTaskResponse = {
  title: string;
  description: string;
  suggestedPrice: number;
  suggestedXP: number;
  category: string;
  tags: string[];
};

const CATEGORY_KEYWORDS: Record<string, string[]> = {
  delivery: ["deliver", "pickup", "drop", "parcel", "package"],
  cleaning: ["clean", "tidy", "organize", "vacuum"],
  moving: ["move", "carry", "haul", "lift", "transport"],
  assembly: ["assemble", "build", "install", "setup"],
  tech: ["fix", "computer", "laptop", "tech", "wifi", "network"],
  tutoring: ["tutor", "teach", "lesson", "study"],
  pet_care: ["pet", "dog", "cat", "walk", "groom"],
  errands: ["errand", "shop", "grocery", "pickup"],
};

const CATEGORY_FALLBACK_ORDER: string[] = [
  "delivery",
  "cleaning",
  "moving",
  "assembly",
  "tech",
  "tutoring",
  "pet_care",
  "errands",
];

const sanitizeJson = (text: string): string => {
  return text
    .replace(/```json/gi, "")
    .replace(/```/g, "")
    .trim();
};

const deriveCategory = (prompt: string, preferred?: string): string => {
  if (preferred && preferred.trim()) {
    return preferred.trim().toLowerCase();
  }

  const lowerPrompt = prompt.toLowerCase();

  for (const [category, keywords] of Object.entries(CATEGORY_KEYWORDS)) {
    if (keywords.some((keyword) => lowerPrompt.includes(keyword))) {
      return category;
    }
  }

  return "errands";
};

const deriveTags = (prompt: string): string[] => {
  return Array.from(
    new Set(
      prompt
        .toLowerCase()
        .replace(/[^a-z0-9\s]/g, "")
        .split(/\s+/)
        .filter((word) => word.length > 3)
        .slice(0, 5)
    )
  );
};

const buildFallbackResponse = (request: ComposeTaskRequest): ComposeTaskResponse => {
  const category = deriveCategory(request.prompt, request.category);
  const title = request.prompt.length > 60 ? `${request.prompt.slice(0, 57)}...` : request.prompt;
  const budget = typeof request.budget === "number" && Number.isFinite(request.budget)
    ? Math.max(15, Math.min(500, Math.round(request.budget)))
    : 40;

  return {
    title: title || "Task Request",
    description: `${request.prompt.trim()}. Include any access details, timing, and special instructions for the HustleXP hero helping you.`,
    suggestedPrice: budget,
    suggestedXP: budget * 10,
    category,
    tags: deriveTags(request.prompt),
  };
};

export async function composeTaskWithAI(request: ComposeTaskRequest): Promise<ComposeTaskResponse> {
  console.log("[AI Compose] Generating task for prompt", request.prompt.slice(0, 60));

  try {
    const hintCategory = request.category ?? deriveCategory(request.prompt);
    const prompt = `You are HustleXP AI Task Composer.
Generate a JSON object describing a single task based strictly on the user input and HustleXP categories.
Use this JSON schema: {
  "title": string (<= 80 chars),
  "description": string (concise but actionable <= 280 chars),
  "suggestedPrice": number (USD, whole number between 15 and 500),
  "suggestedXP": number (Price * 10 rounding to nearest 5),
  "category": one of ${CATEGORY_FALLBACK_ORDER.join(", ")},
  "tags": string[] (up to 5 concise lowercase keywords)
}

Constraints:
- Stay within HustleXP context (local, real-world tasks)
- Respect provided budget if present; otherwise pick a fair market price
- Ensure description mentions deliverables, timing, and expectations
- Never invent platform policies or discuss anything outside HustleXP

User prompt: "${request.prompt}"
Preferred category: ${hintCategory}
Preferred budget: ${request.budget ?? "not provided"}`;

    const response = await routeModel("reason", prompt);
    const cleaned = sanitizeJson(response.text);
    const parsed = JSON.parse(cleaned);

    const category = CATEGORY_FALLBACK_ORDER.includes((parsed.category || "").toLowerCase())
      ? parsed.category.toLowerCase()
      : deriveCategory(request.prompt, request.category);

    const suggestedPrice = typeof parsed.suggestedPrice === "number" && Number.isFinite(parsed.suggestedPrice)
      ? Math.max(15, Math.min(500, Math.round(parsed.suggestedPrice)))
      : buildFallbackResponse(request).suggestedPrice;

    const suggestedXP = typeof parsed.suggestedXP === "number" && Number.isFinite(parsed.suggestedXP)
      ? Math.max(50, Math.min(5000, Math.round(parsed.suggestedXP / 5) * 5))
      : suggestedPrice * 10;

    const tags = Array.isArray(parsed.tags)
      ? parsed.tags.map((tag: unknown) => (typeof tag === "string" ? tag.toLowerCase() : "")).filter(Boolean).slice(0, 5)
      : deriveTags(request.prompt);

    return {
      title: (parsed.title || request.prompt).slice(0, 80),
      description: (parsed.description || request.prompt).slice(0, 320),
      suggestedPrice,
      suggestedXP,
      category,
      tags,
    };
  } catch (error) {
    console.error("[AI Compose] Failed to use model, falling back", error);
    return buildFallbackResponse(request);
  }
}

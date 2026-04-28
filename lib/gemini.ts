// Thin Gemini Flash wrapper for text-only generation. Mirrors the
// image-based call shape in app/api/trades/parse-screenshot/route.ts
// so the auth and config pattern stays consistent across the app.

const GEMINI_MODEL = "gemini-2.5-flash";
const GEMINI_URL = `https://generativelanguage.googleapis.com/v1beta/models/${GEMINI_MODEL}:generateContent`;

type GeminiResponse = {
  candidates?: Array<{
    content?: { parts?: Array<{ text?: string }> };
  }>;
};

export async function geminiSummarize(
  prompt: string,
  opts?: { maxTokens?: number; temperature?: number; label?: string },
): Promise<string | null> {
  const key = process.env.GEMINI_API_KEY ?? "";
  const label = opts?.label ?? "gemini";
  if (!key) {
    console.warn(`[${label}] GEMINI_API_KEY not set`);
    return null;
  }
  let res: Response;
  try {
    res = await fetch(GEMINI_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        "x-goog-api-key": key,
      },
      body: JSON.stringify({
        contents: [{ parts: [{ text: prompt }] }],
        generationConfig: {
          temperature: opts?.temperature ?? 0.2,
          maxOutputTokens: opts?.maxTokens ?? 1024,
          // 2.5 Flash is a thinking model; thinking burns budget for
          // summarization without improving output quality.
          thinkingConfig: { thinkingBudget: 0 },
        },
      }),
      cache: "no-store",
    });
  } catch (e) {
    console.warn(
      `[${label}] network error: ${e instanceof Error ? e.message : e}`,
    );
    return null;
  }
  if (!res.ok) {
    const errText = await res.text().catch(() => "");
    console.warn(`[${label}] HTTP ${res.status}: ${errText.slice(0, 300)}`);
    return null;
  }
  let json: GeminiResponse;
  try {
    json = (await res.json()) as GeminiResponse;
  } catch {
    return null;
  }
  return json.candidates?.[0]?.content?.parts?.[0]?.text ?? null;
}

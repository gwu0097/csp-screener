// Small shared text helpers for LLM-generated prose.

// Strip Perplexity citation markers like [1], [2][3] from analysis text.
export function stripCitations(text: string): string {
  return text.replace(/\[\d+\]/g, "").replace(/[ \t]{2,}/g, " ").trim();
}

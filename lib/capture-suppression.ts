// Persisted, cross-run suppression list for symbols that fail Schwab
// chain fetches PERMANENTLY (400s — bad/delisted symbols), not
// transiently. A single permanent failure doesn't suppress — one bad
// day isn't proof a symbol is dead, and the threshold protects against
// a genuine one-off misclassification. Two permanent failures does.
// Local-only JSON file, human-editable if a symbol needs to be manually
// un-suppressed later (e.g. a ticker gets re-listed).
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { resolve } from "node:path";
import { homedir } from "node:os";

const FILE_PATH = resolve(
  homedir(),
  "Library/Application Support/csp-screener/capture-suppression.json",
);
const THRESHOLD = 2;

export type SuppressionEntry = {
  permanentFailures: number;
  suppressed: boolean;
  lastError: string;
  lastFailedAt: string;
  suppressedAt: string | null;
};

type SuppressionFile = Record<string, SuppressionEntry>;

function load(): SuppressionFile {
  if (!existsSync(FILE_PATH)) return {};
  try {
    return JSON.parse(readFileSync(FILE_PATH, "utf8")) as SuppressionFile;
  } catch {
    return {};
  }
}

function save(data: SuppressionFile): void {
  const dir = resolve(FILE_PATH, "..");
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true });
  writeFileSync(FILE_PATH, JSON.stringify(data, null, 2));
}

export function isSuppressed(symbol: string): boolean {
  return load()[symbol]?.suppressed === true;
}

export function recordPermanentFailure(symbol: string, errorMessage: string): SuppressionEntry {
  const data = load();
  const now = new Date().toISOString();
  const entry: SuppressionEntry = data[symbol] ?? {
    permanentFailures: 0,
    suppressed: false,
    lastError: "",
    lastFailedAt: "",
    suppressedAt: null,
  };
  entry.permanentFailures += 1;
  entry.lastError = errorMessage;
  entry.lastFailedAt = now;
  if (!entry.suppressed && entry.permanentFailures >= THRESHOLD) {
    entry.suppressed = true;
    entry.suppressedAt = now;
  }
  data[symbol] = entry;
  save(data);
  return entry;
}

export function getSuppressionList(): SuppressionFile {
  return load();
}

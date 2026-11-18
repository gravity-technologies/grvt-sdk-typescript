// GRVT_LOG=debug (or info/warn/error) logs to stderr (console.error). Wire logs are always redacted:
// the gravity cookie, api keys, private keys, signature r/s and any 32-byte hex value.

const LEVELS = { debug: 10, info: 20, warn: 30, error: 40, off: 100 } as const;
type Level = keyof typeof LEVELS;

function envLevel(): number {
  const raw = (globalThis as { process?: { env?: Record<string, string | undefined> } }).process
    ?.env?.GRVT_LOG;
  if (!raw) return LEVELS.warn;
  return LEVELS[raw.toLowerCase() as Level] ?? LEVELS.info;
}

let level = envLevel();

/** Override GRVT_LOG at runtime ("debug", "info", "warn", "error", "off"). */
export function setLogLevel(l: Level): void {
  level = LEVELS[l];
}

export function debugEnabled(): boolean {
  return level <= LEVELS.debug;
}

export function logDebug(msg: string): void {
  if (level <= LEVELS.debug) console.error(`grvt DEBUG ${msg}`);
}

export function logWarn(msg: string): void {
  if (level <= LEVELS.warn) console.error(`grvt WARN ${msg}`);
}

export function logError(msg: string, e?: unknown): void {
  if (level <= LEVELS.error) console.error(`grvt ERROR ${msg}`, e ?? "");
}

const SECRET_KEYS = ["api_key", "private_key", "r", "s", "gravity", "cookie"];
const secretValue = new RegExp(`"(${SECRET_KEYS.join("|")})"(\\s*:\\s*)"[^"]*"`, "gi");

/** Header values that are secrets. */
export function redactHeader(name: string, value: string): string {
  const n = name.toLowerCase();
  return n === "cookie" || n === "set-cookie" || n === "authorization" ? "***" : value;
}

/** Redact secrets in a JSON body, cookie string or log line. Truncates to `max` chars first. */
export function redact(text: string, max = 2000): string {
  return text
    .slice(0, max)
    .replace(secretValue, '"$1"$2"***"')
    .replace(/gravity=[^;"\s]*/g, "gravity=***")
    .replace(/(^|[^0-9A-Za-z])0x[0-9a-fA-F]{64}(?![0-9A-Za-z])/g, "$10x***");
}

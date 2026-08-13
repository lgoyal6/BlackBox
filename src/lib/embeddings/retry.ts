export interface HttpishError extends Error {
  status?: number;
  retryable?: boolean;
}

const RETRYABLE_STATUS = new Set([429, 500, 502, 503, 504]);
const NETWORK_CODES = new Set([
  "ECONNRESET",
  "ETIMEDOUT",
  "ECONNREFUSED",
  "ENOTFOUND",
  "EAI_AGAIN",
  "UND_ERR_CONNECT_TIMEOUT",
  "UND_ERR_SOCKET",
]);

function asRecord(err: unknown): Record<string, unknown> | null {
  if (!err || typeof err !== "object") return null;
  return err as Record<string, unknown>;
}

/** 429, 500, 502, 503, 504, and network/timeout errors. Everything else is false. */
export function isRetryable(err: unknown): boolean {
  const rec = asRecord(err);
  if (!rec) return false;
  if (rec.retryable === true) return true;
  if (rec.retryable === false) return false;

  const status = rec.status;
  if (typeof status === "number") return RETRYABLE_STATUS.has(status);

  const name = rec.name;
  if (name === "AbortError" || name === "TimeoutError") return true;

  const code = rec.code;
  if (typeof code === "string" && NETWORK_CODES.has(code)) return true;

  return err instanceof TypeError;
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function withRetry<T>(
  fn: (attempt: number) => Promise<T>,
  opts?: { attempts?: number; baseMs?: number; label?: string },
): Promise<T> {
  const attempts = opts?.attempts ?? 4;
  const baseMs = opts?.baseMs ?? 500;
  const label = opts?.label ?? "embed";
  let lastErr: unknown;

  for (let attempt = 1; attempt <= attempts; attempt++) {
    try {
      return await fn(attempt);
    } catch (err) {
      lastErr = err;
      if (attempt >= attempts || !isRetryable(err)) throw err;
      const rec = asRecord(err);
      const status = typeof rec?.status === "number" ? rec.status : "network";
      console.warn(`[retry] ${label} attempt ${attempt}/${attempts} status ${status} — retrying`);
      const exp = baseMs * 2 ** (attempt - 1);
      const jittered = exp * (0.75 + Math.random() * 0.5);
      await sleep(jittered);
    }
  }

  throw lastErr;
}

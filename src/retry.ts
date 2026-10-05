/**
 * Retrying calls that Cove refused with 429. The API rate-limits each source
 * address (a token bucket, 30 requests/s by default) and rejects the excess
 * before any handler runs, so a 429'd request did nothing and is safe to
 * resend, a POST included. `@cove/sdk` never retries a 429 itself (its file
 * methods included), so the retry lives here. The SDK exposes the answer's
 * `Retry-After` as `retryAfterSecs` (runcove-413g9): when present it sets the
 * wait (capped), otherwise the wait is a short exponential backoff with jitter.
 */
import { apiErrorStatus, retryAfterSecs } from "./errors.ts";

/** A 429 from any copy of the SDK (recognised by shape, see `errors.ts`). */
export function isRateLimited(err: unknown): boolean {
  return apiErrorStatus(err)?.status === 429;
}

/**
 * A file-API answer worth repeating: a 429, or a 503 `unavailable` (the guest
 * agent connection was lost or timed out, or too many transfers are open; the
 * API says to retry). File transfers are idempotent: a PUT replaces the file
 * atomically, so repeating one is safe.
 */
export function isTransientFileError(err: unknown): boolean {
  return isRateLimited(err) || apiErrorStatus(err)?.status === 503;
}

export interface RetryOptions {
  /** Which errors to retry. Default {@link isRateLimited}. */
  retryOn?: (err: unknown) => boolean;
  /** Total tries, the first included. Default 8. */
  attempts?: number;
  /** First backoff; it doubles per retry, capped at 4 s. Default 250 ms. */
  baseDelayMs?: number;
  /**
   * The most time all the waits of one call may add up to. A retry whose
   * wait would go past it is not made: the error is thrown instead. Default
   * {@link MAX_TOTAL_RETRY_WAIT_MS}.
   */
  maxTotalDelayMs?: number;
  signal?: AbortSignal;
}

export function backoffMs(retry: number, baseDelayMs = 250): number {
  return Math.min(baseDelayMs * 2 ** retry, 4000) + Math.random() * baseDelayMs;
}

/** The longest `Retry-After` honoured; a longer one is waited for this long. */
export const MAX_RETRY_AFTER_MS = 10_000;

/**
 * The most time the waits between retries of one call add up to (by default):
 * a server, or a proxy, asking for long waits again and again cannot hold a
 * call (most have no abort signal) for longer than this.
 */
export const MAX_TOTAL_RETRY_WAIT_MS = 30_000;

/**
 * How long to wait before retry number `retry` (0-based) of a call that
 * failed with `err`: the server's `Retry-After` when it sent one (capped at
 * {@link MAX_RETRY_AFTER_MS}, plus jitter so callers sharing an address do
 * not return in step), else {@link backoffMs}.
 */
export function retryDelayMs(err: unknown, retry: number, baseDelayMs = 250): number {
  const secs = retryAfterSecs(err);
  if (secs === undefined) return backoffMs(retry, baseDelayMs);
  return Math.min(secs * 1000, MAX_RETRY_AFTER_MS) + Math.random() * baseDelayMs;
}

export function abortableSleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) {
      reject(signal.reason ?? new DOMException("aborted", "AbortError"));
      return;
    }
    const onAbort = () => {
      clearTimeout(timer);
      reject(new DOMException("The operation was aborted", "AbortError"));
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

export async function withRateLimitRetry<T>(
  fn: () => Promise<T>,
  opts: RetryOptions = {},
): Promise<T> {
  const attempts = opts.attempts ?? 8;
  const budget = opts.maxTotalDelayMs ?? MAX_TOTAL_RETRY_WAIT_MS;
  let waited = 0;
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!(opts.retryOn ?? isRateLimited)(err) || i >= attempts - 1) throw err;
      const delay = retryDelayMs(err, i, opts.baseDelayMs);
      if (waited + delay > budget) throw err;
      waited += delay;
      await abortableSleep(delay, opts.signal);
    }
  }
}

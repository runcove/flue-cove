/**
 * Retrying calls that Cove refused with 429. The API rate-limits each source
 * address (a token bucket, 30 requests/s by default) and rejects the excess
 * before any handler runs, so a 429'd request did nothing and is safe to
 * resend, a POST included. `@cove/sdk` 0.4.0 neither retries a 429 itself
 * (its file methods included) nor exposes `Retry-After`, so the retry lives
 * here and the wait is a short exponential backoff with jitter (runcove-413g9).
 */
import { CoveAPIError } from "@cove/sdk";
import { fileErrorStatus } from "./files.ts";

export function isRateLimited(err: unknown): boolean {
  return err instanceof CoveAPIError && err.status === 429;
}

/**
 * A file-API answer worth repeating: a 429, or a 503 `unavailable` (the guest
 * agent connection was lost or timed out, or too many transfers are open; the
 * API says to retry). File transfers are idempotent: a PUT replaces the file
 * atomically, so repeating one is safe.
 */
export function isTransientFileError(err: unknown): boolean {
  return isRateLimited(err) || fileErrorStatus(err)?.status === 503;
}

export interface RetryOptions {
  /** Which errors to retry. Default {@link isRateLimited}. */
  retryOn?: (err: unknown) => boolean;
  /** Total tries, the first included. Default 8. */
  attempts?: number;
  /** First backoff; it doubles per retry, capped at 4 s. Default 250 ms. */
  baseDelayMs?: number;
  signal?: AbortSignal;
}

export function backoffMs(retry: number, baseDelayMs = 250): number {
  return Math.min(baseDelayMs * 2 ** retry, 4000) + Math.random() * baseDelayMs;
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
  for (let i = 0; ; i++) {
    try {
      return await fn();
    } catch (err) {
      if (!(opts.retryOn ?? isRateLimited)(err) || i >= attempts - 1) throw err;
      await abortableSleep(backoffMs(i, opts.baseDelayMs), opts.signal);
    }
  }
}

/**
 * Classifying `@cove/sdk` errors by their shape, never with `instanceof`.
 *
 * flue-cove bundles its own copy of the SDK. An application that builds its
 * `CoveClient` from another copy (its own install, a different version)
 * throws error objects whose classes are not flue-cove's, so `instanceof
 * CoveAPIError` would be false for every one of them, and a refusal the
 * driver can work around (a 422, a 429) would become a hard failure. What
 * every copy shares is the shape: an API error carries a numeric HTTP
 * `status` and, when the response had a body, a string `code`. A truncated
 * download has no status and is recognised by its class `name`. Message
 * text is never consulted.
 */

/** The HTTP status and API code of an SDK API error, or `undefined` for anything else. */
export function apiErrorStatus(
  err: unknown,
): { status: number; code: string | undefined } | undefined {
  if (typeof err !== "object" || err === null) return undefined;
  const { status, code } = err as { status?: unknown; code?: unknown };
  if (typeof status !== "number" || !Number.isInteger(status) || status < 400 || status > 599) {
    return undefined;
  }
  if (code !== undefined && typeof code !== "string") return undefined;
  if (!(err instanceof Error) && typeof (err as { message?: unknown }).message !== "string") {
    return undefined;
  }
  return { status, code };
}

/**
 * True for an error the SDK raised itself with no HTTP error behind it: its
 * base class `CoveError` and nothing more specific. Downloads and stats raise
 * one for a 200 they cannot trust: no readable `Content-Length`, or a
 * `Content-Encoding` other than identity (a proxy that compressed the body).
 * Not a connection failure (`CoveConnectionError`), not a truncated download
 * (`DownloadTruncatedError`), not an abort. Recognised by class name, from
 * any copy of the SDK.
 */
export function isPlainCoveError(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  return (err as { name?: unknown }).name === "CoveError" && apiErrorStatus(err) === undefined;
}

/**
 * True when a request's deadline expired. `@cove/sdk` raises its `timeoutMs`
 * deadline as `CoveTimeoutError`; an older copy let the platform's
 * `DOMException` named `TimeoutError` through instead, as does a caller's own
 * `AbortSignal.timeout()`. Recognised by name, from any copy of the SDK.
 */
export function isDeadline(err: unknown): boolean {
  if (typeof err !== "object" || err === null) return false;
  const name = (err as { name?: unknown }).name;
  return name === "CoveTimeoutError" || name === "TimeoutError";
}

/**
 * The wait a 429 or 5xx asked for with `Retry-After`, in seconds, as the SDK
 * parsed it (`retryAfterSecs`, delta-seconds only), or `undefined` when the
 * answer had none or the error is not an SDK API error.
 */
export function retryAfterSecs(err: unknown): number | undefined {
  if (apiErrorStatus(err) === undefined) return undefined;
  const secs = (err as { retryAfterSecs?: unknown }).retryAfterSecs;
  return typeof secs === "number" && Number.isFinite(secs) && secs >= 0 ? secs : undefined;
}

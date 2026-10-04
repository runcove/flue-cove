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

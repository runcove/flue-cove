/**
 * Building a `CoveClient` from options or from the environment. Every
 * `CoveClient` carries the file API as `client.vms.files`; `filesFor` in
 * `files.ts` adapts it for the driver.
 */
import { readFileSync } from "node:fs";
import { CoveClient, type CoveClientOptions, CoveConfigError } from "@cove/sdk";

/** `new CoveClient(options)`. */
export function createCoveClient(options: CoveClientOptions): CoveClient {
  return new CoveClient(options);
}

/** Extra client options for {@link fromEnv}; the URL and key always come from the environment. */
export type FromEnvOptions = Omit<CoveClientOptions, "baseUrl" | "token" | "ticket" | "auth">;

/**
 * A `CoveClient` from the environment:
 * - `COVE_API_URL`: the Cove API base URL (the external bearer listener);
 * - `COVE_API_KEY`: a `cvk_` bearer key, or
 * - `COVE_API_KEY_FILE`: a file holding one (read here; its trailing newline is dropped).
 *
 * A missing or unreadable setting, and anything the SDK's constructor refuses
 * (a malformed or non-`http(s)` URL, plain `http://` to a non-loopback host),
 * throws the bundled SDK's `CoveConfigError`. The key never appears in an
 * error, a log line or a serialized client.
 */
export function fromEnv(
  env: Record<string, string | undefined> = process.env,
  options: FromEnvOptions = {},
): CoveClient {
  const baseUrl = env.COVE_API_URL?.trim();
  if (!baseUrl) {
    throw new CoveConfigError("COVE_API_URL is not set: point it at the Cove API base URL");
  }
  let token = env.COVE_API_KEY?.trim();
  if (!token) {
    const file = env.COVE_API_KEY_FILE?.trim();
    if (!file) throw new CoveConfigError("set COVE_API_KEY or COVE_API_KEY_FILE to a Cove API key");
    try {
      token = readFileSync(file, "utf8").trim();
    } catch (err) {
      const code = (err as { code?: string }).code ?? "unreadable";
      throw new CoveConfigError(`COVE_API_KEY_FILE ${file} could not be read (${code})`);
    }
    if (!token) throw new CoveConfigError(`COVE_API_KEY_FILE ${file} is empty`);
  }
  try {
    return createCoveClient({ ...options, baseUrl, token });
  } catch (err) {
    // Rebuild the error from its message alone so nothing else rides along,
    // keeping its class when the SDK called it a configuration mistake (by
    // name: the SDK's errors are recognised by shape, never `instanceof`).
    const message = (err instanceof Error ? err.message : String(err))
      .split(token)
      .join("[REDACTED]");
    const isConfig = (err as { name?: unknown } | null)?.name === "CoveConfigError";
    throw isConfig ? new CoveConfigError(message) : new Error(message);
  }
}

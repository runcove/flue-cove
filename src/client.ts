/**
 * Building a `CoveClient` from options or from the environment. Every
 * `CoveClient` carries the file API as `client.vms.files`; `filesFor` in
 * `files.ts` adapts it for the driver.
 */
import { readFileSync } from "node:fs";
import { CoveClient, type CoveClientOptions } from "@cove/sdk";

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
 * The key never appears in an error, a log line or a serialized client.
 */
export function fromEnv(
  env: Record<string, string | undefined> = process.env,
  options: FromEnvOptions = {},
): CoveClient {
  const baseUrl = env.COVE_API_URL?.trim();
  if (!baseUrl) throw new Error("COVE_API_URL is not set: point it at the Cove API base URL");
  let token = env.COVE_API_KEY?.trim();
  if (!token) {
    const file = env.COVE_API_KEY_FILE?.trim();
    if (!file) throw new Error("set COVE_API_KEY or COVE_API_KEY_FILE to a Cove API key");
    try {
      token = readFileSync(file, "utf8").trim();
    } catch (err) {
      const code = (err as { code?: string }).code ?? "unreadable";
      throw new Error(`COVE_API_KEY_FILE ${file} could not be read (${code})`);
    }
    if (!token) throw new Error(`COVE_API_KEY_FILE ${file} is empty`);
  }
  try {
    return createCoveClient({ ...options, baseUrl, token });
  } catch (err) {
    // Rebuild the error from its message alone so nothing else rides along.
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(message.split(token).join("[REDACTED]"));
  }
}

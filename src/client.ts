/**
 * Building a `CoveClient`, and remembering which file-API client goes with it.
 *
 * `@cove/sdk` keeps a client's base URL and credential private, so the
 * stop-gap file client (`files.ts`) cannot be derived from an arbitrary
 * `CoveClient`. Clients built here are registered with a matching file client
 * in a WeakMap; `filesFor(client)` finds it. A `CoveClient` constructed
 * elsewhere has none, and the driver then moves file content over exec.
 */
import { readFileSync } from "node:fs";
import { CoveClient, type CoveClientOptions } from "@cove/sdk";
import { type CoveFiles, createFetchFiles } from "./files.ts";

const registry = new WeakMap<CoveClient, CoveFiles>();

/** The file-API client registered for `client`, if it was built by this package. */
export function filesFor(client: CoveClient): CoveFiles | undefined {
  return registry.get(client);
}

/** `new CoveClient(options)`, plus a file-API client with the same URL and credential. */
export function createCoveClient(options: CoveClientOptions): CoveClient {
  const client = new CoveClient(options);
  const filesOpts: Parameters<typeof createFetchFiles>[0] = { baseUrl: options.baseUrl };
  if (options.auth) filesOpts.auth = options.auth;
  if (options.token) filesOpts.token = options.token;
  if (options.ticket) filesOpts.ticket = options.ticket;
  if (options.fetch) filesOpts.fetch = options.fetch;
  if (options.allowInsecureHttp) filesOpts.allowInsecureHttp = true;
  registry.set(client, createFetchFiles(filesOpts));
  return client;
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

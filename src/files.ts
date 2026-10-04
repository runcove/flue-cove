/**
 * Cove's file-transfer API (`/api/vms/{name}/files`: HEAD `statVmFile`, GET
 * `downloadVmFile`, PUT `uploadVmFile`) behind one small interface.
 *
 * STOP-GAP: `@cove/sdk` 0.4.0 has no methods for these three operations, so
 * this module carries a minimal typed fetch client for them. When the SDK
 * ships `client.vms.files.{stat,download,upload}`, replace
 * {@link createFetchFiles} with a thin wrapper over those methods that maps
 * their errors onto {@link CoveFileError}, and delete the fetch code. The
 * driver depends only on {@link CoveFiles}, so nothing else changes.
 */
import { type AuthOptions, type CoveAuth, resolveAuth } from "@cove/sdk";

/** What a HEAD tells us about a regular file. Cove sends no modification time. */
export interface CoveFileInfo {
  /** Size in bytes (`Content-Length`). */
  size: number;
  /** Permission bits (`X-Cove-File-Mode`), when the server sent them. */
  mode?: number;
}

/** The server's answer to a committed upload (`FileUploaded`). */
export interface CoveFileUploaded {
  path: string;
  size: number;
  mode: number;
  sha256: string;
}

export interface CoveFilesCallOptions {
  signal?: AbortSignal;
}

/** The three file operations the driver needs. Paths are absolute guest paths. */
export interface CoveFiles {
  stat(vm: string, path: string, opts?: CoveFilesCallOptions): Promise<CoveFileInfo>;
  download(vm: string, path: string, opts?: CoveFilesCallOptions): Promise<Uint8Array>;
  upload(
    vm: string,
    path: string,
    bytes: Uint8Array,
    opts?: CoveFilesCallOptions & { mode?: number },
  ): Promise<CoveFileUploaded>;
}

/**
 * A failed file operation. `status` is the HTTP status (`0` when the request
 * never got an answer); `code` is the API's machine-readable error code when
 * the response carried one (a HEAD never does), or `short_body` for a
 * download that ended before its `Content-Length`.
 */
export class CoveFileError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = "CoveFileError";
    this.status = status;
    this.code = code;
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, status: this.status, code: this.code, message: this.message };
  }
}

export interface FetchFilesOptions extends AuthOptions {
  /** Base URL of the Cove API, e.g. `https://<cove-host>`. */
  baseUrl: string;
  /** Custom fetch, for tests. Defaults to the global `fetch`. */
  fetch?: typeof fetch;
  /** Permit `http://` to a non-loopback host. Off by default, as in `@cove/sdk`. */
  allowInsecureHttp?: boolean;
}

const LOOPBACK_V4 = /^127(\.\d{1,3}){3}$/;

function assertSecureBaseUrl(url: URL, allowInsecure: boolean): void {
  if (url.protocol !== "http:" || allowInsecure) return;
  const host = url.hostname;
  if (host === "localhost" || host === "[::1]" || LOOPBACK_V4.test(host)) return;
  throw new TypeError(
    `Refusing http:// baseUrl ${url.origin}: the credential would travel in cleartext. Use https://, a loopback address, or allowInsecureHttp: true.`,
  );
}

function isAbort(err: unknown): boolean {
  return err instanceof Error && (err.name === "AbortError" || err.name === "TimeoutError");
}

/** Read `{code, message}` from an error response, tolerating any body. */
async function errorFrom(res: Response, what: string): Promise<CoveFileError> {
  let code: string | undefined;
  let detail: string | undefined;
  try {
    const text = await res.text();
    if (text) {
      try {
        const body = JSON.parse(text) as { code?: unknown; message?: unknown };
        if (typeof body.code === "string") code = body.code;
        if (typeof body.message === "string") detail = body.message;
      } catch {
        detail = text.slice(0, 200);
      }
    }
  } catch {
    // No readable body (HEAD, or the connection went away): the status stands alone.
  }
  const suffix = detail ? `: ${detail}` : code ? ` (${code})` : "";
  return new CoveFileError(
    res.status,
    code,
    `Cove ${what} failed with HTTP ${res.status}${suffix}`,
  );
}

/**
 * The stop-gap fetch implementation of {@link CoveFiles}. The credential lives
 * only inside the SDK's auth strategy (an ECMAScript private field) and is
 * applied to each request's headers; it never reaches an error or a log.
 */
export function createFetchFiles(opts: FetchFilesOptions): CoveFiles {
  const base = new URL(opts.baseUrl);
  assertSecureBaseUrl(base, opts.allowInsecureHttp === true);
  const origin = base.href.replace(/\/+$/, "");
  const auth: CoveAuth = resolveAuth(opts);
  const fetchImpl = opts.fetch ?? globalThis.fetch;

  const urlFor = (vm: string, path: string, mode?: number): string => {
    // encodeURIComponent encodes a space as %20 and `+` as %2B, which is what
    // the server's percent-decoding-only query parser needs.
    let url = `${origin}/api/vms/${encodeURIComponent(vm)}/files?path=${encodeURIComponent(path)}`;
    if (mode !== undefined) url += `&mode=${mode.toString(8).padStart(4, "0")}`;
    return url;
  };

  const send = async (
    method: "HEAD" | "GET" | "PUT",
    url: string,
    what: string,
    signal: AbortSignal | undefined,
    body?: Uint8Array,
  ): Promise<Response> => {
    const headers = new Headers();
    await auth.apply(headers);
    if (body !== undefined) headers.set("Content-Type", "application/octet-stream");
    const init: RequestInit = { method, headers, redirect: "error" };
    if (signal) init.signal = signal;
    // A Uint8Array is a valid fetch body; the DOM lib's typing lags behind.
    if (body !== undefined) init.body = body as unknown as BodyInit;
    try {
      return await fetchImpl(url, init);
    } catch (err) {
      if (isAbort(err)) throw err;
      throw new CoveFileError(
        0,
        undefined,
        `Cove ${what} could not reach the server: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  };

  const files: CoveFiles = {
    async stat(vm, path, callOpts) {
      const what = `stat of ${path}`;
      const res = await send("HEAD", urlFor(vm, path), what, callOpts?.signal);
      if (!res.ok) throw await errorFrom(res, what);
      const info: CoveFileInfo = { size: Number(res.headers.get("content-length") ?? Number.NaN) };
      const mode = res.headers.get("x-cove-file-mode");
      if (mode && /^[0-7]{1,4}$/.test(mode)) info.mode = Number.parseInt(mode, 8);
      return info;
    },

    async download(vm, path, callOpts) {
      const what = `download of ${path}`;
      const res = await send("GET", urlFor(vm, path), what, callOpts?.signal);
      if (!res.ok) throw await errorFrom(res, what);
      const lengthHeader = res.headers.get("content-length");
      const expected = lengthHeader === null ? undefined : Number(lengthHeader);
      const chunks: Uint8Array[] = [];
      let received = 0;
      try {
        const reader = res.body?.getReader();
        if (reader) {
          for (;;) {
            const { done, value } = await reader.read();
            if (done) break;
            chunks.push(value);
            received += value.byteLength;
          }
        }
      } catch (err) {
        if (isAbort(err)) throw err;
        throw new CoveFileError(
          200,
          "short_body",
          `Cove ${what} failed: the transfer broke after ${received}${expected === undefined ? "" : ` of ${expected}`} bytes`,
        );
      }
      if (expected !== undefined && received !== expected) {
        throw new CoveFileError(
          200,
          "short_body",
          `Cove ${what} failed: received ${received} of ${expected} bytes`,
        );
      }
      const out = new Uint8Array(received);
      let offset = 0;
      for (const chunk of chunks) {
        out.set(chunk, offset);
        offset += chunk.byteLength;
      }
      return out;
    },

    async upload(vm, path, bytes, callOpts) {
      const mode = callOpts?.mode;
      if (mode !== undefined && (!Number.isInteger(mode) || mode < 0 || mode > 0o777)) {
        throw new RangeError(`file mode must be an integer within 0o777, got ${mode}`);
      }
      const what = `upload to ${path}`;
      const res = await send("PUT", urlFor(vm, path, mode), what, callOpts?.signal, bytes);
      if (!res.ok) throw await errorFrom(res, what);
      return (await res.json()) as CoveFileUploaded;
    },
  };
  // Nothing on this object holds the credential, but say so for anything that
  // serializes it anyway.
  Object.defineProperty(files, "toJSON", {
    value: () => ({ type: "CoveFiles", baseUrl: origin }),
    enumerable: false,
  });
  return files;
}

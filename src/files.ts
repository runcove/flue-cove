/**
 * Cove's file-transfer API (`/api/vms/{name}/files`: HEAD `statVmFile`, GET
 * `downloadVmFile`, PUT `uploadVmFile`) behind one small interface.
 *
 * STOP-GAP: `@cove/sdk` 0.4.0 has no methods for these operations, so this
 * module carries a minimal typed fetch client. Its shape mirrors the
 * `client.vms.files` API the SDK is adding (`stat`, `download`,
 * `downloadBytes`, `upload`) and its error classes carry the SDK's names
 * (`FileTooLargeError`, `FilePathDeniedError`, `VmFileNotFoundError`,
 * `FileNotRegularError`, `UnavailableError`, `DownloadTruncatedError`). When
 * the SDK ships them, `createFetchFiles` becomes `(client) => client.vms.files`,
 * the classes become re-exports, `fileErrorStatus` reads the SDK errors'
 * `status`/`code`, and the fetch code goes. The driver depends only on
 * {@link CoveFiles} and {@link fileErrorStatus}, so nothing else changes.
 */
import { type AuthOptions, type CoveAuth, resolveAuth } from "@cove/sdk";

/** `stat`: what a HEAD tells us about a regular file. Cove sends no modification time. */
export interface CoveFileInfo {
  /** Size in bytes (`Content-Length`). */
  size: number;
  /** Permission bits (`X-Cove-File-Mode`), when the server sent them. */
  mode?: number;
}

/** `download`: the file's size and mode, and its bytes as a stream. */
export interface CoveFileDownload extends CoveFileInfo {
  /** Errors with {@link DownloadTruncatedError} if it ends before `size` bytes. */
  body: ReadableStream<Uint8Array>;
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

export interface CoveUploadOptions extends CoveFilesCallOptions {
  /** Permission bits for the file, within 0o777. Default: the replaced file's, else 0o644. */
  mode?: number;
  /** The byte count, if the caller wants it checked against `data`. */
  size?: number;
}

/** The file operations the driver needs. `name` is the VM; `path` an absolute guest path. */
export interface CoveFiles {
  stat(name: string, path: string, opts?: CoveFilesCallOptions): Promise<CoveFileInfo>;
  download(name: string, path: string, opts?: CoveFilesCallOptions): Promise<CoveFileDownload>;
  downloadBytes(name: string, path: string, opts?: CoveFilesCallOptions): Promise<Uint8Array>;
  upload(
    name: string,
    path: string,
    data: Uint8Array,
    opts?: CoveUploadOptions,
  ): Promise<CoveFileUploaded>;
}

/**
 * A failed file operation. `status` is the HTTP status (`0` when the request
 * never got an answer); `code` is the API's machine-readable error code when
 * the response carried one. A HEAD never carries one: its error responses have
 * no body.
 */
export class CoveFileError extends Error {
  readonly status: number;
  readonly code: string | undefined;

  constructor(status: number, code: string | undefined, message: string) {
    super(message);
    this.name = new.target.name;
    this.status = status;
    this.code = code;
  }

  toJSON(): Record<string, unknown> {
    return { name: this.name, status: this.status, code: this.code, message: this.message };
  }
}

/** 413 `file_too_large`: over the server's `[files] max_bytes`. */
export class FileTooLargeError extends CoveFileError {}
/** 403 `file_path_denied`: the path is on the deny-list or a pseudo filesystem. */
export class FilePathDeniedError extends CoveFileError {}
/** 404 `file_not_found`: the file or its parent directory does not exist. */
export class VmFileNotFoundError extends CoveFileError {}
/** 422 `file_not_regular`: not a regular file, or a symlink somewhere in the path. */
export class FileNotRegularError extends CoveFileError {}
/** 503 `unavailable`: guest agent lost, timed out or busy. Retry. */
export class UnavailableError extends CoveFileError {}
/** A download body that ended before its `Content-Length`: a failed download. */
export class DownloadTruncatedError extends CoveFileError {}

/**
 * The HTTP status and API code of a file-operation error, or `undefined` for
 * an error that never got an HTTP answer of that kind. The driver classifies
 * failures through this alone, so the error classes can change underneath.
 */
export function fileErrorStatus(
  err: unknown,
): { status: number; code: string | undefined } | undefined {
  if (err instanceof CoveFileError) return { status: err.status, code: err.code };
  return undefined;
}

/**
 * The error class for a status (and code, when the response had a body).
 * HEAD responses carry no body, so for `stat` only the status is known: a 404
 * may be a missing VM (`vm_not_found`) or a missing file, and a 403 or 422
 * cannot be told apart from their other causes. Those stay plain
 * `CoveFileError`s with no code, and the driver treats them accordingly.
 */
function errorClassFor(status: number, code: string | undefined): typeof CoveFileError {
  switch (status) {
    case 413:
      return FileTooLargeError;
    case 403:
      return code === "file_path_denied" ? FilePathDeniedError : CoveFileError;
    case 404:
      return code === "file_not_found" ? VmFileNotFoundError : CoveFileError;
    case 422:
      return code === "file_not_regular" ? FileNotRegularError : CoveFileError;
    case 503:
      return UnavailableError;
    default:
      return CoveFileError;
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

/** Read `{code, message}` from an error response, tolerating any body (or none). */
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
  const Cls = errorClassFor(res.status, code);
  return new Cls(res.status, code, `Cove ${what} failed with HTTP ${res.status}${suffix}`);
}

function fileInfo(res: Response): CoveFileInfo {
  const info: CoveFileInfo = { size: Number(res.headers.get("content-length") ?? Number.NaN) };
  const mode = res.headers.get("x-cove-file-mode");
  if (mode && /^[0-7]{1,4}$/.test(mode)) info.mode = Number.parseInt(mode, 8);
  return info;
}

/**
 * Pass `body` through, counting bytes; error the stream with
 * {@link DownloadTruncatedError} if it ends (or breaks) before `expected`.
 */
function countedBody(
  body: ReadableStream<Uint8Array> | null,
  expected: number | undefined,
  what: string,
): ReadableStream<Uint8Array> {
  const reader = body?.getReader();
  let received = 0;
  const short = (how: string) =>
    new DownloadTruncatedError(
      200,
      undefined,
      `Cove ${what} failed: ${how} after ${received}${expected === undefined ? "" : ` of ${expected}`} bytes`,
    );
  return new ReadableStream<Uint8Array>({
    async pull(controller) {
      if (!reader) {
        if (expected !== undefined && expected !== 0) controller.error(short("the body was empty"));
        else controller.close();
        return;
      }
      let chunk: ReadableStreamReadResult<Uint8Array>;
      try {
        chunk = await reader.read();
      } catch (err) {
        controller.error(isAbort(err) ? err : short("the transfer broke"));
        return;
      }
      if (chunk.done) {
        if (expected !== undefined && received !== expected) {
          controller.error(
            new DownloadTruncatedError(
              200,
              undefined,
              `Cove ${what} failed: received ${received} of ${expected} bytes`,
            ),
          );
        } else {
          controller.close();
        }
        return;
      }
      received += chunk.value.byteLength;
      controller.enqueue(chunk.value);
    },
    cancel(reason) {
      return reader?.cancel(reason);
    },
  });
}

async function collect(body: ReadableStream<Uint8Array>): Promise<Uint8Array> {
  const reader = body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    chunks.push(value);
    total += value.byteLength;
  }
  const out = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    out.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return out;
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

  const urlFor = (name: string, path: string, mode?: number): string => {
    // Encoded by hand: encodeURIComponent turns a space into %20 and `+` into
    // %2B. The server applies only percent-decoding, so URLSearchParams'
    // `+`-for-space would arrive as a literal plus.
    let url = `${origin}/api/vms/${encodeURIComponent(name)}/files?path=${encodeURIComponent(path)}`;
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
    // A compressed body would not match Content-Length, which is how a
    // truncated download is recognised.
    if (method === "GET") headers.set("Accept-Encoding", "identity");
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
    async stat(name, path, callOpts) {
      const what = `stat of ${path}`;
      const res = await send("HEAD", urlFor(name, path), what, callOpts?.signal);
      if (!res.ok) throw await errorFrom(res, what);
      return fileInfo(res);
    },

    async download(name, path, callOpts) {
      const what = `download of ${path}`;
      const res = await send("GET", urlFor(name, path), what, callOpts?.signal);
      if (!res.ok) throw await errorFrom(res, what);
      const info = fileInfo(res);
      const expected = Number.isFinite(info.size) ? info.size : undefined;
      return { ...info, body: countedBody(res.body, expected, what) };
    },

    async downloadBytes(name, path, callOpts) {
      return collect((await files.download(name, path, callOpts)).body);
    },

    async upload(name, path, data, callOpts) {
      const mode = callOpts?.mode;
      if (mode !== undefined && (!Number.isInteger(mode) || mode < 0 || mode > 0o777)) {
        throw new RangeError(`file mode must be an integer within 0o777, got ${mode}`);
      }
      if (callOpts?.size !== undefined && callOpts.size !== data.byteLength) {
        throw new RangeError(
          `size ${callOpts.size} does not match the ${data.byteLength} bytes given`,
        );
      }
      const what = `upload to ${path}`;
      const res = await send("PUT", urlFor(name, path, mode), what, callOpts?.signal, data);
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

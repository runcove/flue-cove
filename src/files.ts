/**
 * Cove's file-transfer API (`/api/vms/{name}/files`: HEAD `statVmFile`, GET
 * `downloadVmFile`, PUT `uploadVmFile`) behind one small interface.
 *
 * The transfer itself is `@runcove/sdk`'s `client.vms.files`. {@link CoveFiles}
 * is the slice of it the driver uses, kept as a seam so driver tests can hand
 * in a fake; {@link sdkFiles} adapts the SDK resource to it. The driver
 * classifies failures only through {@link fileErrorStatus}, which reads the
 * SDK errors' HTTP `status` and API `code`, never their message text.
 */
import type {
  CoveClient,
  FileUploaded,
  VmFileDownload,
  VmFileStat,
  VmFilesResource,
} from "@runcove/sdk";
import { apiErrorStatus } from "./errors.ts";

export {
  DownloadTruncatedError,
  FileNotRegularError,
  FilePathDeniedError,
  FileTooLargeError,
  UnavailableError,
  VmFileNotFoundError,
} from "@runcove/sdk";

/**
 * `stat`: what a HEAD tells us about a regular file: its size, mode and
 * modification time (`mtime`, from `Last-Modified`; `undefined` from a server
 * that predates it).
 */
export type CoveFileInfo = VmFileStat;

/** `download`: the file's size, mode and modification time, and its bytes as a stream. */
export type CoveFileDownload = VmFileDownload;

/** The server's answer to a committed upload. */
export type CoveFileUploaded = FileUploaded;

export interface CoveFilesCallOptions {
  signal?: AbortSignal;
  /**
   * This call's deadline in milliseconds, in place of the client's
   * `timeoutMs`. For a download it bounds the wait for the headers only (the
   * body streams for as long as it takes); for an upload, the whole request.
   */
  timeoutMs?: number;
}

export interface CoveUploadOptions extends CoveFilesCallOptions {
  /** Permission bits within 0o777 (`0o755` or `"0755"`). Default: the replaced file's, else 0o644. */
  mode?: number | string;
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

/** The SDK methods {@link sdkFiles} calls. */
export type CoveFilesResource = Pick<
  VmFilesResource,
  "stat" | "download" | "downloadBytes" | "upload"
>;

const overrides = (opts: CoveFilesCallOptions | undefined) => {
  const out: { signal?: AbortSignal; timeoutMs?: number } = {};
  if (opts?.signal) out.signal = opts.signal;
  if (opts?.timeoutMs !== undefined) out.timeoutMs = opts.timeoutMs;
  return out;
};

/**
 * {@link CoveFiles} over the SDK's `client.vms.files`. The resource is held in
 * a closure, not a property, so nothing on the returned object leads to the
 * client's credential.
 */
export function sdkFiles(resource: CoveFilesResource): CoveFiles {
  const files: CoveFiles = {
    stat: (name, path, opts) => resource.stat(name, path, overrides(opts)),
    download: (name, path, opts) => resource.download(name, path, overrides(opts)),
    downloadBytes: (name, path, opts) => resource.downloadBytes(name, path, overrides(opts)),
    upload: (name, path, data, opts) => {
      const options: { mode?: number | string; size?: number } = {};
      if (opts?.mode !== undefined) options.mode = opts.mode;
      if (opts?.size !== undefined) options.size = opts.size;
      return resource.upload(name, path, data, options, overrides(opts));
    },
  };
  Object.defineProperty(files, "toJSON", {
    value: () => ({ type: "CoveFiles" }),
    enumerable: false,
  });
  return files;
}

/**
 * The file client for `client`: {@link sdkFiles} over its `vms.files`, or
 * `undefined` for a client without one (a test double, say).
 */
export function filesFor(client: Pick<CoveClient, "vms"> | object): CoveFiles | undefined {
  const resource = (client as { vms?: { files?: CoveFilesResource } }).vms?.files;
  return resource ? sdkFiles(resource) : undefined;
}

/**
 * The HTTP status and API code of a file-operation error, or `undefined` for
 * an error that never got an HTTP error answer: a connection failure
 * (`CoveConnectionError`), an abort, a `DownloadTruncatedError` (the server
 * had already answered 200), or the SDK refusing a request before sending it.
 *
 * Errors are recognised by shape (see `errors.ts`), not `instanceof`, so a
 * client built from another copy of the SDK classifies the same. Every HTTP
 * refusal is a `CoveAPIError`: the file classes
 * (`FilePathDeniedError`, `VmFileNotFoundError`, `FileNotRegularError`,
 * `FileTooLargeError`, `UnavailableError`) and the plain status classes for
 * the rest, such as a key without `files:read`/`files:write`, which is a
 * `PermissionDeniedError` with `code` `scope_denied`. HEAD responses carry no
 * body: a current server names the code in `X-Cove-Error-Code`, which the SDK
 * reads, so `stat` errors carry codes like any other. From a server that
 * predates that header only the status is known, except where the status
 * implies its code (413, 422, 503): a 404 may then be a missing VM
 * (`vm_not_found`) or a missing file, and a 403 or 409 cannot be told apart
 * from their other causes. Those have no `code`, and the
 * driver treats them accordingly.
 */
export function fileErrorStatus(
  err: unknown,
): { status: number; code: string | undefined } | undefined {
  return apiErrorStatus(err);
}

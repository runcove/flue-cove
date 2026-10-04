# Changelog

All notable changes to `flue-cove`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) (before 1.0, a minor bump may break).

## [0.2.0]

File transfer now uses the Cove TypeScript SDK's own `client.vms.files`. The
vendored SDK is `@cove/sdk` 0.4.0 built from Cove commit `cb094949d` (see
`vendor/README.md`).

### Breaking

- Removed `CoveFileError`, `createFetchFiles` and `FetchFilesOptions`, the
  stop-gap fetch client and its error base class. File errors are now the
  SDK's own classes (`FileTooLargeError`, `FilePathDeniedError`,
  `VmFileNotFoundError`, `FileNotRegularError`, `UnavailableError`,
  `DownloadTruncatedError`, re-exported here). Their HTTP status and API code
  are read with `fileErrorStatus` or `apiErrorStatus`.
- `filesFor(client)` changed meaning. It used to return a file client only
  for a `CoveClient` built by `fromEnv()`/`createCoveClient()`, and
  `undefined` for any other, which sent that client's file operations over
  exec. It now adapts any client's `vms.files`, so every `CoveClient` uses
  the file API by default. Pass `files: false` to keep everything on exec.
- `CoveFileInfo.mode` is always present now (`number | undefined`), and
  `CoveUploadOptions.mode` also accepts an octal string such as `"0755"`.

### Added

- `sdkFiles(resource)` and the `CoveFilesResource` type: the `CoveFiles`
  adapter over the SDK's `client.vms.files`.
- `CoveClient` (and `CoveClientOptions`) re-exported from the bundled SDK, so
  an application can build its client from the same copy.
- `apiErrorStatus(err)`: an SDK API error's status and code, recognised by
  shape. A client built from another copy of the SDK is classified correctly
  too.
- `CoveSandboxDriver.fileRoute`: whether the server serves the file API.
- `CoveFilesCallOptions.timeoutMs`: a per-call deadline.

### Fixed

- Errors from a `CoveClient` built with another copy of `@cove/sdk` are
  classified by status and code instead of `instanceof`. A 422, 403, 404,
  429 or 503 from such a client is no longer a hard failure, and a
  `scope_denied` refusal is remembered.
- A server without the file API (any build before the file-transfer
  endpoints, including the `cove-server` 0.33.2 release) is detected, and
  file operations then run over exec instead of failing with `ENOENT`.
- A `200` the SDK cannot trust (no readable `Content-Length`, or a
  compressed body) sends `stat`, `exists` and reads to exec.
- Uploads get a deadline sized to the file, so a client's short `timeoutMs`
  no longer cuts large writes off.

## [0.1.0]

First version: `coveVms`, `cove`, `CoveSandboxDriver` and `fromEnv`, with file
transfer over a stop-gap fetch client.

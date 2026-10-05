# Changelog

All notable changes to `flue-cove`. The format follows
[Keep a Changelog](https://keepachangelog.com/en/1.1.0/), and versions follow
[Semantic Versioning](https://semver.org/) (before 1.0, a minor bump may break).

## [Unreleased]

### Changed

- Licensed under Apache-2.0: `LICENSE` is the unmodified Apache License 2.0
  text, `package.json` declares `"license": "Apache-2.0"`, and `LICENSE` is
  listed in `files`. The package stays `"private": true` until it is
  published.

## [0.3.0]

The vendored SDK is `@cove/sdk` 0.4.0 rebuilt from Cove commit `bde79e442`
(main, ahead of the next release; see `vendor/README.md`). It brings the
SDK's deadline and configuration errors, `Retry-After`, HEAD error codes and
`stat`'s modification time. The file-API fallback rules are unchanged; a
`HEAD` error that now carries a code takes the branch that code always took
on a `GET` or `PUT`.

### Changed

- `fromEnv()` throws the SDK's `CoveConfigError` (a `CoveError`, so still an
  `Error`) for a missing or unreadable `COVE_API_URL`/`COVE_API_KEY(_FILE)`
  and for a URL the SDK refuses (malformed, not `http(s)`, or plain `http://`
  to a non-loopback host). It used to throw a plain `Error`. The key is still
  redacted from every message.
- An SDK request deadline is now `CoveTimeoutError` (a `CoveConnectionError`),
  no longer the platform's `TimeoutError`. The driver recognises both by name
  and still kills the guest command's process group when one ends an exec.
- `stat` and `exists` read the code a current server sends with a `HEAD` error
  (`X-Cove-Error-Code`). A `HEAD` 404 `vm_not_found` makes `stat` throw Flue's
  `SandboxDiedError` instead of `ENOENT`; a `HEAD` 404 `file_not_found` is
  `ENOENT` (or `false`) without the route probe. A codeless `HEAD` error, from
  a server that predates the header, is handled as before.
- A `HEAD` 403 `scope_denied` is now remembered like a `GET`/`PUT` one (later
  reads skip the file API), and a `HEAD` 409 `invalid_state_transition` makes
  `stat` throw `SandboxDiedError` instead of trying exec. These follow from
  the codes; the fallback rules themselves are unchanged.
- Retries of a 429, and of a file-API 503, wait for the server's
  `Retry-After` when it sends one (each wait capped at 10 s), else back off
  as before. The waits of one call add up to at most 30 s; a retry that
  would pass that is not made, and the error is thrown.

### Added

- `stat` over the file API returns `mtime`, from `Last-Modified`, when the
  server sends it.
- `CoveConfigError`, `CoveConnectionError` and `CoveTimeoutError` re-exported
  from the bundled SDK; `isDeadline(err)` and `retryAfterSecs(err)`, which
  recognise those answers from any copy of the SDK.
- `scripts/update-cove-sdk.ts` (`npm run update:cove-sdk`): swaps the vendored
  tarball for a released SDK, verified against the release's `sha256.sum` or a
  server's `/public/sdk/index.json`, and bumps the version and this file.

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

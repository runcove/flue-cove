/**
 * flue-cove: run Flue agents' sandboxed work on Cove microVMs.
 *
 * - `coveVms(options)`: provisioning `SandboxFactory`, one VM per Flue instance id.
 * - `cove(client, vmName, options)`: pure adapter over an existing VM.
 * - `CoveSandboxDriver`: the `SandboxDriver` itself, for custom wiring.
 * - `fromEnv()`: a `CoveClient` from `COVE_API_URL` + `COVE_API_KEY`/`COVE_API_KEY_FILE`.
 */
export { createCoveClient, type FromEnvOptions, fromEnv } from "./client.ts";
export {
  type CoveDriverOptions,
  type CoveExecClient,
  CoveSandboxDriver,
  type OutputStream,
  timeoutSecsFor,
} from "./driver.ts";
export {
  type CoveProvisioningClient,
  type CoveSandboxOptions,
  type CoveVmsFactory,
  type CoveVmsOptions,
  cove,
  coveVms,
  DEFAULT_CWD,
  DEFAULT_ID_TAG,
} from "./factory.ts";
export {
  type CoveFileDownload,
  type CoveFileInfo,
  type CoveFiles,
  type CoveFilesCallOptions,
  type CoveFilesResource,
  type CoveFileUploaded,
  type CoveUploadOptions,
  DownloadTruncatedError,
  FileNotRegularError,
  FilePathDeniedError,
  FileTooLargeError,
  fileErrorStatus,
  filesFor,
  sdkFiles,
  UnavailableError,
  VmFileNotFoundError,
} from "./files.ts";
export { buildScript, shellQuote, validateEnvName } from "./quote.ts";

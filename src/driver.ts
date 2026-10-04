/**
 * `CoveSandboxDriver`: Flue's `SandboxDriver` contract on one Cove VM.
 *
 * - `exec` streams `client.vms.exec` and collects the output, or goes through
 *   `client.vms.execWithSecrets` when a secrets selector is configured.
 * - File reads, writes and stats use Cove's file API (see `files.ts`) and fall
 *   back to plain commands over exec where the API refuses a path that a
 *   shell can still handle: symlinks anywhere in the path, directories, paths
 *   on the API's deny-list, guests whose agent predates the API.
 * - `readdir`, `mkdir` and `rm` have no API and always run over exec.
 *
 * Paths reach every helper command as separate argv elements (`"$1"`), never
 * spliced into a script, and are preceded by `--` where the tool takes options,
 * so spaces, quotes, newlines and leading dashes all survive.
 */
import { randomUUID } from "node:crypto";
import { CoveAPIError, type CoveClient, type ExecEvent, type InjectSelector } from "@cove/sdk";
import {
  type FileStat,
  SandboxDiedError,
  type SandboxDriver,
  SandboxOperationUnsupportedError,
  type ShellResult,
} from "@flue/runtime";
import { type CoveFiles, fileErrorStatus } from "./files.ts";
import { buildScript } from "./quote.ts";
import {
  abortableSleep,
  backoffMs,
  isRateLimited,
  isTransientFileError,
  withRateLimitRetry,
} from "./retry.ts";

/** File-API calls retry 429s and 503 `unavailable` a few times. */
const FILE_RETRY = { retryOn: isTransientFileError, attempts: 4 };

/** Retries of an exec refused with 429 before it gives up. */
const RATE_LIMIT_RETRIES = 7;

/** The part of `CoveClient` the driver uses. */
export interface CoveExecClient {
  vms: Pick<CoveClient["vms"], "exec" | "execWithSecrets">;
}

export type OutputStream = "stdout" | "stderr";

export interface CoveDriverOptions {
  /**
   * The file-transfer client. Without one, every file operation runs over
   * exec (base64 for content).
   */
  files?: CoveFiles;
  /**
   * Called with each output chunk as Cove streams it. Flue's contract only
   * returns the collected result; this hook is how an application shows
   * output live. Not called on the secrets path, which Cove buffers.
   */
  onOutput?: (chunk: string, stream: OutputStream) => void;
  /**
   * Run every `exec` through `execWithSecrets` with this selector, so the
   * selected secrets are injected into the command. Cove buffers this route
   * (no live output) and gives it no server-side deadline; the driver
   * enforces `timeoutMs` itself by killing the command's process group.
   */
  secrets?: InjectSelector;
}

interface ExecOptions {
  cwd?: string;
  env?: Record<string, string>;
  timeoutMs?: number;
  signal?: AbortSignal;
}

/** `timeoutMs` as Cove's whole-second `timeout_secs`: rounded up, never zero. */
export function timeoutSecsFor(timeoutMs: number | undefined): number | undefined {
  if (timeoutMs === undefined) return undefined;
  return Math.max(1, Math.ceil(timeoutMs / 1000));
}

/** Largest raw chunk per exec on the write fallback: its base64 stays well under MAX_ARG_STRLEN (128 KiB). */
const WRITE_CHUNK_BYTES = 64 * 1024;

/**
 * Runs the user's script as the leader of a new process group (`setsid -w`
 * when the guest has it), writing that leader's pid to a file so the group
 * can be killed later. Cove's own timeout and a dropped stream both leave
 * descendants running; the group kill is what makes `timeoutMs` and abort
 * actually stop the command. `$1` = inner script, `$2` = pid file, `$3` = user script.
 */
const LAUNCH =
  'if setsid -w true 2>/dev/null; then exec setsid -w sh -c "$1" sh "$2" "$3"; else exec sh -c "$1" sh "$2" "$3"; fi';
const INNER =
  "__flue_cove_pidfile=$1; __flue_cove_cmd=$2; shift 2; " +
  '{ echo $$ > "$__flue_cove_pidfile"; } 2>/dev/null; ' +
  "trap 'rm -f -- \"$__flue_cove_pidfile\"' EXIT; " +
  'eval "$__flue_cove_cmd"';
/** Kill the group recorded in pid file `$1` (or the lone process without setsid), then drop the file. */
const KILL_GROUP =
  'p=$(cat -- "$1" 2>/dev/null); rm -f -- "$1"; ' +
  'case $p in ""|*[!0-9]*) exit 0;; esac; [ "$p" -gt 1 ] || exit 0; ' +
  'kill -s KILL -- "-$p" 2>/dev/null || kill -s KILL "$p" 2>/dev/null; exit 0';

const READ_B64 = 'base64 < "$1"';
const WRITE_ONE = 'printf %s "$1" | base64 -d > "$2"';
const WRITE_START = 't=$(mktemp) && printf %s "$1" | base64 -d > "$t" && printf %s "$t"';
const WRITE_APPEND = 'printf %s "$1" | base64 -d >> "$2"';
const WRITE_COMMIT = 'cat < "$2" > "$1"; s=$?; rm -f -- "$2"; exit $s';
const WRITE_ABORT = 'rm -f -- "$1"';
/** `<l> <raw mode hex> <size> <mtime>`, where l=1 if the path itself is a symlink. */
const STAT =
  'if [ -L "$1" ]; then l=1; else l=0; fi; s=$(stat -L -c "%f %s %Y" -- "$1") || exit 1; echo "$l $s"';
const EXISTS = 'test -e "$1"';
/** Every entry name, NUL-terminated, base64-encoded so no byte is lost in transit. */
const READDIR =
  'cd -- "$1" || exit 1; for f in * .[!.]* ..?*; do if [ -e "$f" ] || [ -L "$f" ]; then printf "%s\\0" "$f"; fi; done | base64';

const S_IFMT = 0o170000;
const S_IFREG = 0o100000;
const S_IFDIR = 0o040000;

function base64Encode(bytes: Uint8Array): string {
  return Buffer.from(bytes.buffer, bytes.byteOffset, bytes.byteLength).toString("base64");
}

function base64Decode(text: string): Uint8Array {
  return new Uint8Array(Buffer.from(text.replace(/\s+/g, ""), "base64"));
}

/** A Node-style filesystem error, so callers can test `err.code`. */
function fsError(code: "ENOENT", op: string, path: string, detail: string): Error {
  const err = new Error(`${code}: ${detail}, ${op} '${path}'`) as Error & {
    code: string;
    path: string;
  };
  err.code = code;
  err.path = path;
  return err;
}

/**
 * Flue's contract: an option the adapter cannot honour is refused with
 * `SandboxOperationUnsupportedError` before anything changes, never ignored.
 * Every option Flue defines today is honoured; this catches ones it adds later.
 */
function refuseUnknownOptions(
  operation: string,
  options: object | undefined,
  known: readonly string[],
): void {
  if (!options) return;
  const unknown = Object.entries(options)
    .filter(([key, value]) => value !== undefined && !known.includes(key))
    .map(([key]) => key);
  if (unknown.length > 0) {
    throw new SandboxOperationUnsupportedError({ operation, provider: "Cove", options: unknown });
  }
}

function died(operation: string): SandboxDiedError {
  return new SandboxDiedError({ operation, reason: "stopped" });
}

/** True when the API error means the VM is gone or not running. */
function vmGone(status: number, code: string | undefined): boolean {
  return (
    (status === 409 && code === "invalid_state_transition") ||
    (status === 404 && code === "vm_not_found")
  );
}

/**
 * Whether a file-API refusal is one a shell in the guest can still serve.
 * HEAD errors carry no body, hence no code: a HEAD 403 or 409 cannot be told
 * from its other causes, so it falls back too (the exec then reports the real
 * problem, e.g. a VM that is not running). A HEAD 422 is any kind of
 * "not a regular file", which is exactly what the fallback handles.
 */
function canFallBack(
  err: { status: number; code: string | undefined },
  op: "stat" | "download" | "upload",
): boolean {
  switch (err.status) {
    case 400: // a path the API's syntax rules refuse (e.g. "/")
    case 422: // symlink in the path, directory, special file
      return true;
    case 403:
      return err.code === undefined || err.code === "file_path_denied";
    case 409:
      return err.code === undefined || err.code === "guest_agent_too_old";
    case 413: // HEAD of a file over the transfer cap: the shell can still stat it
      return op === "stat";
    default:
      return false;
  }
}

interface RunResult {
  stdout: string;
  stderr: string;
  exitCode: number;
}

export class CoveSandboxDriver implements SandboxDriver {
  readonly #client: CoveExecClient;
  readonly #vm: string;
  readonly #files: CoveFiles | undefined;
  readonly #onOutput: CoveDriverOptions["onOutput"];
  readonly #secrets: InjectSelector | undefined;

  constructor(client: CoveExecClient, vm: string, options: CoveDriverOptions = {}) {
    this.#client = client;
    this.#vm = vm;
    this.#files = options.files;
    this.#onOutput = options.onOutput;
    this.#secrets = options.secrets;
  }

  /** The VM this driver targets. */
  get vm(): string {
    return this.#vm;
  }

  // ─── exec ────────────────────────────────────────────────────────────────

  async exec(command: string, options: ExecOptions = {}): Promise<ShellResult> {
    refuseUnknownOptions("exec", options, ["cwd", "env", "timeoutMs", "signal"]);
    const script = buildScript(command, {
      ...(options.cwd !== undefined ? { cwd: options.cwd } : {}),
      ...(options.env !== undefined ? { env: options.env } : {}),
    });
    const pidFile = `/tmp/.flue-cove-${randomUUID()}.pid`;
    const argv = ["sh", "-c", LAUNCH, "sh", INNER, pidFile, script];
    if (this.#secrets) return this.#execWithSecrets(argv, pidFile, options);
    return this.#execStreaming(argv, pidFile, options);
  }

  async #execStreaming(
    argv: string[],
    pidFile: string,
    options: ExecOptions,
  ): Promise<ShellResult> {
    const timeoutSecs = timeoutSecsFor(options.timeoutMs);
    let stdout = "";
    let stderr = "";
    try {
      const stream = this.#stream(
        { command: argv, ...(timeoutSecs !== undefined ? { timeoutSecs } : {}) },
        options.signal,
      );
      for await (const ev of stream) {
        switch (ev.kind) {
          case "stdout":
            stdout += ev.data;
            this.#emit(ev.data, "stdout");
            break;
          case "stderr":
            stderr += ev.data;
            this.#emit(ev.data, "stderr");
            break;
          case "exit":
            return { stdout, stderr, exitCode: ev.code };
          case "paused":
            throw died("exec");
          case "error":
            // Cove reports an expired timeout_secs as an error event; the
            // timeout(1) convention is a result with exit code 124.
            if (timeoutSecs !== undefined && /command timed out/i.test(ev.error)) {
              await this.#killGroup(pidFile);
              return {
                stdout,
                stderr: withNote(
                  stderr,
                  `command timed out after ${timeoutSecs}s (Cove exec timeout)`,
                ),
                exitCode: 124,
              };
            }
            throw new Error(`Cove exec on ${this.#vm} failed: ${ev.error}`);
        }
      }
      throw new Error(`Cove exec on ${this.#vm} ended without an exit status`);
    } catch (err) {
      throw this.#execFailure(err, pidFile, options.signal);
    }
  }

  async #execWithSecrets(
    argv: string[],
    pidFile: string,
    options: ExecOptions,
  ): Promise<ShellResult> {
    const selector = this.#secrets as InjectSelector;
    let timedOut = false;
    const timer =
      options.timeoutMs !== undefined
        ? setTimeout(() => {
            timedOut = true;
            void this.#killGroup(pidFile);
          }, options.timeoutMs)
        : undefined;
    try {
      const out = await withRateLimitRetry(
        () =>
          this.#client.vms.execWithSecrets(
            this.#vm,
            { command: argv, selector },
            options.signal ? { signal: options.signal } : {},
          ),
        options.signal ? { signal: options.signal } : {},
      );
      if (timedOut) {
        return {
          stdout: out.stdout,
          stderr: withNote(
            out.stderr,
            `command timed out after ${options.timeoutMs}ms (enforced by flue-cove)`,
          ),
          exitCode: 124,
        };
      }
      return { stdout: out.stdout, stderr: out.stderr, exitCode: out.exit_code };
    } catch (err) {
      throw this.#execFailure(err, pidFile, options.signal);
    } finally {
      clearTimeout(timer);
    }
  }

  /** Map an exec failure; on a caller abort, also kill the orphaned guest command. */
  #execFailure(err: unknown, pidFile: string, signal: AbortSignal | undefined): unknown {
    if (signal?.aborted) {
      // Cove does not stop a command when its request goes away. Kill the
      // group out of band; the caller has already been released by Flue's
      // abort race, so nobody waits on this.
      void this.#killGroup(pidFile);
      return err;
    }
    if (err instanceof CoveAPIError && vmGone(err.status, err.code)) return died("exec");
    return err;
  }

  /**
   * `client.vms.exec`, retried while Cove answers 429. The rate limiter
   * refuses before the command starts, so no event has been seen when it does.
   */
  async *#stream(
    opts: { command: string[]; timeoutSecs?: number },
    signal: AbortSignal | undefined,
  ): AsyncGenerator<ExecEvent> {
    for (let retry = 0; ; retry++) {
      let started = false;
      try {
        for await (const ev of this.#client.vms.exec(this.#vm, opts, signal ? { signal } : {})) {
          started = true;
          yield ev;
        }
        return;
      } catch (err) {
        if (started || !isRateLimited(err) || retry >= RATE_LIMIT_RETRIES) throw err;
        await abortableSleep(backoffMs(retry), signal);
      }
    }
  }

  #emit(chunk: string, stream: OutputStream): void {
    if (!this.#onOutput) return;
    try {
      this.#onOutput(chunk, stream);
    } catch {
      // An observer must not be able to break the command it observes.
    }
  }

  async #killGroup(pidFile: string): Promise<void> {
    try {
      await this.#run("kill", ["sh", "-c", KILL_GROUP, "sh", pidFile]);
    } catch {
      // Best effort: a VM that is gone has nothing left to kill.
    }
  }

  /** Run a helper command (argv, no user env/cwd) and collect its output. */
  async #run(operation: string, argv: string[]): Promise<RunResult> {
    let stdout = "";
    let stderr = "";
    try {
      for await (const ev of this.#stream({ command: argv }, undefined)) {
        if (ev.kind === "stdout") stdout += ev.data;
        else if (ev.kind === "stderr") stderr += ev.data;
        else if (ev.kind === "exit") return { stdout, stderr, exitCode: ev.code };
        else if (ev.kind === "paused") throw died(operation);
        else throw new Error(`Cove exec on ${this.#vm} failed during ${operation}: ${ev.error}`);
      }
    } catch (err) {
      if (err instanceof CoveAPIError && vmGone(err.status, err.code)) throw died(operation);
      throw err;
    }
    throw new Error(`Cove exec on ${this.#vm} ended without an exit status during ${operation}`);
  }

  /** Run a helper command that must succeed. */
  async #must(operation: string, path: string, argv: string[]): Promise<string> {
    const res = await this.#run(operation, argv);
    if (res.exitCode !== 0) {
      const detail = res.stderr.trim() || `exit status ${res.exitCode}`;
      if (
        /no such file or directory|can't open|cannot open|can't cd/i.test(detail) &&
        !/exists/i.test(detail)
      ) {
        throw fsError("ENOENT", operation, path, detail);
      }
      throw new Error(`${operation} '${path}' failed in Cove VM ${this.#vm}: ${detail}`);
    }
    return res.stdout;
  }

  /** Classify a file-API failure: rethrow as the right error, or return to fall back. */
  #fileFailure(
    err: unknown,
    op: "stat" | "download" | "upload",
    operation: string,
    path: string,
  ): void {
    const http = fileErrorStatus(err);
    if (!http) throw err;
    if (vmGone(http.status, http.code)) throw died(operation);
    // A HEAD 404 has no code, so it may also mean the VM is gone; reporting
    // ENOENT then is the closest honest answer (the next exec will say more).
    if (http.status === 404) throw fsError("ENOENT", operation, path, "no such file or directory");
    if (!canFallBack(http, op)) throw err;
  }

  // ─── files ───────────────────────────────────────────────────────────────

  async readFile(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFileBuffer(path));
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const files = this.#files;
    if (files) {
      try {
        return await withRateLimitRetry(() => files.downloadBytes(this.#vm, path), FILE_RETRY);
      } catch (err) {
        this.#fileFailure(err, "download", "readFile", path);
      }
    }
    return base64Decode(await this.#must("readFile", path, ["sh", "-c", READ_B64, "sh", path]));
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const files = this.#files;
    if (files) {
      try {
        await withRateLimitRetry(() => files.upload(this.#vm, path, bytes), FILE_RETRY);
        return;
      } catch (err) {
        this.#fileFailure(err, "upload", "writeFile", path);
      }
    }
    await this.#writeOverExec(path, bytes);
  }

  async #writeOverExec(path: string, bytes: Uint8Array): Promise<void> {
    if (bytes.byteLength <= WRITE_CHUNK_BYTES) {
      await this.#must("writeFile", path, ["sh", "-c", WRITE_ONE, "sh", base64Encode(bytes), path]);
      return;
    }
    // Stage the chunks in a temp file, then copy it over the target in one
    // step. `cat >` writes through a symlink and keeps the target's mode,
    // which is what Node's fs.writeFile does.
    const first = bytes.subarray(0, WRITE_CHUNK_BYTES);
    const tmp = (
      await this.#must("writeFile", path, ["sh", "-c", WRITE_START, "sh", base64Encode(first)])
    ).trim();
    try {
      for (let off = WRITE_CHUNK_BYTES; off < bytes.byteLength; off += WRITE_CHUNK_BYTES) {
        const chunk = bytes.subarray(off, off + WRITE_CHUNK_BYTES);
        await this.#must("writeFile", path, [
          "sh",
          "-c",
          WRITE_APPEND,
          "sh",
          base64Encode(chunk),
          tmp,
        ]);
      }
      await this.#must("writeFile", path, ["sh", "-c", WRITE_COMMIT, "sh", path, tmp]);
    } catch (err) {
      await this.#run("writeFile", ["sh", "-c", WRITE_ABORT, "sh", tmp]).catch(() => undefined);
      throw err;
    }
  }

  async stat(path: string): Promise<FileStat> {
    const files = this.#files;
    if (files) {
      try {
        const info = await withRateLimitRetry(() => files.stat(this.#vm, path), FILE_RETRY);
        // A 200 means a regular file with no symlink anywhere in its path.
        // HEAD carries no modification time, so mtime is left out.
        const st: FileStat = { isFile: true, isDirectory: false, isSymbolicLink: false };
        if (Number.isFinite(info.size)) st.size = info.size;
        return st;
      } catch (err) {
        this.#fileFailure(err, "stat", "stat", path);
      }
    }
    const out = (await this.#must("stat", path, ["sh", "-c", STAT, "sh", path])).trim();
    const [link, modeHex, size, mtime] = out.split(" ");
    const mode = Number.parseInt(modeHex ?? "", 16);
    if (!Number.isFinite(mode)) {
      throw new Error(`stat '${path}' in Cove VM ${this.#vm} returned unreadable output`);
    }
    const st: FileStat = {
      isFile: (mode & S_IFMT) === S_IFREG,
      isDirectory: (mode & S_IFMT) === S_IFDIR,
      isSymbolicLink: link === "1",
    };
    const sizeNum = Number(size);
    if (size !== undefined && Number.isFinite(sizeNum)) st.size = sizeNum;
    const mtimeNum = Number(mtime);
    if (mtime !== undefined && Number.isFinite(mtimeNum)) st.mtime = new Date(mtimeNum * 1000);
    return st;
  }

  async exists(path: string): Promise<boolean> {
    try {
      const files = this.#files;
      if (files) {
        try {
          await withRateLimitRetry(() => files.stat(this.#vm, path), FILE_RETRY);
          return true;
        } catch (err) {
          // 404 (file or, for a HEAD, possibly the VM) reads as "not there".
          if (fileErrorStatus(err)?.status === 404) return false;
          // Anything else (directory, symlink, denied, transport): ask the shell.
        }
      }
      const res = await this.#run("exists", ["sh", "-c", EXISTS, "sh", path]);
      return res.exitCode === 0;
    } catch {
      return false;
    }
  }

  async readdir(path: string): Promise<string[]> {
    const out = await this.#must("readdir", path, ["sh", "-c", READDIR, "sh", path]);
    const raw = base64Decode(out);
    const names: string[] = [];
    const decoder = new TextDecoder();
    let start = 0;
    for (let i = 0; i < raw.length; i++) {
      if (raw[i] === 0) {
        names.push(decoder.decode(raw.subarray(start, i)));
        start = i + 1;
      }
    }
    return names;
  }

  async mkdir(path: string, options?: { recursive?: boolean }): Promise<void> {
    refuseUnknownOptions("mkdir", options, ["recursive"]);
    const argv = options?.recursive ? ["mkdir", "-p", "--", path] : ["mkdir", "--", path];
    await this.#must("mkdir", path, argv);
  }

  async rm(path: string, options?: { recursive?: boolean; force?: boolean }): Promise<void> {
    refuseUnknownOptions("rm", options, ["recursive", "force"]);
    const flags = `${options?.recursive ? "r" : ""}${options?.force ? "f" : ""}`;
    await this.#must("rm", path, flags ? ["rm", `-${flags}`, "--", path] : ["rm", "--", path]);
  }
}

function withNote(stderr: string, note: string): string {
  const sep = stderr === "" || stderr.endsWith("\n") ? "" : "\n";
  return `${stderr}${sep}[flue-cove] ${note}\n`;
}

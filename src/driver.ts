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
import type { CoveClient, ExecEvent, InjectSelector } from "@cove/sdk";
import {
  type FileStat,
  SandboxDiedError,
  type SandboxDriver,
  SandboxOperationUnsupportedError,
  type ShellResult,
} from "@flue/runtime";
import { apiErrorStatus, isPlainCoveError } from "./errors.ts";
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

/** The longest delay setTimeout honours. */
const MAX_TIMER_MS = 2 ** 31 - 1;

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
 * Runs the user's script under bash when the guest has it (else sh), as the
 * leader of a new process group (`setsid -w`) when the guest has setsid,
 * recording `<mode> <pid> <starttime>` in a pid file so the command can be
 * killed later: mode `g` means the pid is a process-group id, `p` a lone pid.
 * Cove's own timeout kills only the direct child and an aborted request kills
 * nothing (runcove-cw62w, runcove-ckxuu); the group kill is what makes
 * `timeoutMs` and abort actually stop the command.
 * `$1` = inner script, `$2` = pid file, `$3` = user script.
 */
const LAUNCH =
  "if command -v bash >/dev/null 2>&1; then s=bash; else s=sh; fi; " +
  'if setsid -w true 2>/dev/null; then exec setsid -w "$s" -c "$1" "$s" "$2" "$3" g; ' +
  'else exec "$s" -c "$1" "$s" "$2" "$3" p; fi';
const INNER =
  "__flue_cove_pidfile=$1; __flue_cove_cmd=$2; __flue_cove_mode=$3; shift 3; " +
  "{ __flue_cove_st=$(sed 's/^.*) //' /proc/$$/stat | cut -d' ' -f20); " +
  'echo "$__flue_cove_mode $$ $__flue_cove_st" > "$__flue_cove_pidfile"; } 2>/dev/null; ' +
  "trap 'rm -f -- \"$__flue_cove_pidfile\"' EXIT; " +
  'eval "$__flue_cove_cmd"';
/**
 * Kill what pid file `$1` records, then drop the file. Waits up to ~1 s for
 * the file (an abort can race the command's start). A recorded pid that is
 * alive but has a different start time is a recycled pid: leave it alone. A
 * group id whose leader is gone is still safe to signal: the kernel does not
 * hand out a pid that is still in use as a process-group id.
 */
export const KILL_GROUP =
  'i=0; while [ ! -e "$1" ] && [ "$i" -lt 5 ]; do sleep 0.2; i=$((i+1)); done; ' +
  'read -r m p t < "$1" 2>/dev/null; rm -f -- "$1"; ' +
  'case $p in ""|*[!0-9]*) exit 0;; esac; [ "$p" -gt 1 ] || exit 0; ' +
  'if [ -r "/proc/$p/stat" ]; then ' +
  "cur=$(sed 's/^.*) //' \"/proc/$p/stat\" | cut -d' ' -f20); " +
  '[ -z "$t" ] || [ "$cur" = "$t" ] || exit 0; ' +
  'elif [ "$m" != g ]; then exit 0; fi; ' +
  'if [ "$m" = g ]; then kill -s KILL -- "-$p" 2>/dev/null; else kill -s KILL "$p" 2>/dev/null; fi; exit 0';

// Content and names travel as base64 because Cove drops a command's whole
// output when it is not valid UTF-8 (runcove-gcin2).
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
    case 403: // deny-listed path, or a key without files:read / files:write
      return (
        err.code === undefined || err.code === "file_path_denied" || err.code === "scope_denied"
      );
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
  /** The key lacks files:read (or files:write): skip the API from then on. */
  #readScopeDenied = false;
  #writeScopeDenied = false;
  /**
   * Whether the server serves the file API at all. Its routes are newer than
   * some servers still in use, which answer every `/files` request with
   * their router's bare 404. `unknown` until a call proves it either way.
   */
  #fileRoute: "unknown" | "present" | "absent" = "unknown";
  /** The one in-flight probe for {@link #fileRoute}, shared by concurrent callers. */
  #routeProbe: Promise<"unknown" | "present" | "absent"> | undefined;

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

  /**
   * What the driver knows about the server's file route: `present`,
   * `absent` (file operations then run over exec), or `unknown` until a
   * file-API call or the route probe has answered.
   */
  get fileRoute(): "unknown" | "present" | "absent" {
    return this.#fileRoute;
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
            // Cove reports an expired timeout_secs as an error event and kills
            // only the direct child (runcove-cw62w); the timeout(1) convention
            // is a result with exit code 124, and the group kill stops the rest.
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
    let timer: ReturnType<typeof setTimeout> | undefined;
    // setTimeout fires at once for delays beyond 2^31-1 ms; clamp instead.
    const delay =
      options.timeoutMs === undefined
        ? undefined
        : Math.min(Math.max(0, options.timeoutMs), MAX_TIMER_MS);
    try {
      const out = await withRateLimitRetry(
        async () => {
          // The deadline starts when a request goes out: a 429'd attempt ran
          // nothing, so its timer must not survive into the backoff and fire
          // a kill that would find the retry's pid file.
          timedOut = false;
          if (delay !== undefined) {
            timer = setTimeout(() => {
              timedOut = true;
              void this.#killGroup(pidFile);
            }, delay);
          }
          try {
            return await this.#client.vms.execWithSecrets(
              this.#vm,
              { command: argv, selector },
              options.signal ? { signal: options.signal } : {},
            );
          } catch (err) {
            if (isRateLimited(err)) {
              clearTimeout(timer);
              timedOut = false;
            }
            throw err;
          }
        },
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
    // Cove does not stop a command when its request goes away (runcove-ckxuu):
    // on a caller abort, or the SDK's own request deadline (TimeoutError),
    // kill the group out of band. The caller has already been released, so
    // nobody waits on this.
    if (signal?.aborted || (err instanceof Error && err.name === "TimeoutError")) {
      void this.#killGroup(pidFile);
      return err;
    }
    const http = apiErrorStatus(err);
    if (http && vmGone(http.status, http.code)) return died("exec");
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
      const http = apiErrorStatus(err);
      if (http && vmGone(http.status, http.code)) throw died(operation);
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

  /** The file client for reads (stat, download) or writes, or `undefined` to use exec. */
  #filesFor(direction: "read" | "write"): CoveFiles | undefined {
    if (this.#fileRoute === "absent") return undefined;
    if (direction === "read" ? this.#readScopeDenied : this.#writeScopeDenied) return undefined;
    return this.#files;
  }

  /** A file-API call that answered: the route exists. */
  #routeSeen(): void {
    this.#fileRoute = "present";
  }

  /**
   * Whether the server lacks the file route, for a HEAD that answered a bare
   * 404. A HEAD error has no body, so that 404 may be a missing file, a
   * missing VM or a missing route. A server with the route answers 404 only
   * after it has found the VM, and refuses the path `/` (an empty component)
   * with 400 before any guest call; a server without it answers its
   * router's bare 404 to that probe too. Probed once per driver. A probe that
   * gets no HTTP answer decides nothing and is tried again next time.
   */
  async #routeAbsent(files: CoveFiles): Promise<boolean> {
    if (this.#fileRoute !== "unknown") return this.#fileRoute === "absent";
    this.#routeProbe ??= (async () => {
      try {
        await withRateLimitRetry(() => files.stat(this.#vm, "/"), FILE_RETRY);
        return "present" as const;
      } catch (err) {
        const http = apiErrorStatus(err);
        if (!http) return "unknown" as const;
        return http.status === 404 && http.code === undefined ? "absent" : "present";
      }
    })();
    const found = await this.#routeProbe;
    this.#routeProbe = undefined;
    if (found !== "unknown" && this.#fileRoute === "unknown") this.#fileRoute = found;
    return this.#fileRoute === "absent";
  }

  /** Classify a file-API failure: rethrow as the right error, or return to fall back. */
  #fileFailure(
    err: unknown,
    op: "stat" | "download" | "upload",
    operation: string,
    path: string,
  ): void {
    const http = fileErrorStatus(err);
    if (!http) {
      // A 200 the SDK refused to trust (no Content-Length, or a compressed
      // body whose length no longer counts its bytes): the shell can still
      // stat and read the file. A truncated download is never one of these.
      if (op !== "upload" && isPlainCoveError(err)) return;
      throw err;
    }
    // Only the file route's own handlers send a code.
    if (http.code !== undefined) this.#routeSeen();
    // A GET or PUT 404 from a server with the file route always names what is
    // missing (`vm_not_found` or `file_not_found`); one with no code is the
    // router of a server that predates the route. Use exec from now on.
    if (op !== "stat" && http.status === 404 && http.code === undefined) {
      this.#fileRoute = "absent";
      return;
    }
    if (vmGone(http.status, http.code)) throw died(operation);
    // A HEAD 404 has no code, so it may also mean the VM is gone; reporting
    // ENOENT then is the closest honest answer (the next exec will say more).
    if (http.status === 404) throw fsError("ENOENT", operation, path, "no such file or directory");
    if (http.status === 403 && http.code === "scope_denied") {
      if (op === "upload") this.#writeScopeDenied = true;
      else this.#readScopeDenied = true;
    }
    if (!canFallBack(http, op)) throw err;
  }

  // ─── files ───────────────────────────────────────────────────────────────

  async readFile(path: string): Promise<string> {
    return new TextDecoder().decode(await this.readFileBuffer(path));
  }

  async readFileBuffer(path: string): Promise<Uint8Array> {
    const files = this.#filesFor("read");
    if (files) {
      try {
        const bytes = await withRateLimitRetry(
          () => files.downloadBytes(this.#vm, path),
          FILE_RETRY,
        );
        this.#routeSeen();
        return bytes;
      } catch (err) {
        this.#fileFailure(err, "download", "readFile", path);
      }
    }
    return base64Decode(await this.#must("readFile", path, ["sh", "-c", READ_B64, "sh", path]));
  }

  async writeFile(path: string, content: string | Uint8Array): Promise<void> {
    const bytes = typeof content === "string" ? new TextEncoder().encode(content) : content;
    const files = this.#filesFor("write");
    if (files) {
      try {
        await withRateLimitRetry(() => files.upload(this.#vm, path, bytes), FILE_RETRY);
        this.#routeSeen();
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
    const files = this.#filesFor("read");
    if (files) {
      try {
        const info = await withRateLimitRetry(() => files.stat(this.#vm, path), FILE_RETRY);
        this.#routeSeen();
        // A 200 means a regular file with no symlink anywhere in its path.
        // HEAD carries no modification time, so mtime is left out (runcove-1cl10).
        const st: FileStat = { isFile: true, isDirectory: false, isSymbolicLink: false };
        if (Number.isFinite(info.size)) st.size = info.size;
        return st;
      } catch (err) {
        // A bare HEAD 404 on a server without the file route: ask the shell.
        if (!(isBare404(err) && (await this.#routeAbsent(files)))) {
          this.#fileFailure(err, "stat", "stat", path);
        }
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
      const files = this.#filesFor("read");
      if (files) {
        try {
          await withRateLimitRetry(() => files.stat(this.#vm, path), FILE_RETRY);
          this.#routeSeen();
          return true;
        } catch (err) {
          // 404 (file or, for a HEAD, possibly the VM: HEAD errors carry no
          // code, runcove-1cl10) reads as "not there", unless the server has
          // no file route at all, which the shell then answers for.
          if (fileErrorStatus(err)?.status === 404 && !(await this.#routeAbsent(files))) {
            return false;
          }
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

/** A 404 with no code: what a HEAD error (no body) or a missing route answers. */
function isBare404(err: unknown): boolean {
  const http = fileErrorStatus(err);
  return http?.status === 404 && http.code === undefined;
}

function withNote(stderr: string, note: string): string {
  const sep = stderr === "" || stderr.endsWith("\n") ? "" : "\n";
  return `${stderr}${sep}[flue-cove] ${note}\n`;
}

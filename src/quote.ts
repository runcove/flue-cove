/**
 * POSIX shell quoting for everything the adapter splices into a guest shell
 * script: paths and the working directory.
 */

/**
 * Single-quote `value` for a POSIX shell. Inside single quotes nothing is
 * special except the quote itself, which is closed, escaped and reopened
 * (`'` → `'\''`). Survives spaces, newlines, `$`, backticks and leading dashes
 * (callers still pass `--` before a path operand so a leading dash is not read
 * as an option).
 */
export function shellQuote(value: string): string {
  if (value.includes("\0")) {
    throw new TypeError("a shell argument cannot contain a NUL byte");
  }
  return `'${value.replaceAll("'", `'\\''`)}'`;
}

const ENV_NAME = /^[A-Za-z_][A-Za-z0-9_]*$/;

/** Throw a `TypeError` unless `name` is a portable shell variable name. */
export function validateEnvName(name: string): void {
  if (!ENV_NAME.test(name)) {
    throw new TypeError(
      `invalid environment variable name ${JSON.stringify(name)}: use letters, digits and underscores, not starting with a digit`,
    );
  }
}

export interface ScriptOptions {
  cwd?: string;
}

/**
 * The shell script that runs `command` with `cwd` as the working directory. A
 * failing `cd` skips the command and leaves `cd`'s non-zero status as the
 * script's exit code.
 *
 * It no longer takes `env`: values written into a script reach the guest as
 * part of an argv, where `ps` and `/proc/<pid>/cmdline` show them. The driver sends
 * them in the exec request's `env` field, the command's process environment.
 */
export function buildScript(command: string, opts: ScriptOptions = {}): string {
  if ("env" in opts) {
    throw new TypeError(
      "buildScript no longer takes env: pass it in the exec request's env field (CoveSandboxDriver.exec does)",
    );
  }
  const { cwd } = opts;
  if (cwd === undefined) return command;
  return `cd -- ${shellQuote(cwd)} && {\n${command}\n}`;
}

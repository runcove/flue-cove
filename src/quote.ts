/**
 * POSIX shell quoting for everything the adapter splices into a guest shell
 * script: paths, environment values, the working directory.
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
  env?: Record<string, string>;
}

/**
 * The shell script that runs `command` with `env` exported and `cwd` as the
 * working directory. A failing `cd` skips the command and leaves `cd`'s
 * non-zero status as the script's exit code.
 */
export function buildScript(command: string, { cwd, env }: ScriptOptions): string {
  const lines: string[] = [];
  for (const [name, value] of Object.entries(env ?? {})) {
    validateEnvName(name);
    lines.push(`export ${name}=${shellQuote(String(value))}`);
  }
  if (cwd !== undefined) {
    lines.push(`cd -- ${shellQuote(cwd)} && {\n${command}\n}`);
  } else {
    lines.push(command);
  }
  return lines.join("\n");
}

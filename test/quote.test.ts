import assert from "node:assert/strict";
import { execFileSync } from "node:child_process";
import { describe, it } from "node:test";
import { buildScript, shellQuote, validateEnvName } from "../src/quote.ts";

/** Run a script through the real POSIX shell, the way the guest does. */
function sh(script: string): string {
  return execFileSync("sh", ["-c", script], { encoding: "utf8" });
}

const NASTY = [
  "plain",
  "with space",
  "it's quoted",
  'double "quotes"',
  "new\nline",
  "-leading-dash",
  "--",
  "$HOME `id` $(id) \\ ; & | > <",
  "tab\there",
  "",
  "'",
  "''''",
  "ünïcødé ✓",
];

describe("shellQuote", () => {
  for (const value of NASTY) {
    it(`round-trips ${JSON.stringify(value)} through sh`, () => {
      assert.equal(sh(`printf %s ${shellQuote(value)}`), value);
    });
  }

  it("refuses a NUL byte, which no shell argument can carry", () => {
    assert.throws(() => shellQuote("a\0b"), /NUL/);
  });
});

describe("validateEnvName", () => {
  for (const ok of ["A", "_", "PATH", "my_var_2", "_X1"]) {
    it(`accepts ${ok}`, () => assert.doesNotThrow(() => validateEnvName(ok)));
  }
  for (const bad of ["", "1A", "A-B", "A B", "A=B", "A;rm", "Ä", "$X", "A\nB"]) {
    it(`rejects ${JSON.stringify(bad)}`, () =>
      assert.throws(() => validateEnvName(bad), TypeError));
  }
  it("names the bad variable without echoing values", () => {
    assert.throws(() => validateEnvName("A-B"), /invalid environment variable name "A-B"/);
  });
});

describe("buildScript", () => {
  it("runs the command unchanged when there is no cwd or env", () => {
    assert.equal(buildScript("echo hi", {}), "echo hi");
  });

  it("exports env with quoted values and cds with -- into the cwd", () => {
    const dir = sh("mktemp -d").trim();
    const weird = `${dir}/-dir with 'quote'\nand newline`;
    execFileSync("mkdir", ["--", weird]);
    const out = sh(
      buildScript('printf "%s|%s|%s" "$PWD" "$GREETING" "$EMPTY"', {
        cwd: weird,
        env: { GREETING: "it's $HOME `x`", EMPTY: "" },
      }),
    );
    assert.equal(out, `${weird}|it's $HOME \`x\`|`);
    execFileSync("rm", ["-r", "--", dir]);
  });

  it("does not run the command when cd fails", () => {
    const out = execFileSync(
      "sh",
      ["-c", `${buildScript("echo ran", { cwd: "/definitely/not/here" })}; echo "exit=$?"`],
      { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] },
    );
    assert.doesNotMatch(out, /ran/);
    assert.match(out, /exit=[1-9]/);
  });

  it("keeps a multi-line command intact", () => {
    assert.equal(sh(buildScript("a=1\nb=2\necho $((a+b))", {})), "3\n");
  });

  it("validates env names before building anything", () => {
    assert.throws(() => buildScript("true", { env: { "BAD NAME": "x" } }), TypeError);
  });
});

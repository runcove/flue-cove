/**
 * scripts/update-cove-sdk.ts: verification helpers, and the swap applied to a
 * copy of this repository's files, which `check-vendor.mjs` then accepts.
 */
import assert from "node:assert/strict";
import { execFileSync, spawnSync } from "node:child_process";
import {
  cpSync,
  existsSync,
  mkdirSync,
  mkdtempSync,
  readdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { after, describe, it } from "node:test";
import { fileURLToPath } from "node:url";
import {
  applyUpdate,
  artifactFrom,
  bumpVersion,
  packageJsonOf,
  RELEASE_ASSET,
  sha256,
  sumFor,
} from "../scripts/update-cove-sdk.ts";

const repo = fileURLToPath(new URL("..", import.meta.url));
const tmp = mkdtempSync(join(tmpdir(), "flue-cove-update-sdk-"));
after(() => rmSync(tmp, { recursive: true, force: true }));

const vendored = (): string => {
  const check = readFileSync(join(repo, "scripts/check-vendor.mjs"), "utf8");
  return check.match(/^const TARBALL = "([^"]+)";$/m)?.[1] ?? "";
};

/** An npm-style tarball holding only `package/package.json`. */
function fakeTarball(pkg: object, name: string): Uint8Array {
  const dir = mkdtempSync(join(tmp, "pkg-"));
  mkdirSync(join(dir, "package"));
  writeFileSync(join(dir, "package/package.json"), JSON.stringify(pkg));
  const out = join(tmp, name);
  execFileSync("tar", ["czf", out, "-C", dir, "package"]);
  return new Uint8Array(readFileSync(out));
}

/** A copy of the files the swap edits. */
function repoCopy(): string {
  const root = mkdtempSync(join(tmp, "repo-"));
  for (const f of [
    "package.json",
    "README.md",
    "CHANGELOG.md",
    "scripts/check-vendor.mjs",
    "vendor/README.md",
    vendored(),
    "examples/repo-agent/package-lock.json",
  ]) {
    cpSync(join(repo, f), join(root, f), { recursive: true });
  }
  return root;
}

describe("update-cove-sdk helpers", () => {
  it("reads the vendored tarball's package.json", () => {
    const pkg = packageJsonOf(new Uint8Array(readFileSync(join(repo, vendored()))));
    assert.equal(pkg.name, "@cove/sdk");
    assert.match(pkg.version ?? "", /^\d+\.\d+\.\d+$/);
  });

  it("sumFor finds exactly one line for the asset", () => {
    const a = "a".repeat(64);
    const text = `${"b".repeat(64)}  cove-server\n${a.toUpperCase()}  ${RELEASE_ASSET}\n`;
    assert.equal(sumFor(text, RELEASE_ASSET), a);
    assert.throws(() => sumFor("", RELEASE_ASSET), /0 times/);
    assert.throws(() => sumFor(`${a}  ${RELEASE_ASSET}\n${a}  ${RELEASE_ASSET}`, RELEASE_ASSET));
  });

  it("artifactFrom picks the one @cove/sdk npm artefact", () => {
    const npm = (version: string) => ({
      file: `cove-sdk-${version}.tgz`,
      kind: "npm",
      package: "@cove/sdk",
      version,
      sha256: "c".repeat(64),
      size: 1,
      url: `/public/sdk/cove-sdk-${version}.tgz`,
    });
    const wheel = { ...npm("0.5.0"), kind: "wheel", package: "cove-sdk" };
    assert.equal(artifactFrom({ artifacts: [wheel, npm("0.5.0")] }).version, "0.5.0");
    assert.throws(() => artifactFrom({ artifacts: [] }), /0 @cove\/sdk/);
    assert.throws(() => artifactFrom({ artifacts: [npm("0.5.0"), npm("0.6.0")] }), /--version/);
    assert.equal(
      artifactFrom({ artifacts: [npm("0.5.0"), npm("0.6.0")] }, "0.6.0").version,
      "0.6.0",
    );
    assert.throws(() => artifactFrom({ artifacts: [{ ...npm("0.5.0"), sha256: "x" }] }), /sha256/);
  });

  it("bumpVersion", () => {
    assert.equal(bumpVersion("0.3.0", "patch"), "0.3.1");
    assert.equal(bumpVersion("0.3.4", "minor"), "0.4.0");
    assert.throws(() => bumpVersion("0.3", "patch"));
  });
});

describe("applyUpdate", () => {
  it("swaps the tarball and every reference, and check-vendor accepts the result", () => {
    const root = repoCopy();
    const old = vendored();
    const bytes = fakeTarball({ name: "@cove/sdk", version: "9.8.7" }, "rel.tgz");
    const ourVersion = JSON.parse(readFileSync(join(root, "package.json"), "utf8")).version;
    const { file, from, to } = applyUpdate(root, {
      bytes,
      source: "release cove-server-v9.9.9",
      tag: "cove-server-v9.9.9",
      bump: "patch",
    });
    assert.equal(file, "vendor/cove-sdk-9.8.7.tgz");
    assert.equal(from, ourVersion);
    assert.equal(to, bumpVersion(ourVersion, "patch"));
    assert.deepEqual(
      readdirSync(join(root, "vendor")).filter((f) => f.endsWith(".tgz")),
      ["cove-sdk-9.8.7.tgz"],
    );
    const pkg = JSON.parse(readFileSync(join(root, "package.json"), "utf8"));
    assert.equal(pkg.version, to);
    assert.equal(pkg.dependencies["@cove/sdk"], `file:${file}`);
    const hash = sha256(bytes);
    const vendorReadme = readFileSync(join(root, "vendor/README.md"), "utf8");
    assert.match(vendorReadme, new RegExp(`\\| sha256 \\| \`${hash}\` \\|`));
    assert.match(vendorReadme, /cove-server-v9\.9\.9/);
    for (const f of ["README.md", "vendor/README.md", "examples/repo-agent/package-lock.json"]) {
      const text = readFileSync(join(root, f), "utf8");
      assert.ok(!text.includes(old.replace("vendor/", "")), `${f} still names ${old}`);
    }
    assert.ok(readFileSync(join(root, "README.md"), "utf8").includes(`flue-cove-${to}.tgz`));
    assert.match(
      readFileSync(join(root, "examples/repo-agent/package-lock.json"), "utf8"),
      new RegExp(`"node_modules/flue-cove": \\{\\s*"version": "${to.replaceAll(".", "\\.")}"`),
    );
    const changelog = readFileSync(join(root, "CHANGELOG.md"), "utf8");
    assert.ok(changelog.indexOf(`## [${to}]`) < changelog.indexOf(`## [${from}]`));
    assert.ok(changelog.includes(hash));
    const out = execFileSync(process.execPath, ["scripts/check-vendor.mjs"], {
      cwd: root,
      encoding: "utf8",
    });
    assert.match(out, /OK/);
  });

  it("refuses a tarball that is not @cove/sdk, or the one already vendored", () => {
    const root = repoCopy();
    const other = fakeTarball({ name: "left-pad", version: "1.0.0" }, "other.tgz");
    assert.throws(
      () => applyUpdate(root, { bytes: other, source: "x", bump: "patch" }),
      /not @cove\/sdk/,
    );
    const same = new Uint8Array(readFileSync(join(root, vendored())));
    assert.throws(
      () => applyUpdate(root, { bytes: same, source: "x", bump: "patch" }),
      /nothing to do/,
    );
    assert.ok(existsSync(join(root, vendored())), "the vendored tarball is untouched");
  });
});

describe("the command", () => {
  const script = join(repo, "scripts/update-cove-sdk.ts");
  const tgz = join(tmp, "cmd.tgz");
  fakeTarball({ name: "@cove/sdk", version: "9.8.7" }, "cmd.tgz");

  it("refuses a --file whose sha256 does not match, changing nothing", () => {
    const res = spawnSync(
      process.execPath,
      [script, "--file", tgz, "--expect-sha256", "0".repeat(64), "--dry-run"],
      { encoding: "utf8" },
    );
    assert.equal(res.status, 1);
    assert.match(res.stderr, /sha256 mismatch/);
  });

  it("refuses an unverified --file", () => {
    const res = spawnSync(process.execPath, [script, "--file", tgz], {
      encoding: "utf8",
    });
    assert.equal(res.status, 1);
    assert.match(res.stderr, /verify against/);
  });

  it("--dry-run verifies against a sha256.sum and reports the package", () => {
    const sums = join(tmp, "sha256.sum");
    writeFileSync(sums, `${sha256(new Uint8Array(readFileSync(tgz)))}  ${RELEASE_ASSET}\n`);
    const res = spawnSync(
      process.execPath,
      [script, "--file", tgz, "--sha256-sum", sums, "--dry-run"],
      { encoding: "utf8" },
    );
    assert.equal(res.status, 0, res.stderr);
    assert.match(res.stdout, /verified @cove\/sdk@9\.8\.7/);
  });
});

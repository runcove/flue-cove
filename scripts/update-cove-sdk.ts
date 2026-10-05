#!/usr/bin/env node
/**
 * Swap the vendored `@cove/sdk` tarball for a released one, verified.
 *
 * Sources (exactly one):
 *   --release <url>   A Cove release's download directory,
 *                     `https://<forge>/<owner>/<repo>/releases/download/<tag>`.
 *                     Fetches `cove-sdk-typescript.tgz` and checks it against the
 *                     release's `sha256.sum`. Set FORGE_TOKEN for a private
 *                     repository (sent as `Authorization: token …` over https
 *                     only, never printed). Redirects are not followed: a forge
 *                     that redirects its downloads needs --file instead.
 *   --server <url>    A Cove server's Warpgate-fronted URL. Reads
 *                     `/public/sdk/index.json`, takes the `@cove/sdk` npm
 *                     artefact (`--version` picks one when several are staged),
 *                     fetches it and checks its sha256 and size against the manifest.
 *   --file <path>     A tarball already on disk, checked against
 *                     `--sha256-sum <file>` (a release's `sha256.sum`),
 *                     `--index <file>` (a saved `index.json`) or `--expect-sha256`.
 *
 * Options:
 *   --expect-sha256 <hex>  Also require this sha256 (e.g. the release's
 *                          `cove_sdk_typescript_sha256` pin): two sources must agree.
 *   --bump patch|minor     How to bump flue-cove's version (default patch).
 *   --dry-run              Verify and report; change nothing.
 *   --no-install           Skip `npm install` (the lockfile is then stale).
 *   --root <dir>           The repository to update (default: this script's).
 *
 * Then: vendor/cove-sdk-<version>.tgz replaces the old tarball; package.json,
 * scripts/check-vendor.mjs, vendor/README.md, README.md, CHANGELOG.md and the
 * example's lockfile are updated; `npm install` refreshes package-lock.json and
 * `npm run check:vendor` runs. Typecheck, tests and the live check stay with you.
 *
 *   node scripts/update-cove-sdk.ts --release https://<forge>/runcove/cove/releases/download/cove-server-v0.34.0
 */
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { existsSync, readdirSync, readFileSync, unlinkSync, writeFileSync } from "node:fs";
import { basename, join, resolve } from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
import { parseArgs } from "node:util";
import { gunzipSync } from "node:zlib";

/** The SDK's file name among a release's assets. */
export const RELEASE_ASSET = "cove-sdk-typescript.tgz";
const SHA256 = /^[0-9a-f]{64}$/;

export const sha256 = (bytes: Uint8Array): string =>
  createHash("sha256").update(bytes).digest("hex");

/** The sha256 that a `sha256.sum` (`<hex>  <file>` per line) records for `file`. */
export function sumFor(sumText: string, file: string): string {
  const hits = sumText
    .split("\n")
    .map((line) => line.trim().match(/^([0-9a-fA-F]{64})\s+\*?(.+)$/))
    .filter((m): m is RegExpMatchArray => m !== null && m[2] === file);
  if (hits.length !== 1) {
    throw new Error(`sha256.sum lists ${file} ${hits.length} times, expected once`);
  }
  return (hits[0]?.[1] ?? "").toLowerCase();
}

export interface ManifestArtifact {
  file: string;
  kind: string;
  package: string;
  version: string;
  sha256: string;
  size: number;
  url: string;
}

/** The one `@cove/sdk` npm artefact in a server's `index.json` (of `version`, if given). */
export function artifactFrom(index: unknown, version?: string): ManifestArtifact {
  const all = (index as { artifacts?: unknown } | null)?.artifacts;
  if (!Array.isArray(all)) throw new Error("index.json has no artifacts list");
  const npm = (all as ManifestArtifact[]).filter(
    (a) =>
      a?.package === "@cove/sdk" &&
      a.kind === "npm" &&
      (version === undefined || a.version === version),
  );
  if (npm.length !== 1) {
    const which = version ? ` version ${version}` : "";
    throw new Error(
      `index.json lists ${npm.length} @cove/sdk npm artefacts${which}; ` +
        (npm.length > 1 ? "pick one with --version" : "is the SDK staged on that server?"),
    );
  }
  const a = npm[0] as ManifestArtifact;
  if (!SHA256.test(a.sha256 ?? "")) throw new Error(`index.json gives ${a.file} no valid sha256`);
  return a;
}

/** `package/package.json` from an npm tarball (gzip'd ustar). */
export function packageJsonOf(tgz: Uint8Array): { name?: string; version?: string } {
  const tar = gunzipSync(tgz);
  let off = 0;
  let longName: string | undefined;
  while (off + 512 <= tar.length) {
    const header = tar.subarray(off, off + 512);
    if (header.every((b) => b === 0)) break;
    const field = (start: number, len: number) =>
      header
        .subarray(start, start + len)
        .toString("utf8")
        .replace(/\0.*$/s, "");
    const size = Number.parseInt(field(124, 12).trim() || "0", 8);
    const type = field(156, 1);
    const prefix = field(345, 155);
    let name = longName ?? (prefix ? `${prefix}/${field(0, 100)}` : field(0, 100));
    longName = undefined;
    const body = tar.subarray(off + 512, off + 512 + size);
    off += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = body.toString("utf8").replace(/\0.*$/s, "");
      continue;
    }
    name = name.replace(/^\.\//, "");
    if ((type === "0" || type === "") && name === "package/package.json") {
      return JSON.parse(body.toString("utf8"));
    }
  }
  throw new Error("the tarball has no package/package.json");
}

export function bumpVersion(version: string, bump: "patch" | "minor"): string {
  const m = version.match(/^(\d+)\.(\d+)\.(\d+)$/);
  if (!m) throw new Error(`cannot bump version ${version}`);
  const [maj, min, pat] = [Number(m[1]), Number(m[2]), Number(m[3])];
  return bump === "minor" ? `${maj}.${min + 1}.0` : `${maj}.${min}.${pat + 1}`;
}

export interface Update {
  /** The verified tarball. */
  bytes: Uint8Array;
  /** Where it came from, for vendor/README.md and the CHANGELOG (no credentials). */
  source: string;
  /** The release tag, when known. */
  tag?: string;
  bump: "patch" | "minor";
}

/**
 * Apply a verified tarball to the repository at `root`. Returns what changed.
 * Refuses a tarball that is not `@cove/sdk`, one already vendored, and a
 * repository whose files are not as expected. Every file is read and every
 * edit computed and checked first; nothing is written until all of them
 * succeed, so a refusal leaves the repository untouched.
 */
export function applyUpdate(root: string, up: Update): { file: string; from: string; to: string } {
  const at = (p: string) => join(root, p);
  const pkg = packageJsonOf(up.bytes);
  if (pkg.name !== "@cove/sdk" || typeof pkg.version !== "string") {
    throw new Error(`the tarball is ${pkg.name}@${pkg.version}, not @cove/sdk`);
  }
  const hash = sha256(up.bytes);
  const file = `vendor/cove-sdk-${pkg.version}.tgz`;

  const check = readFileSync(at("scripts/check-vendor.mjs"), "utf8");
  const oldFile = check.match(/^const TARBALL = "([^"]+)";$/m)?.[1];
  const oldHash = check.match(/^const EXPECTED_SHA256 = "([0-9a-f]{64})";$/m)?.[1];
  if (!oldFile || !oldHash) throw new Error("scripts/check-vendor.mjs constants not found");
  if (oldHash === hash) throw new Error(`${oldFile} already has sha256 ${hash}: nothing to do`);
  if (file !== oldFile && existsSync(at(file))) {
    throw new Error(`${file} exists already and is not the vendored tarball; remove it first`);
  }
  const oldName = basename(oldFile);
  const name = basename(file);
  /** Every file to write, by path relative to `root`, computed before any write. */
  const writes = new Map<string, string>();

  // package.json: the dependency and the version.
  const pkgText = readFileSync(at("package.json"), "utf8");
  const ours = JSON.parse(pkgText) as { version: string; dependencies?: Record<string, string> };
  const from = ours.version;
  const to = bumpVersion(from, up.bump);
  if (ours.dependencies?.["@cove/sdk"] !== `file:${oldFile}`) {
    throw new Error(`package.json does not depend on file:${oldFile}`);
  }
  if (!/^ {2}"version": "[^"]+",$/m.test(pkgText)) {
    throw new Error("package.json has no top-level version line");
  }
  writes.set(
    "package.json",
    pkgText
      .replace(`"file:${oldFile}"`, `"file:${file}"`)
      .replace(/^ {2}"version": "[^"]+",$/m, `  "version": "${to}",`),
  );

  // scripts/check-vendor.mjs.
  writes.set(
    "scripts/check-vendor.mjs",
    check
      .replace(/^const TARBALL = "[^"]+";$/m, `const TARBALL = "${file}";`)
      .replace(/^const EXPECTED_SHA256 = "[^"]+";$/m, `const EXPECTED_SHA256 = "${hash}";`),
  );

  // vendor/README.md: the table rows.
  const row = (text: string, key: string, value: string) => {
    const re = new RegExp(`^\\| ${key} \\|.*\\|$`, "m");
    if (!re.test(text)) throw new Error(`vendor/README.md has no "${key}" row`);
    return text.replace(re, `| ${key} | ${value} |`);
  };
  let vendorReadme = readFileSync(at("vendor/README.md"), "utf8");
  vendorReadme = row(vendorReadme, "File", `\`${name}\``);
  vendorReadme = row(vendorReadme, "Package", `\`@cove/sdk\` ${pkg.version}`);
  vendorReadme = row(
    vendorReadme,
    "Built from",
    up.tag
      ? `the Cove release \`${up.tag}\` (its \`${RELEASE_ASSET}\`), as released`
      : `a released Cove SDK (${up.source})`,
  );
  vendorReadme = row(vendorReadme, "Built with", "the Cove release pipeline (`npm pack`)");
  vendorReadme = row(vendorReadme, "sha256", `\`${hash}\``);
  writes.set("vendor/README.md", vendorReadme.split(oldName).join(name));

  // README.md: the vendored file's name and the packed tarball's name.
  writes.set(
    "README.md",
    readFileSync(at("README.md"), "utf8")
      .split(oldName)
      .join(name)
      .split(`flue-cove-${from}.tgz`)
      .join(`flue-cove-${to}.tgz`),
  );

  // The example's lockfile: the dependency, flue-cove's version and the
  // bundled SDK's version.
  const exampleLock = "examples/repo-agent/package-lock.json";
  if (existsSync(at(exampleLock))) {
    writes.set(
      exampleLock,
      readFileSync(at(exampleLock), "utf8")
        .split(`file:${oldFile}`)
        .join(`file:${file}`)
        .replace(
          /("node_modules\/flue-cove": \{\s*"version": )"[^"]+"/,
          (_m, head: string) => `${head}"${to}"`,
        )
        .replace(
          /("node_modules\/flue-cove\/node_modules\/@cove\/sdk": \{\s*"version": )"[^"]+"/,
          (_m, head: string) => `${head}"${pkg.version}"`,
        ),
    );
  }

  // CHANGELOG.md: a new section above the newest release, below any
  // `## [Unreleased]` section.
  const changelog = readFileSync(at("CHANGELOG.md"), "utf8");
  const sections = [...changelog.matchAll(/^## \[([^\]]+)\]/gm)];
  const newest = sections.find((m) => m[1]?.toLowerCase() !== "unreleased");
  if (!newest || newest.index === undefined) {
    throw new Error("CHANGELOG.md has no release section");
  }
  const what = up.tag ? `from the Cove release \`${up.tag}\`` : `released by Cove (${up.source})`;
  const entry = [
    `## [${to}]`,
    "",
    "### Changed",
    "",
    `- The vendored SDK is the released \`@cove/sdk\` ${pkg.version} ${what}, in`,
    `  place of a build from Cove's main branch: \`vendor/${name}\`, sha256`,
    `  \`${hash}\`.`,
    "",
  ].join("\n");
  writes.set(
    "CHANGELOG.md",
    `${changelog.slice(0, newest.index)}${entry}\n${changelog.slice(newest.index)}`,
  );

  // Everything checked: write. The new tarball first, then the old one goes.
  writeFileSync(at(file), up.bytes);
  for (const f of readdirSync(at("vendor"))) {
    if (/^cove-sdk-.*\.tgz$/.test(f) && f !== name) unlinkSync(at(`vendor/${f}`));
  }
  for (const [path, text] of writes) writeFileSync(at(path), text);
  return { file, from, to };
}

// ─── fetching and verifying ────────────────────────────────────────────────

export async function get(url: string, token?: string): Promise<Uint8Array> {
  const headers: Record<string, string> = {};
  if (token) {
    if (new URL(url).protocol !== "https:") {
      throw new Error(`refusing to send FORGE_TOKEN to ${url}: not https`);
    }
    headers.authorization = `token ${token}`;
  }
  // Never follow a redirect: it could carry the token elsewhere, and a login
  // page is not the asset.
  const res = await fetch(url, { headers, redirect: "manual" });
  if (res.status >= 300 && res.status < 400) {
    throw new Error(
      `GET ${url} answered ${res.status} (a redirect, not followed). ` +
        "Download the files yourself and use --file with --sha256-sum.",
    );
  }
  if (res.status !== 200) throw new Error(`GET ${url} answered ${res.status}, expected 200`);
  return new Uint8Array(await res.arrayBuffer());
}

function requireHash(what: string, actual: string, expected: string): void {
  if (actual !== expected.toLowerCase()) {
    throw new Error(`sha256 mismatch for ${what}: got ${actual}, expected ${expected}`);
  }
}

async function main(): Promise<void> {
  const { values } = parseArgs({
    options: {
      release: { type: "string" },
      server: { type: "string" },
      file: { type: "string" },
      "sha256-sum": { type: "string" },
      index: { type: "string" },
      version: { type: "string" },
      "expect-sha256": { type: "string" },
      bump: { type: "string", default: "patch" },
      "dry-run": { type: "boolean", default: false },
      "no-install": { type: "boolean", default: false },
      root: { type: "string" },
      help: { type: "boolean", default: false },
    },
  });
  if (values.help) {
    console.log(readFileSync(new URL(import.meta.url), "utf8").split("*/")[0]);
    return;
  }
  const sources = [values.release, values.server, values.file].filter(Boolean);
  if (sources.length !== 1) throw new Error("give exactly one of --release, --server, --file");
  if (values.bump !== "patch" && values.bump !== "minor") {
    throw new Error("--bump is patch or minor");
  }
  const expect = values["expect-sha256"]?.toLowerCase();
  if (expect !== undefined && !SHA256.test(expect)) throw new Error("--expect-sha256 is 64 hex");

  let bytes: Uint8Array;
  let source: string;
  let tag: string | undefined;
  let verified = false;

  if (values.release) {
    const base = values.release.replace(/\/+$/, "");
    tag = base.split("/").pop();
    const token = process.env.FORGE_TOKEN || undefined;
    const sums = new TextDecoder().decode(await get(`${base}/sha256.sum`, token));
    bytes = await get(`${base}/${RELEASE_ASSET}`, token);
    requireHash(`${RELEASE_ASSET} (sha256.sum)`, sha256(bytes), sumFor(sums, RELEASE_ASSET));
    source = `release ${tag}`;
    verified = true;
  } else if (values.server) {
    const indexUrl = new URL("/public/sdk/index.json", values.server).href;
    const index = JSON.parse(new TextDecoder().decode(await get(indexUrl)));
    const a = artifactFrom(index, values.version);
    bytes = await get(new URL(a.url, indexUrl).href);
    requireHash(`${a.file} (index.json)`, sha256(bytes), a.sha256);
    if (bytes.byteLength !== a.size) {
      throw new Error(`${a.file} is ${bytes.byteLength} bytes; index.json says ${a.size}`);
    }
    source = `served as ${a.file}`;
    verified = true;
  } else {
    const path = resolve(values.file as string);
    bytes = new Uint8Array(readFileSync(path));
    source = basename(path);
    if (values["sha256-sum"]) {
      const sums = readFileSync(values["sha256-sum"], "utf8");
      requireHash(`${source} (sha256.sum)`, sha256(bytes), sumFor(sums, RELEASE_ASSET));
      verified = true;
    }
    if (values.index) {
      const a = artifactFrom(JSON.parse(readFileSync(values.index, "utf8")), values.version);
      requireHash(`${source} (index.json)`, sha256(bytes), a.sha256);
      verified = true;
    }
  }
  if (expect !== undefined) {
    requireHash("the tarball (--expect-sha256)", sha256(bytes), expect);
    verified = true;
  }
  if (!verified) {
    throw new Error("--file needs --sha256-sum, --index or --expect-sha256 to verify against");
  }

  const pkg = packageJsonOf(bytes);
  console.log(`verified ${pkg.name}@${pkg.version} sha256 ${sha256(bytes)} (${source})`);
  if (values["dry-run"]) return;

  const root = values.root ? resolve(values.root) : fileURLToPath(new URL("..", import.meta.url));
  const up: Update = { bytes, source, bump: values.bump };
  if (tag !== undefined) up.tag = tag;
  const { file, from, to } = applyUpdate(root, up);
  console.log(`vendored ${file}; flue-cove ${from} -> ${to}`);
  if (!values["no-install"]) {
    execFileSync("npm", ["install", "--no-audit", "--no-fund"], { cwd: root, stdio: "inherit" });
    execFileSync("npm", ["run", "check:vendor"], { cwd: root, stdio: "inherit" });
  }
  console.log(
    "next: npm run typecheck && npm run lint && npm test, the integration test against a live server, review the CHANGELOG entry, commit",
  );
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err: unknown) => {
    console.error(`update-cove-sdk: ${err instanceof Error ? err.message : String(err)}`);
    process.exit(1);
  });
}

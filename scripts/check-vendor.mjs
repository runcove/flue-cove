#!/usr/bin/env node
// Verify the vendored @cove/sdk tarball is the one recorded in vendor/README.md,
// and that package.json depends on exactly that file.
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

const TARBALL = "vendor/cove-sdk-0.4.0-bde79e4.tgz";
const EXPECTED_SHA256 = "25b0e618e9a2f98cbfb802c9f2e4045564153a1adf0150ac279c2b6bcdcaad5e";

let failed = false;
const fail = (msg) => {
  console.error(`check:vendor: ${msg}`);
  failed = true;
};

const actual = createHash("sha256").update(readFileSync(TARBALL)).digest("hex");
if (actual !== EXPECTED_SHA256) fail(`${TARBALL} sha256 is ${actual}, expected ${EXPECTED_SHA256}`);

const readme = readFileSync("vendor/README.md", "utf8");
if (!readme.includes(EXPECTED_SHA256)) fail("vendor/README.md does not record the expected sha256");

const pkg = JSON.parse(readFileSync("package.json", "utf8"));
if (pkg.dependencies?.["@cove/sdk"] !== `file:${TARBALL}`) {
  fail(`package.json must depend on "@cove/sdk": "file:${TARBALL}"`);
}

if (failed) process.exit(1);
console.log(`check:vendor: ${TARBALL} sha256 ${actual} OK`);

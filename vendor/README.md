# Vendored `@cove/sdk`

`@cove/sdk` is not published to a public registry, so this repository carries
the exact tarball it builds and tests against.

| | |
|---|---|
| File | `cove-sdk-0.4.0-bde79e4.tgz` |
| Package | `@cove/sdk` 0.4.0 (API version 6) |
| Built from | `sdk/typescript` in the Cove repository at commit `bde79e442a7e61f27411f8ba5ea70eab8368dd6b` (main, after the last tagged release): file-transfer methods (`client.vms.files`), `CoveTimeoutError` and `CoveConfigError`, `Retry-After` on 429 and 5xx (`retryAfterSecs`), HEAD error codes from `X-Cove-Error-Code`, `stat`'s `mtime` from `Last-Modified`, an upload source's own error surfaced, and `fetch` bound to `globalThis` |
| Built with | `npm ci`, then `npm pack` (its `prepack` runs the SDK's own build) |
| sha256 | `25b0e618e9a2f98cbfb802c9f2e4045564153a1adf0150ac279c2b6bcdcaad5e` |

**Why the file name carries a commit.** Between Cove releases the SDK's
version string stays put: tarballs built from different commits on main are
all `@cove/sdk` 0.4.0 and differ (an older one has no `client.vms.files`).
A released SDK needs no suffix: each Cove release whose SDK changed gives it
a new version, so its version names one set of bytes. `npm pack` names both `cove-sdk-0.4.0.tgz`, so the
vendored file is renamed with the short commit it was built from. Keep that
suffix whenever the version string alone does not identify the bytes.

`package.json` depends on it as
`"@cove/sdk": "file:vendor/cove-sdk-0.4.0-bde79e4.tgz"`, the lockfile records
its integrity hash, and `npm run check:vendor` (run in CI) fails if the file's
sha256 differs from the one above. `bundleDependencies` puts the SDK inside a
packed `flue-cove` tarball, so a consumer installing that tarball needs no
access to the Cove repository.

Why a vendored file and not a URL: a Cove server publishes its SDK only on its
own host, which CI cannot reach, and a URL would put a deployment's hostname
into `package.json` and the lockfile.

The SDK reads what the server sends; it does not add server features. The
file API itself is a server feature that is newer than the last tagged release, `cove-server`
0.33.2: that tag has no file routes. A server needs a build that includes
Cove commit `537fb91a3` (the file-transfer endpoints), or the first release
after 0.33.2. Such a build may still report its version as 0.33.2, so the
version string does not tell. Against an older server the adapter detects
the missing route and moves all file content over exec (see the main
README). A HEAD error's code (`X-Cove-Error-Code`) and `stat`'s modification
time (`Last-Modified`) need a server that includes Cove commit `03cbc7539`;
from an older one, HEAD errors carry no code and `stat` over the file API has
no `mtime`, which the adapter handles as before.

## Upgrading

To a released SDK: `npm run update:cove-sdk` (see "Moving to a released Cove
SDK" in the main README) verifies the tarball and does all of the steps
below. To a build from a Cove commit, by hand:

1. In a Cove checkout at the commit you want:
   `cd sdk/typescript && npm ci && npm pack`.
2. Copy the new tarball here as `cove-sdk-<version>-<short commit>.tgz` and
   delete the old one.
3. Update `package.json` (`"@cove/sdk": "file:vendor/<that file>"`), the
   example's lockfile entry (`examples/repo-agent/package-lock.json`), the
   table above and the two constants at the top of `scripts/check-vendor.mjs`.
4. `npm install`, then `npm run check:vendor && npm run typecheck && npm test`,
   and run the integration test against a live server.

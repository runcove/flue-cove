# Vendored `@cove/sdk`

`@cove/sdk` is not published to a public registry, so this repository carries
the exact tarball it builds and tests against.

| | |
|---|---|
| File | `cove-sdk-0.4.0-cb09494.tgz` |
| Package | `@cove/sdk` 0.4.0 (API version 6) |
| Built from | `sdk/typescript` in the Cove repository at commit `cb094949d2e56e0c97c6c07b83aaddd2b1e78fde`, the first SDK with file-transfer methods (`client.vms.files`) |
| Built with | `npm pack` (its `prepack` runs the SDK's own build) |
| sha256 | `731e8df2865f9b34870185722713a2757b5217bc845b0cccf3159cb996ddce25` |

**Why the file name carries a commit.** The SDK's version string did not change
when it gained the file methods: an older tarball, also `@cove/sdk` 0.4.0, has
no `client.vms.files`. `npm pack` names both `cove-sdk-0.4.0.tgz`, so the
vendored file is renamed with the short commit it was built from. Keep that
suffix whenever the version string alone does not identify the bytes.

`package.json` depends on it as
`"@cove/sdk": "file:vendor/cove-sdk-0.4.0-cb09494.tgz"`, the lockfile records
its integrity hash, and `npm run check:vendor` (run in CI) fails if the file's
sha256 differs from the one above. `bundleDependencies` puts the SDK inside a
packed `flue-cove` tarball, so a consumer installing that tarball needs no
access to the Cove repository.

Why a vendored file and not a URL: a Cove server publishes its SDK only on its
own host, which CI cannot reach, and a URL would put a deployment's hostname
into `package.json` and the lockfile.

The file API itself is served by Cove servers from 0.33.2 (API version 6); the
SDK commit above adds only the client methods for it.

## Upgrading

1. In a Cove checkout at the commit you want:
   `cd sdk/typescript && npm ci && npm pack`.
2. Copy the new tarball here as `cove-sdk-<version>-<short commit>.tgz` and
   delete the old one.
3. Update `package.json` (`"@cove/sdk": "file:vendor/<that file>"`), the
   example's lockfile entry (`examples/repo-agent/package-lock.json`), the
   table above and the two constants at the top of `scripts/check-vendor.mjs`.
4. `npm install`, then `npm run check:vendor && npm run typecheck && npm test`,
   and run the integration test against a live server.

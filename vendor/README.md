# Vendored `@cove/sdk`

`@cove/sdk` is not published to a public registry, so this repository carries
the exact tarball it builds and tests against.

| | |
|---|---|
| File | `cove-sdk-0.4.0.tgz` |
| Package | `@cove/sdk` 0.4.0 |
| Built from | `sdk/typescript` in the Cove repository, at the commit a Cove 0.33.2 server runs (API version 6) |
| Built with | `npm pack` (its `prepack` runs the SDK's own build) |
| sha256 | `b9f959cc908a08674bbe3c0af61acd9ad2effe748861d2f6b336c3b9d665ca8e` |

`package.json` depends on it as `"@cove/sdk": "file:vendor/cove-sdk-0.4.0.tgz"`,
the lockfile records its integrity hash, and `npm run check:vendor` (run in CI)
fails if the file's sha256 differs from the one above. `bundleDependencies`
puts the SDK inside a packed `flue-cove` tarball, so a consumer installing that
tarball needs no access to the Cove repository.

Why a vendored file and not a URL: a Cove server publishes its SDK only on its
own host, which CI cannot reach, and a URL would put a deployment's hostname
into `package.json` and the lockfile.

## Upgrading

1. In a Cove checkout at the commit your servers run:
   `cd sdk/typescript && npm ci && npm pack`.
2. Copy the new `cove-sdk-<version>.tgz` here and delete the old one.
3. Update `package.json` (`"@cove/sdk": "file:vendor/cove-sdk-<version>.tgz"`),
   the table above and the two constants at the top of
   `scripts/check-vendor.mjs`.
4. `npm install`, then `npm run check:vendor && npm run typecheck && npm test`,
   and run the integration test against a server on that version.
5. When the new SDK ships file-transfer methods, replace the fetch client in
   `src/files.ts` with a wrapper over them (see the note at the top of that file).

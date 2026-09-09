# Runtime package authoring

Use Node 22.23.1 with npm 10.9.8 to install source dependencies, build and
pack the runtime. The repository `.npmrc` selects npm's supported nested
installation strategy. Keep this setting during lock maintenance and `npm ci`.

```powershell
node --version
npm --version
npm ci
npm run typecheck
npm run build
npm pack
```

Build the dashboard separately from its own lockfile before a complete release
package; never reuse an unidentified dashboard output directory. Do not invoke
publication scripts during local package acceptance.

The selected production dependency roots remain bundled so their security-fixed
transitive resolutions travel with the artifact. Root overrides are authoring
constraints, not a promise that a customer's npm will apply them. Keep actual
caller-resolution and clean-tarball installation tests for all supported customer
toolchains. Native SQLite remains unbundled and must install for the customer's
Node ABI.

The default hoisted npm10 resolver can repeatedly replace an overridden shared
dependency when traversing bundled roots. A minimal example is Express 4.22.2
bundled with body-parser 1.20.6 and qs >=6.16.0 overrides. Nested installation
avoids that resolver loop without removing the fixed versions or editing
dependency manifests.

npm12 authoring rejects bundled trees affected by root overrides with
`EBUNDLEOVERRIDE`. It is not the supported authoring toolchain. Installing an
already packed tarball is a separate operation and requires its own compatibility
probe; authoring failure must not be mislabeled as a runtime failure or universal
consumer support. A shrinkwrap alone is not a substitute: clean installs of a
probe changed the intended transitive resolutions.

npm12 also blocks unapproved dependency lifecycle scripts by default. A successful
install exit alone does not prove that native SQLite was built. Review its
`npm install-scripts ls` output and approve only the exact required package
identities through the consuming project's supported policy, then verify native
loading and the actual runtime. Do not use a blanket script-policy bypass.
The established npm10 consumer path remains the supported baseline; npm12 is a
separate compatibility probe, not a universal out-of-the-box support claim.

## EPUB input contract

EPUB ingestion projects local UTF-8 XHTML/SVG spine chapters in order, retaining
the existing text, word-count, page-count, format and file-size result fields.
It does not extract archive entries to disk or fetch external resources. Invalid,
encrypted, unsupported or over-budget input now fails explicitly instead of
silently omitting an unreadable chapter and reporting partial success. Limits:
256 MiB archive, 4,096 entries, 16 MiB per entry, 128 MiB total decompressed
content, and 2 MiB metadata documents. Metadata DTD/custom entity declarations
and archive path/link escapes are rejected. This is a bounded text reader, not
a general EPUB renderer or DRM reader.

Desktop runtime assembly must consume the exact tested tarball, perform a fresh
production installation using its supported toolchain, retain required notices,
and inventory/hash the actual resulting files. Existing desktop runtime caches
do not certify changed package bytes.

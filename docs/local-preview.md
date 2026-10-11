# Versioned local preview

The preview packages the buildless HTML/JavaScript application, its Node 20+ runtime CLIs and a generated mathematical example. It requires no `npm install` or application build. It is a **local evaluation artifact**, not a licensed public release: project-license selection and hosted CI are still outstanding. Laboratory and downloaded instrument measurements are excluded.

## Build

```sh
mkdir -p dist
npm run preview:package -- --out dist/local-preview-agents-0.1.0
```

The parent directory must exist and the destination must be new. The builder refuses an existing destination instead of merging or overwriting it. It writes `afm-dashboard-0.1.0-preview.tar` and its `.sha256` sidecar. Version comes from `package.json`; no Git metadata, credentials, user environment files or runtime dependency directories are copied.

The uncompressed POSIX archive uses sorted paths, fixed permissions, zero ownership IDs and zero timestamps. Generated recipe metadata uses `2000-01-01T00:00:00.000Z` and `afm-preview-fixture-v1` to describe the fixture producer, not an actual laboratory run time. Repeated builds of unchanged inputs produce identical bytes. The numerical engine and reader source files are copied byte-for-byte.

## Verify and run from a clean directory

```sh
cd dist/local-preview-agents-0.1.0
sha256sum -c afm-dashboard-0.1.0-preview.tar.sha256
mkdir extracted
tar -xf afm-dashboard-0.1.0-preview.tar -C extracted
cd extracted/afm-dashboard-0.1.0-preview
node scripts/verify-preview.mjs
node scripts/serve.mjs
```

Use another `PORT` if the default 4173 demo is already running. The server binds loopback only. Open `/web/` on that port. The included README explains the browser and CLI workflows, optional model configuration, support limits and synthetic replay.

The verifier checks the exact file inventory and SHA-256/byte length of every entry before importing packaged analysis modules. It rejects missing/extra files, unexpected directories, symlinks, unsafe paths and malformed manifests. It then checks all four format-specific engine identities, calibration/units, every expected synthetic pixel, known statistics, and strict legacy/portable recipe replay. It writes nothing to the package; keep analysis exports outside it. Checksums provide integrity evidence, not author authentication or a license grant.

The current snapshot includes autonomous/help modes, provider presets, pilot SOPs, a structured Documentation guide with two synthetic screenshots, and interactive measurement readouts. Clean-install browser checks also load the guide and both screenshots. Earlier preview archives remain unchanged.

## Generated example

`data/synthetic-step.gwy` is a 16×16 image covering 8×8 µm with metre units. At zero-based pixel `(x,y)`, height is `1e-9 * (x + 2*y + (x >= 8 ? 5 : 0))` metres. The mean is 25 nm, range 0–50 nm and area 64 µm². Metadata labels it as a generated mathematical demonstration. The generator source is included.

The two saved recipes perform mean subtraction. The browser loads only this example from its synthetic-only manifest. The original chemist-specific preset stays disabled unless the user separately imports its exact original file/hash. No bundled example establishes instrument compatibility; the unchanged format/configuration gates and warnings remain active.

## Validation — 2026-10-11

- **374 tests pass**, including deterministic builds, independent system-tar extraction, overwrite refusal, synthetic-only inventory, hash-before-import checks, strict replay and changed-pixel rejection even when mean/extrema are preserved.
- Chromium **151.0.7922.34**, Firefox **141.0** and WebKit **26.0** each passed `tests/browser-preview.mjs` against a freshly extracted package. They verified initial synthetic loading/calibration, disabled chemist preset, strict original replay, portable recipe loading/saving, no laboratory requests, no console errors and unchanged package hashes after use.
- All three builds produced archive SHA-256 `2f787d7bebf1ae1ffe61abd488fda7bf5903d33aea645a5267d9676c0a08b11f`, with 80 inventory entries plus the manifest.
- Source SHA-256: `070d5511c2b04a14a98dc9f9a5f720bc08b0c2e5b8f25a7cd403453698cd1f19`.
- Mean-subtracted output SHA-256: `4a6764893b4045be3131c691650e533b9b6ec27da81dcf9a3e47706ee883b61c`.

The browser test owns an isolated server (`AFM_PREVIEW_PORT`, default 4182; 4173 is refused), extracts under a unique temporary directory and cleans up its own files/processes. It accepts the same Playwright engine/executable environment variables as [browser CI](browser-ci.md). CI now includes this test in each engine job; actual hosted execution remains unverified because this checkout has no Git remote.

## Public release gates

Before publishing, resolve the application license/copyright holder, choose a remote repository, and run hosted CI. Any future redistribution of real measurements needs explicit rights; this preview excludes them. Actual screen-reader navigation and remaining incomplete accessibility findings are still under review. Force spectroscopy still needs representative data, calibration and agreed models. No release or external upload has been performed.

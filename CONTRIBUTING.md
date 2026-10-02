# Contributing

Asset Studio is a local Windows/macOS desktop application. Preserve the module ownership and shared contract boundaries described in [architecture](docs/architecture.md). Changes to contracts, migrations, native commands and cross-module behavior need coordinator/reviewer approval. Avoid unrelated file changes and preserve user originals.

Use Node 24, Rust 1.99.0 stable and platform build prerequisites. Run `npm ci`, `npm run typecheck`, `npm test`, `npm run build` and `cargo test --workspace`. For UI work run `npx playwright test`; for native/output work run the corresponding smoke and independent artifact checks in [verification](docs/verification.md).

The public website is in `apps/site`. Use `npm run site:dev` and `npm run site:build`; Vercel uses the root `vercel.json` to publish only its static output. Keep downloadable binaries in GitHub Releases, not in source commits. Release sizes, checksums and support claims must match the published artifact and its verification record.

Add meaningful acceptance coverage for exported artifacts, persistence, recovery, security boundaries or behavior that changed. Fixture/mock tests are welcome in ordinary CI but are not live-provider proof. New provider adapters must document official support, auth, model identity, capabilities, limits, licenses and actual artifact receipts. Never quietly fall back to a paid API or another model.

Keep Korean UI strings in the localization structure and consider Ctrl/Cmd plus keyboard navigation. Do not expose credentials in patches, project files or test logs. Network/executable/model downloads must state source, exact version, size, checksum, license and obtain the user's consent when required. Generated code is not a permissible imported asset execution path.

The core uses Apache-2.0. Blender worker contributions use the separate GPL-3.0-or-later license in `workers/blender`. Preserve copyright/license notices and document new dependency and asset rights. Pull requests should identify actual checks and unverified platforms; publishing, signing and release upload are separate authorized actions.

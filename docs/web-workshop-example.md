# Treeset playable workshop example

2026-10-08 · developer-made web example · Asset Studio desktop/npm versions remain 0.1.13.

## Public entry points

- Korean: https://treeset.win/play/workshop/
- English: https://treeset.win/play/workshop/en/
- Production story: https://treeset.win/devlog/workshop/
- Editable sample bundle: https://treeset.win/examples/workshop-starter.zip

## Behavior

The user moves a small robot and brings three cells to the workbench. The goal button finds a route around solid props; keyboard, on-screen direction buttons and floor clicks remain available. Picking up and delivering remain explicit actions. The scene can be rearranged, rotated, saved as a new JSON file and reopened. PNG capture saves a new image. Layout storage uses the separate `treeset.workshop.layout.v1` key.

## Asset provenance

The three GLBs are the exact original Windows local procedural Blender outputs under `apps/site/public/examples/local-prop-kit`. Each is fetched from the same site and checked against its native byte count and SHA-256 before loading. They keep metre scale, Y-up and bottom-centre pivots. Together they contain 3,348 triangles and 242,460 bytes; the count excludes demo geometry. No image textures, rigging or authored animations are in those GLBs.

The robot, floor, light cells and gameplay are demo code. This example makes no Claude/image-provider request and is not external customer feedback. Claude's separate planning source prototype remains live-unverified. It does not add desktop/native/macOS verification, certify another engine import or imply image-to-3D or texture production.

## Architecture and validation

- `state.ts`: bounded movement, solid prop/fixed-obstacle footprints, legal placements, pickup/delivery state, breadth-first route finding and strict fixed-source scene import/export.
- `scene.ts`: lazy Three.js renderer, sequential hash-checked GLB decoding, camera and input, frame-gap limits and resource cleanup.
- `WorkshopPage.tsx`: Korean/English controls, local scene storage, new-file downloads, bounded JSON input and cancellation-safe restore.
- `package-workshop.mjs`: repeatable ZIP with original files and SHA-256 inventory; no runtime installation or provider execution.
- `build.mjs`: static initial HTML for all routes. Homepage and English project overview link directly to the example.

Meaningful logic/artifact checks run with `npx vitest run apps/site/src/workshop/state.test.ts`; site type checks with `npx tsc --noEmit -p apps/site/tsconfig.json`. `npm run site:build` verifies static content, existing evidence, local resources and CSP compatibility. HTTP publication verification is `node apps/site/scripts/verify-public.mjs https://treeset.win <new-receipt-path>`.

Browser interaction, responsive sizing and actual file save/reopen must be verified in CUA separately from HTTP/static assertions. Publication receipts and screenshots stay under ignored `output/workshop-publication-20261008`.

Local browser verification on October 8: all three pickup/delivery cycles reached the completion panel; actual GLBs loaded; keyboard movement worked; a 90-degree edit changed the workbench; the file chooser restored the packaged scene JSON. Layouts at 390px and 320px showed no horizontal overflow. PNG and JSON export produced user-facing download links. The Chrome automation provider cannot retrieve blob downloads, so writing those dynamic downloads to disk and reopening that exact downloaded file were not independently verified by this provider. The packaged scene import and strict modified-scene roundtrip were verified separately. A persistent download link gives users a direct retry when automatic saving is unavailable.

## Visual direction

The existing cyber workbench identity is retained. The distinctive element is a playable diorama built with the actual props: deep blue `#071c2a`, workshop blue `#142e40`, muted teal `#74ccd3`, cell amber `#f4d99b`, pale text `#dbe8e8` and horizon blue `#8a9bbd`. Bahnschrift supplies the display weight; the existing Korean system-font stack keeps body text legible. The large scene carries the visual interest; nearby controls and copy stay quiet, with explicit actions and visible keyboard focus. Reduced motion stops idle cell rotation.

No public application history or private support draft is included in the site or archive.

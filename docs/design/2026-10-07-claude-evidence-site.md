# Treeset developer and workflow evidence

Scope: a narrow addition to the existing public site, preserving its typography,
colors, release downloads, original procedural renders, contact and CSP.

The user authorized publishing JEONG WOOCHEOL, Java development experience in
its fifth year, and https://github.com/oocheol. English copy says “Java developer
in his fifth year”, without implying five completed years or an employer, degree
or affiliation. Project start, business-registration and investment facts are
unchanged.

## Public pages

- `/`: Korean developer introduction, accurate source-prototype status and links.
- `/about/`: dedicated developer section, inspectable local procedural workflow,
  released-platform evidence and a link to the Claude source prototype.
- `/workflows/claude-asset-brief/`: English request specification, intended output
  schema, local verification scope and release limitations. The page is statically
  rendered, has its own canonical/OG/Twitter metadata and appears in the sitemap.

The user has no Claude subscription and explicitly deferred live execution.
There is no actual Claude response or generated plan. Published 0.1.13 installers
do not contain this feature. Copy never describes Claude as an image/3D generator
or suggests that a planning response automatically runs asset generation or code.

## Evidence contract

`apps/site/src/claudeProof.ts` separates three independent states:

- `claudePrototypeImplemented`: checked source implementation.
- `claudeDevelopmentEvidence`: a real sanitized native probe/blocked-request record,
  developer-written input example and local checks. The example is explicitly
  labeled as not submitted to Claude.
- `claudeProof`: successful live provider evidence; remains null for this task.

The development record can link `/examples/claude-brief/input.json` and
`verification.json`. It cannot link a generated `plan.json`. A future live proof
requires its own actual response, reported model or explicit “not reported” state,
bounded individual instructions, review checklist, scope and hashed artifacts.

`apps/site/src/localWorkflow.ts` optionally accepts an independently verified local
procedural workflow and artifacts under `/examples/local-prop-kit/`. This evidence
is separate from Claude status. Until populated, `/about/` shows the actual existing
crate recipe, output files and verification record from
`examples/procedural/run-8fa3777b7c994505ba1c5592453a8543`. The fallback record scopes
the proof to the direct Windows Blender worker; it does not claim Tauri or engine
integration from that run.

The build invokes no provider. The static verifier checks all three route bodies,
metadata, sitemap, local resource existence and preservation of external-bundle-only
scripts/no inline style. Any supplied downloadable evidence must exist and match
its declared SHA-256. Public provider evidence and native platform proof still
depend on the coordinator's real checks; structural site validation does not
establish them.

## Validation before evidence import

2026-10-07: site TypeScript compilation and production build/static verification
passed with `claudeProof`, `claudeDevelopmentEvidence` and `localWorkflowProof`
null. All three page bodies rendered without client execution; server output
remained outside public deployment files. Browser layout and final publication
are checked separately by the coordinator after importing real local evidence.

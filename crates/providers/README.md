# Official Codex subscription provider

The current build pins its outer planner to `gpt-6.1-sol` through
`runtime::DEFAULT_REASONING_MODEL`. The image request remains `gpt-image-2`.
These are separate selections: changing the planner does not authorize a
different image model, provider, billing lane, or API-key route.

This selection follows the user's latest instruction. No generation or login
RPC was made for this revision; account inference eligibility and a successful
image round trip remain unverified.

The live attempts with `gpt-6.1-sol` and `gpt-6-luna` both reached confirmed failed
terminal turns before any image-generation item was observed. Their safe diagnostics
reported `codexErrorInfo=other`, no HTTP status, and model-unavailable and
invalid-request text hints. Those hints identify a rejection to investigate;
they do not prove general model availability or recover the discarded raw
message. The historical fixed `gpt-5.5` selection was the last explicit
compatibility attempt from the pinned static catalog. Its account/runtime handshake passed,
but the native turn also ended in failure without an observed image item.
The safe diagnostic retained `upstreamErrorType=invalid_request_error`, no
upstream error code or HTTP status, and the same broad model/invalid-request
hints. The exact ChatGPT-account model-restriction hint was false. The specific
upstream cause remains unknown; no raw error text was retained.

All four native generation attempts recorded in the 2026-10-02 summary failed and produced zero
subscription image assets. Image receipt, decode, generated-image project save
and reopen were not reached. No further generation was performed for this revision.
The provider transport and its failure handling are implemented, but external
image generation remains blocked and the live image round trip is unproven.
See `tests/provider/runtime-final-summary.json` and the actual root reports
under `output/native/provider-compat-20261002-173201`. The earlier 22-test
Luna/read-only snapshot is preserved unchanged as historical evidence.

The pinned reference repository, `lidge-ai/ima2-gen` commit
`8c27479c140b1a8db59b866cf41df099e287dd9e`, recommends `gpt-6-luna` in its
[README default example](https://github.com/lidge-ai/ima2-gen/blob/8c27479c140b1a8db59b866cf41df099e287dd9e/README.md#L112)
and [model-rejection guidance](https://github.com/lidge-ai/ima2-gen/blob/8c27479c140b1a8db59b866cf41df099e287dd9e/README.md#L446).
That recommendation informed the second attempt; it was not evidence that
the official Codex runtime would accept the model for this account. All account, inference,
image and interruption operations use the official public Codex app-server
stdio protocol; the reference repository's direct HTTP transport is not used.

Before submission, the selected `gpt-6.1-sol` must be present in both the pinned
[official catalog](https://github.com/openai/codex/blob/b1e72963c3b71a9265a551e54beff078384efed9/codex-rs/models-manager/models.json)
and the official runtime's configured public `model/list`. The application
injects this static catalog through `model_catalog_json`, so matching results
verify local catalog consistency; they do not query the account's current
inference permissions. The catalog source/hash/license are recorded in
`assets/NOTICE`. `model/list.isDefault` never chooses a planner.
If the fixed or explicitly requested planner is absent, connection returns
`provider.reasoning_model_unavailable`. There is no automatic upgrade, model
fallback or retry. Catalog membership and a successful account handshake do
not prove that the account will accept actual inference or produce an image.

Runtime version metadata accepts a bounded ASCII SemVer value, including
`codex-cli 0.159.0-alpha.12.1`. Recognizing a prerelease version does not certify
that all runtime features are compatible. The app-server client version follows
the provider package's inherited workspace version.

`generate` checks cancellation on entry and again after preflight RPCs and
input construction, immediately before `turn/start`. A cancellation observed
at that point returns `Interrupted` without submitting an inference turn.
After submission, interruption and unknown outcomes follow the separate
durable reconciliation contract; a terminal turn interruption alone does not
confirm that a remote image backend has canceled its work.

Provider fixtures exercise the real generate/start/poll code without a live
account. A live image proof must independently verify received bytes, image
decode, project save and reopen. The public image event has no confirmed image
model field, so `confirmedImageModel` remains null until the provider publishes
that evidence.

Terminal diagnostics retain allowlisted `upstreamErrorCode` and
`upstreamErrorType` labels only when an upstream JSON envelope can be parsed
inside the bounded public native error message. Unknown values are discarded.
`hints.chatgptAccountModelUnsupported` checks the exact native wording
“not supported when using Codex with a ChatGPT account”; this is distinct from
the broader model-unavailable text hint. No raw error message, response body,
token, header or URL is retained.

The earlier root workspace suite passed 110 tests with 4 ignored, including all
24 provider tests (20 unit and 4 contract). These local tests validate provider
protocol/error controls; they do not establish live generation success.

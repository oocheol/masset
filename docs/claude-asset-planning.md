# Claude asset-planning source prototype

This optional feature turns an explicitly supplied game brief and art direction into separate asset instructions and a manual review checklist. It does not generate images or models, execute generated code, read the connected game project, or start production jobs.

The source adapter, desktop panel and native CLI bridge are implemented. **A real Claude planning response has not been verified.** The maintainer has no Pro or Max subscription and explicitly deferred live execution. Published Windows/macOS installers and standalone CLI version 0.1.13 do not contain this new feature. This change does not publish a new desktop or npm package.

## Account and runtime

Use an existing, officially authenticated Claude Code Pro or Max account. The application discovers an installed official CLI; it does not install it, open login, buy a subscription or copy credentials. The connection probe reports the CLI version and authentication category without publishing account email or organisation identifiers. An authentication check does not establish successful model access.

API-key providers, custom relays and third-party cloud providers are rejected. There is no paid API fallback, automatic retry or model substitution. Team/Enterprise authentication and observable managed policy are currently blocked: Claude Code safe mode can retain managed commands, and this prototype cannot establish their isolation. Missing or unrecognised authentication also blocks planning.

## Desktop use from source

Open **구독 연결 → Claude 계획 기능 열기**. Check the connection, enter a game description, art direction and 1–12 distinct assets, then approve transmission of those fields. Each asset receives a name, kind, purpose, visual production prompt and acceptance checks. The result also includes a review checklist and limitations. Copy the JSON to inspect and use it manually in production tools.

Only the explicitly entered text is submitted to Anthropic. Images, references, project files and asset originals are not submitted. A pending request can be cancelled; local process termination cannot undo a request already received by the provider or guarantee that no subscription usage occurred.

## Native CLI from a development build

Read-only connection check:

```powershell
& .\target\debug\asset-cli.exe doctor --resources C:\masset --check-claude
```

Use a creator-written JSON request such as:

```json
{
  "action": "claude_plan",
  "brief": "An isometric crafting game needs three separate workshop props.",
  "artDirection": "Muted teal wood, sand trim, clean silhouettes and metre scale.",
  "assetCount": 3,
  "transmissionApproved": true
}
```

Submit only when an existing subscription is available and the user chooses to send it:

```powershell
& .\target\debug\asset-cli.exe command --resources C:\masset --workspace C:\assets\workshop --json C:\assets\brief.json --allow-claude
```

Both `--allow-claude` and `transmissionApproved: true` are required. `--allow-gpt` cannot authorise Claude transmission. Output is JSON Lines; a returned plan does not enqueue image/model generation.

## Execution boundary and output validation

Each request uses a fresh working directory. The child receives a narrow OS environment and safe settings; API credentials, relay settings, model overrides and injected Node options are not inherited. Built-in tools, slash commands, browser access, sessions, project MCP servers, user/project settings and ordinary hooks are disabled. The adapter invokes a native CLI or verified official npm package layout without passing prompts through a shell.

Planning is bounded to 120 seconds, 512 KiB stdout and 32 KiB stderr. Timeout, cancellation and output overflow terminate the local process tree. Fixed errors keep raw provider output and secrets out of logs. Strict schema validation enforces the requested count, distinct names, known kinds and bounded text/checklists. A model identifier is recorded only from an unambiguous response `modelUsage` key; otherwise it stays unknown. Schema checks do not establish asset quality.

## Evidence

- [Public implementation and local authentication record](https://treeset.win/workflows/claude-asset-brief/): creator-written input, no submitted prompt and no generated Claude plan.
- [Real local procedural workflow](https://treeset.win/about/#local-workflow): Windows native CLI, three existing Blender recipes, independently reopened files and verified exports. This case does not use Claude.
- `scripts/native-claude-workflow-proof.mjs` checks the installed runtime and both transmission gates without a generation request.
- `scripts/native-local-prop-kit-proof.mjs` verifies GLB and editable-source round trips in separate Blender processes.
- Isolated adapter tests exercise authentication rejection, output validation, process limits, cancellation, descendant termination and environment isolation. Fake children are not live provider evidence.

Official references: [CLI](https://code.claude.com/docs/en/cli-reference), [programmatic use](https://code.claude.com/docs/en/headless), [authentication](https://code.claude.com/docs/en/authentication).

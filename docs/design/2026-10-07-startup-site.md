# Treeset product and project information

Scope: make the real project easier to understand and independently inspect at https://treeset.win/. This is a product-site change, not a new application submission or a claim of startup-program eligibility.

## Basis for the content

The user confirmed that October 2026 is the project start, not an incorporation date; the project has not registered a business and has no external investment. Public contact is oocheol@treeset.win and the maintainer profile is https://github.com/oocheol. No legal name, address, company number, customers, revenue, funding amount or affiliation was inferred.

The current public implementation uses official Codex/ChatGPT subscription requests and local processing. There is no Claude/Anthropic integration in the desktop/provider source. Claude workflow planning and review are described as a planned integration, with the same status in Korean and English. The site does not claim “Powered by Claude,” program membership or approval.

The [official Claude Startups page](https://claude.com/ko/programs/startups), checked 2026-10-07, says applicants need a Claude Console account, a company email matching the website domain and a brief description of what they are building. It describes startups founded in the past five years or funded in the past two years and includes bootstrapped/pre-seed startups. It does not clearly settle eligibility for this pre-incorporation project. The user's rejection notice and the referenced discussion do not prove a particular rejection mechanism or a probability of approval.

## Concrete changes

| Previous limitation | Change |
| --- | --- |
| Public HTML was 2,202 bytes with an empty React root | Build-time React rendering produces body content and evidence links before browser JavaScript runs |
| Audience and work sequence were implicit | Hero names indie developers/small teams and the image → local refinement → export workflow |
| Short project introduction lacked a visible maintainer/stage | Shared Korean/English facts identify the maintainer, project start, pre-incorporation status, funding status and contact |
| English description only existed after client rendering | `/about/` is an English static product/project overview with its own language, metadata, canonical URL and sitemap entry |
| The referenced discussion proposed a current Claude-powered feature without implementation | Both pages distinguish the existing Codex/local workflow from future Claude integration |
| Product proof was spread across the page/repository | Overview links actual GLB/.blend examples, release downloads, platform verification, source code, issues and npm |

The existing Treeset palette, real Blender renders, browser-preview labeling, download/version/hash records, modal, copy controls and guides are retained. Browser UI is still separate from native/provider verification. Public Windows/Mac/npm package versions are not changed by this site update.

## Verification

The site build renders `/` and `/about/` and verifies meaningful static body text, one h1/canonical per page, real local assets, both sitemap entries and public project facts. The server bundle remains outside `dist`. Browser JavaScript hydrates the same component tree; development without pre-rendered HTML still uses the client renderer. No new dependencies, external tracking, third-party image hosting, inline scripts/styles or CSP relaxation are required.

TypeScript, production build and the static-content verifier passed. The generated home HTML contains 68,203 bytes and the English overview 17,067 bytes. Both contain readable body content and public proof links without JavaScript.

Chrome checks passed for both pages at 820, 390 and 320px, plus the home at 1440px. No document overflow, broken loaded images or console warnings/errors were observed. The render picker, native dialog/Escape/focus restoration, copy feedback, Claude-status FAQ and English/Korean navigation worked after hydration. The shared Treeset mark is retained on both pages. Local evidence is under `output/startup-site-1791365899102/`, including `browser-local-proof.json` and desktop/mobile screenshots.

The Vercel connector returned a team-scope 403. The existing Vercel CLI 60.1.3 had working credentials and independently confirmed project `masset`, team `team_9lTBZLzqvGvrx63l5ySvr4g8`, the `oocheol/masset` Git connection and production branch `master`. The actual deployment and public HTTP/browser content are checked after pushing the reviewed commit. Build success alone is not publication proof.

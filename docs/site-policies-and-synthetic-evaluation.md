# Site policies and synthetic evaluation examples

Date: 2026-10-09. Scope: Treeset website content only. Desktop installers and npm package remain 0.1.13.

## Published content

- `/terms/` and `/terms/en/`: website/example use, actual operator, project stage, separate Apache-2.0 rights, external-provider conditions and preserved legal rights.
- `/privacy/` and `/privacy/en/`: site code, browser layout storage, contact handling, local project data, user-approved provider requests and hosting/mail-provider uncertainties.
- `/research/claude-scenarios/` and `/research/claude-scenarios/en/`: six fictional production roles, three authored dialogue turns per role, proposed asset instructions, revision directions and evaluation criteria.
- Downloadable `examples/synthetic-claude/scenarios.json`, `README.md`, and deterministic `static-verification.json`.
- Links from the home/project teaser and the footers of all public pages. Content is prerendered into initial HTML, with canonical URLs and sitemap entries.

## Evidence boundary

The six roles are fictional. No actual participants were recruited, no Claude/API call was made, no example plan was executed, and no satisfaction, latency, token cost or quality improvement was measured. Every record declares `illustrative-not-executed`, `observedResults: null` and `metrics: null`.

The local verifier checks only the authored JSON: provenance flags, bilingual fields, requested asset scope, distinct safe proposed output names and review criteria. Its receipt is tied to the exact source SHA-256. This verifies the example data format; it does not verify provider output, asset quality, real-user adoption or startup eligibility. The privacy-focused example explicitly treats no-external-transfer requirements as incompatible with remote Claude calls.

## Source/data audit

Current website source has no signup, checkout, contact-submission form, advertising tracker, developer-added visitor analytics or profile cookie. The workshop fetches same-origin sample GLBs, reads selected scene JSON in-browser and prepares JSON/PNG Blob downloads. Layout storage key: `treeset.workshop.layout.v1`, with no automatic expiry. Removing site data is a browser action.

The local app/CLI stores project files on the user's machine. It can contact GitHub for updates and official providers for user-approved requests; it is therefore described as local-first rather than always offline. Claude planning remains a source prototype, not a verified provider example or a feature in 0.1.13 installers.

Operational data not established by the source audit: the exact hosting/access-log retention, processing countries/subprocessors, security-proxy configuration and mailbox retention settings. Public text explicitly marks these details as under review. Provider policies do not establish the user's account-specific configuration. This release does not certify completion of processor contracts or overseas-transfer requirements.

## Korean-law lookup

Used the configured `korean-law` MCP, exact-matched current laws, and read the actual article text. Lookup basis date: **2026-10-09**.

| Source | Articles read | Version verified | Use in drafting |
| --- | --- | --- | --- |
| [개인정보 보호법](https://www.law.go.kr/법령/개인정보보호법) | 15, 21, 26, 28-8, 30, 35, 36, 37 | effective 2026-09-11; lawId 011357; MST 283839 | Explain purpose, retention/deletion, provider/overseas boundaries, accessible notice and access/correction/deletion/restriction requests. |
| [약관의 규제에 관한 법률](https://www.law.go.kr/법령/약관의규제에관한법률) | 6, 7 | effective 2024-08-07; lawId 000667; MST 260021 | Avoid unfair terms and blanket exclusion of statutory or intentional/gross-negligence liability. |

The article text, not just a search list, informed the wording. The notices are based on the verified implementation and identified unknowns; they do not assert blanket legal compliance. Private lookup/deployment receipts are retained under `output/site-policy-publication-20261009/` and are excluded from the site deployment.

## Verification scope

- TypeScript site checking, evidence-boundary tests, static HTML/source/links and deterministic fixture receipt.
- Local browser inspection of Korean/English pages, expanded synthetic records, footer navigation and narrow-screen layout.
- Staged production HTML/resources checked before promotion; public domain checks after promotion.
- Browser results do not establish native desktop generation, real customer feedback or Claude execution.

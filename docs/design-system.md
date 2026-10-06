# Asset Studio visual system

Asset Studio helps game developers describe a game, connect its project folder,
produce individual 2D/3D assets and review the resulting files. Generation and
review are the main working flow; editing tools remain a secondary destination.
Codex skill installation is a separate entry point for developers already
building a game in Codex.

The shared palette is defined in `packages/ui/src/tokens.css`. The website uses
warm paper for introduction and onboarding. The application uses dark ink for
long working sessions. Both use the same typography, mint accent, rounded
controls and restrained interaction states.

| Token | Color | Role |
| --- | --- | --- |
| Studio ink | `#141c19` | Desktop canvas, dark product surfaces |
| Surface | `#1d2823` | Working cards and panels |
| Inset | `#111914` | Inputs and image backgrounds |
| Line | `#3c5045` | Decorative surface boundaries |
| Control line | `#617b69` | Desktop input/button boundaries |
| Text | `#f0f4ed` | Desktop primary text |
| Muted | `#b4c4b9` | Desktop secondary text |
| Mint | `#b9efcf` | Selection, primary desktop actions |
| Paper | `#f5f6f0` | Marketing page background |
| Paper muted | `#526254` | Marketing secondary text |
| Paper control line | `#708370` | Outlined marketing controls |
| Warning | `#f4ce94` | Desktop errors and actions needing attention |

Korean uses installed system fonts: Apple SD Gothic Neo, Segoe UI and Malgun
Gothic. No external font request is required. Most desktop working text is
14–16px. Focus uses an explicit 3px outline on production controls. Borders
identifying enabled desktop controls exceed 3:1 against their surfaces;
decorative dividers use a quieter color.

## Working UI

- The production header explains the task briefly and keeps connection status
  next to the connection action.
- The stage strip reflects the connected project and actual prepared plan.
- A two-column input/list layout keeps the description beside the proposed
  individual assets. Narrow workspaces stack the columns.
- Results show actual completed counts, review status and per-item recovery
  actions. Progress bars count completed assets; they do not estimate total time.
- Native-only actions remain disabled in browser previews. Fixture assets are
  not presented as completed production results.
- The optional Codex installation entry appears after the main production flow.
- Library, review, dialogs and secondary tools inherit the same palette and
  control treatment.

## Marketing UI

The order is introduction → three-stage workflow → actual output examples →
Codex/app installation → verification details → FAQ. There are two introduction
actions: start with Codex or find the desktop download. Windows and Mac download
buttons remain equally visible in their own sections.

Installation warnings are visible before opening the detailed guides. Versions,
file hashes and existing release URLs retain their actual values. Lengthy
verification histories and requirements use disclosures. The product screenshot
is explicitly a browser preview of the new production home; it does not establish
native support or describe the design in the already-published 0.1.11 binaries.

The share card is an original composition using this project's logo, copy and
three existing Blender renders. Its editable layout is `docs/design/share-card.html`;
the exported PNG is `apps/site/public/media/asset-studio-share.png` (1200×630).
The layout expects the site's `/media/` and `/favicon.svg` assets when served.

Hover/focus transitions last 150ms. There are no continuous decorative effects.
`prefers-reduced-motion` disables transitions, animations and smooth scrolling.

References, inspection scope and verification results are recorded in
[the October 2026 design review](design/2026-10-06-refresh.md).

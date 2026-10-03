# Asset Studio visual system

The website and desktop application use the same material palette. The design
is based on asset inspection and docked production tools: actual rendered
objects carry the visual identity, and selected controls carry the accent.

| Token | Color | Role |
| --- | --- | --- |
| Ink | `#080f17` | Main canvas and page background |
| Rail | `#101d29` | Navigation and recessed controls |
| Panel | `#172a38` | Docked surfaces and inspection frames |
| Edge | `#334c60` | Dividers and surface boundaries |
| Cyan | `#68e0e2` | Selection and primary actions |
| Paper | `#e5edf4` | Primary readable text |

Korean text uses local system sans-serif fonts: Segoe UI, Apple SD Gothic Neo,
and Malgun Gothic. Product display text can use Bahnschrift where installed.
No external font request is required. Amber remains a warning color rather than
a decorative accent.

The website is left aligned, with a product introduction beside a real asset
inspection frame, followed by the workbench, actual outputs, supported features
and downloads. The desktop retains its working layout: navigation rail, central
asset workspace, properties dock, job queue and status bar. Angular edges and
small cut corners distinguish tool frames from dialogs and controls.

Core desktop controls stay at least 14px and guide text at least 16px. Body copy
on the website stays readable on 320px screens. Keyboard focus, dialog Escape
behavior and reduced-motion preferences are preserved. Decorative scans,
unrelated terminal text, invented usage statistics and continuous glow effects
are excluded.

Visual changes do not expand native platform or model support. Browser
screenshots are labelled as browser previews, and downloadable versions are
listed only after their actual packages are verified.

# ADR 0002: fail closed on unverified subscription model

Status: amended by explicit user choice, 2026-10-02.

The user explicitly changed the image target from GPT Image 2.5 to GPT Image 2 after the official Codex built-in path was documented. Windows is the first delivery target. Third-party Sign in with ChatGPT image support must not be inferred from Codex's own managed authentication.

Gate submission on verified official runtime/authentication/tool restrictions. Pin the planner separately from the image target; never switch billing lanes or retry unknown external outcomes. Receipt, decode, persistence and reopen are separate live proof gates. Keep requested/confirmed model separate and missing actual image model null. Original 2.5 selection is no longer a release gate; actual subscription generation remains visibly incomplete until proved.

# Security policy

This is an early MVP; no independent security audit or support SLA is claimed. Report a suspected vulnerability privately to a project maintainer before publishing sensitive details. No private reporting address or public repository security form is configured yet, so do not send tokens, auth files, user projects or exploit-bearing assets into a public issue. Provide a redacted summary and request a private reporting channel.

Include the application version, OS/architecture, affected module, expected/observed behavior and safe reproduction steps. Strip usernames/paths, prompts, reference images and secrets from logs. Do not execute generated Python/shell or enable Blender script auto-execution to reproduce an issue.

The threat model and known boundaries are in [security-design.md](docs/security-design.md). Child processes are not sandboxes. The application uses official auth/runtime paths and leaves unsupported subscription generation blocked. Public releases and security advisories require maintainer authorization.

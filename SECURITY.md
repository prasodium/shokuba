# Security

## Reporting a vulnerability

Please **do not** open a public issue for security problems.

Report privately through GitHub: **Security → Report a vulnerability** on this repository
([direct link](https://github.com/prasodium/shokuba/security/advisories/new)). Include what you found, how to reproduce it, and the impact you expect. You will get an acknowledgement, and we will work with you on a fix and coordinated disclosure.

Shokuba is in early development; there are no supported release lines yet, so fixes land on `main`.

## Security model

Shokuba runs AI coding agents on your machine, so it is built to keep you in control. This is what exists today and what is planned — with the limits stated plainly.

### In place now

- **Sandboxed renderer.** The UI runs with `contextIsolation`, `sandbox` and no Node integration, behind a strict Content-Security-Policy. It cannot touch the filesystem or spawn processes.
- **A small, explicit bridge.** The preload script exposes a fixed API — never `ipcRenderer` itself.
- **Validated IPC.** Every request is checked twice in the main process: the sending page must be Shokuba's own renderer, and the payload must match a Zod schema.
- **No navigation, no popups, no permissions.** Windows cannot navigate away or open new windows; all permission requests are denied.
- **Secret redaction.** Events, audit entries and logs pass through a redactor for well-known token formats and secret-looking keys before they are stored.
- **Allow-listed child environments.** Processes Shokuba starts receive only an explicit set of environment variables, so credentials in your shell are not silently handed to agents.
- **Append-only history.** The event log and audit log reject `UPDATE` and `DELETE` at the database level.
- **Migration safety.** Applied migrations are checksummed; a database from a newer version is refused rather than downgraded.

### Planned

- Per-employee **approval policies** (strict / balanced / autonomous) with a queue for risky actions.
- **Working-directory restriction** per agent, using isolated Git worktrees.
- A **command policy engine** for commands Shokuba itself runs, and a **circuit breaker** for runaway loops and spend.
- Secrets in the **OS keychain**.

### Honest limits

- Shokuba starts third-party CLIs (Claude Code, Codex, Gemini…). **It cannot intercept the commands those tools run themselves.** Where a CLI offers hooks or permission flags, Shokuba will use them; otherwise you rely on that CLI's own approval and sandbox settings. A working directory is containment, **not** a sandbox.
- Redaction is a safety net for known formats, not a guarantee. The primary defence is not putting secrets where they can be logged.
- Treat any agent you run as having the access of your user account, and review its approval settings accordingly.

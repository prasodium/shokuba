# Architecture

This document describes how Shokuba is built, and is explicit about what **exists today** versus what is **planned**. It is updated as each phase lands.

## Principles

1. **Events are the source of truth.** Everything the UI shows — the office, the activity feed, analytics — is derived from an append-only event log.
2. **Persist, then broadcast.** An event is validated, redacted and written to SQLite _before_ any subscriber sees it. The live view and a later replay can never disagree.
3. **The office reads events, never terminals.** Agents are observed through a structured signal channel; the PTY exists for humans.
4. **Say how you know.** Every event carries a `source`: `reported` (the agent told us), `inferred` (we deduced it), `simulated` (demo/office life), `system`, or `user`.
5. **Runtime and simulation are separate.** The runtime state of an agent process is real. Visual activities (walking, coffee, napping) are layered on top and never feed back into the runtime.
6. **Nothing crosses a boundary unvalidated.** IPC, events, database rows and (later) provider output are all parsed with Zod.
7. **All OS-specific code lives in one place.** See [PLATFORMS.md](PLATFORMS.md).

## Process model

```
┌────────────────────────── main process (Node) ───────────────────────────┐
│  bootstrap ─► database + migrations                                      │
│            ─► EventStore  (redact → validate → persist → broadcast)      │
│            ─► AuditLog                                                   │
│  ipc/handlers  (sender check + Zod on every request)                     │
│  platform/     (paths, shell, sockets, env, process termination)         │
└───────────────▲──────────────────────────────────────────────────────────┘
                │ validated IPC (contextBridge, no Node in renderer)
┌───────────────┴─────────── renderer (sandboxed Chromium) ────────────────┐
│  React + Zustand  ·  (planned) PixiJS office, xterm.js terminals         │
└──────────────────────────────────────────────────────────────────────────┘
```

## What exists today (Phase 0)

| Area           | Location                                 | Notes                                                                                |
| -------------- | ---------------------------------------- | ------------------------------------------------------------------------------------ |
| Event schema   | `src/shared/events/schema.ts`            | Zod discriminated union; strict payloads                                             |
| Event log      | `src/main/events/log.ts`                 | Append-only, `seq` never reused, rows re-validated on read                           |
| Event bus      | `src/main/events/bus.ts`                 | Typed, FIFO even for re-entrant publishes, isolates throwing listeners               |
| Event store    | `src/main/events/store.ts`               | The only way events enter: redact → validate → persist → broadcast                   |
| Audit log      | `src/main/events/audit.ts`               | Separate append-only record of security-relevant actions                             |
| Migrations     | `src/main/database/`                     | Sequential, checksummed, transactional; refuses a newer database                     |
| Redaction      | `src/main/security/redact.ts`            | Known token formats + secret-looking keys                                            |
| IPC            | `src/main/ipc/`, `src/preload/`          | Sender trust check + Zod; tiny explicit API on `window.shokuba`                      |
| Platform layer | `src/main/platform/`                     | Shell, IPC endpoint, PATH search, env allow-list, path containment, termination plan |
| Logging        | `src/main/logging/`                      | Structured JSON, redacted                                                            |
| Smoke test     | `src/main/smoke.ts`, `scripts/smoke.mjs` | Runs inside real Electron: SQLite, restart, real PTY, Git                            |

### Database

Tables are added by migrations _when a feature needs them_ — never speculatively. Today: `agent_events`, `audit_log`, `schema_migrations`. Both logs are append-only, enforced by database triggers rather than convention. Native modules (`better-sqlite3`, `node-pty`) are N-API, so the same binaries run under Node (tests) and Electron (app) with no rebuild step.

### Runtime states

`RuntimeState` (`src/shared/types/agent.ts`) is what an agent _process_ is doing: `offline`, `starting`, `idle`, `thinking`, `coding`, `testing`, `reviewing`, `researching`, `waiting`, `blocked`, `paused`, `error`, `stopped`. The office will derive its displayed state from this plus a separate simulation activity layer.

## Planned

### Agents and providers

A single `ProviderAdapter` interface (detect, authenticate, spawn, send input, interrupt, terminate, resize) plus an `ObservationChannel` that turns a CLI's own signals into events. First adapter: **Claude Code**, observed via its hooks. Then Codex, Gemini CLI, a generic CLI, and a deterministic `mock` adapter that demo mode uses — so demos exercise the real orchestrator.

Terminal output parsing is a **fallback only**, and anything derived from it is labelled `inferred`.

### Orchestration

Missions decompose into a dependency-aware task graph with explicit states, retries, blocked handling and structured, loop-protected agent messages (hop limits, parent ids, circuit breaker).

### Git isolation

Each coding task gets its own worktree and branch; unrelated agents never share a working tree.

### Verification

A task reaches `verified` only through a `VerificationReport` — harness-run static/unit/integration checks in the task's worktree, plus an **independent reviewer** that sees the diff and requirements but not the coder's transcript — and an exportable evidence pack.

### The office

Rendered with PixiJS in an original isometric-voxel style, all art drawn procedurally in code. Game logic runs on a 2D grid (A\* pathfinding, doors, interaction points); each employee has a behaviour state machine driven by the event stream. Life simulation (coffee, breaks, naps) only runs while an agent is idle or waiting, is switchable, and never sends anything to an agent.

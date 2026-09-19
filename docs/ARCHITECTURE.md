# Architecture

This document describes how Shokuba is built, and is explicit about what **exists today** versus what is **planned**. It is updated as each phase lands.

## Principles

1. **Events are the source of truth.** Everything the UI shows — the office, the roster, the activity feed, analytics — is derived from an append-only event log.
2. **Persist, then broadcast.** An event is validated, redacted and written to SQLite _before_ any subscriber sees it. The live view and a later replay can never disagree.
3. **The office reads events, never terminals.** Agents are observed through a structured signal channel; the PTY exists for humans.
4. **Say how you know.** Every event carries a `source`: `reported` (the agent told us), `inferred` (we deduced it), `simulated` (demo/office life), `system`, or `user`. The UI shows non-fact sources next to the state.
5. **Runtime and simulation are separate.** The runtime state of an agent process is real. Visual activities (walking, coffee, napping) are layered on top and never feed back into the runtime.
6. **Nothing crosses a boundary unvalidated.** IPC, events, database rows and provider reports are all parsed with Zod.
7. **All OS-specific code lives in one place.** See [PLATFORMS.md](PLATFORMS.md).

## Process model

```
┌───────────────────────────── main process (Node) ─────────────────────────────┐
│  bootstrap ─► database + migrations ─► EventStore (redact→validate→persist→emit)│
│                                                                                │
│  AgentRuntime ── owns every agent: PTY, scrollback, lifecycle, shutdown        │
│    ├─ ProviderAdapter   (detect · buildLaunch · ObservationChannel)            │
│    ├─ HookServer        (127.0.0.1, per-agent token) ◄── the agent's reports   │
│    ├─ AgentTracker      (signals ─► RuntimeState + events; pure)               │
│    └─ AgentViews        (events ─► current state per agent, for new windows)   │
│  EmployeeService        (persisted identity; validated against the disk)       │
│  ipc/handlers           (sender check + Zod on every request)                  │
│  platform/              (paths, shell, PATH search, env, process termination)  │
└──────────────▲────────────────────────────────────────────────────────────────┘
               │ validated IPC (contextBridge, no Node in the renderer)
┌──────────────┴────────── renderer (sandboxed Chromium) ───────────────────────┐
│  React + Zustand  ·  xterm.js terminal  ·  PixiJS isometric office            │
└────────────────────────────────────────────────────────────────────────────────┘
```

### Data flow for one agent

```
agent CLI ──PTY──────────────────────────► scrollback ─► xterm.js   (what a human sees)
    │
    └─ reports (Claude Code: HTTP hooks) ─► HookServer ─► adapter.parse ─► AgentSignal
                                                                              │
                                        AgentTracker (state rules) ◄──────────┘
                                                │
                                   EventStore: redact → validate → persist → broadcast
                                                │
                       ┌────────────────────────┼─────────────────────────┐
                       ▼                        ▼                         ▼
                  AgentViews               IPC push                  (later) orchestrator,
                (snapshot for a          ─► renderer folds the        verification, analytics
                 window that opens)         same events into an
                                            AgentView ─► office
```

Main and renderer fold events through the **same reducer** (`src/shared/agents/view.ts`), so the roster, the office bubble and a reloaded window cannot disagree.

## What exists today

### Foundation (Phase 0)

| Area           | Location                                 | Notes                                                                               |
| -------------- | ---------------------------------------- | ----------------------------------------------------------------------------------- |
| Event schema   | `src/shared/events/schema.ts`            | Zod discriminated union; strict payloads                                            |
| Event log      | `src/main/events/log.ts`                 | Append-only, `seq` never reused, rows re-validated on read                          |
| Event bus      | `src/main/events/bus.ts`                 | Typed, FIFO even for re-entrant publishes, isolates throwing listeners              |
| Event store    | `src/main/events/store.ts`               | The only way events enter: redact → validate → persist → broadcast                  |
| Audit log      | `src/main/events/audit.ts`               | Separate append-only record of security-relevant actions                            |
| Migrations     | `src/main/database/`                     | Sequential, checksummed, transactional; refuses a newer database                    |
| Redaction      | `src/main/security/redact.ts`            | Known token formats + secret-looking keys                                           |
| IPC            | `src/main/ipc/`, `src/preload/`          | Sender trust check + Zod; small explicit API on `window.shokuba`                    |
| Platform layer | `src/main/platform/`                     | Shell, PATH search, env allow-list, path containment, termination plan              |
| Smoke test     | `src/main/smoke.ts`, `scripts/smoke.mjs` | Runs inside real Electron: SQLite, restart, real PTY, the whole agent pipeline, Git |

### Agents (Phase 1)

| Area                | Location                                | Notes                                                                                                     |
| ------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| Provider interface  | `src/main/providers/types.ts`           | `ProviderAdapter` + `ObservationChannel` + provider-neutral `AgentSignal`                                 |
| Claude Code adapter | `src/main/providers/claude-code/`       | Detects `claude` (PATH, common dirs, editor-bundled binaries), builds the launch and the hook settings    |
| Demo adapter        | `src/main/providers/mock/`              | A scripted agent in a real PTY; everything it reports is labelled `simulated`                             |
| Runtime             | `src/main/agents/runtime.ts`            | Start / stop (graceful, then forced) / interrupt / write / resize; bounded scrollback with stream offsets |
| Report listener     | `src/main/agents/hook-server.ts`        | Loopback HTTP; per-agent token; see [SECURITY.md](../SECURITY.md)                                         |
| State tracker       | `src/main/agents/tracker.ts`            | Pure: signals in, events out. Every transition says how we know                                           |
| Employees           | `src/main/employees/service.ts`         | Persisted; folder validated and canonicalised; launch settings locked while running                       |
| Terminal            | `src/renderer/components/TerminalPanel` | xterm.js; replay + live stream joined by offsets, so re-attaching loses and repeats nothing               |
| Office              | `src/renderer/office/`                  | PixiJS isometric voxel room; pure geometry, poses and bubble text are unit-tested                         |

#### Provider adapters

One `ProviderAdapter` per kind of CLI. It **describes**; the runtime **does**:

- `detect()` — is the CLI installed, where, which version?
- `buildLaunch()` — pure: executable, arguments, extra environment, and files to write. No I/O.
- `observation` — turns the CLI's own reports into `AgentSignal`s (`turn-started`, `tool-started`, `attention`, …). Unknown or malformed input yields nothing, never an exception.

The runtime starts every agent in a PTY the same way, so terminals, interrupts, resizing and shutdown behave identically for all providers. (This differs from the original sketch, where each adapter spawned its own process; that would have duplicated the hard parts once per provider.)

#### How Claude Code is observed

Shokuba launches `claude --settings <generated file>`. The file adds [HTTP hooks](https://code.claude.com/docs/en/hooks) that POST each event to the loopback listener, authenticating with a header taken from an environment variable — the token never touches the disk or the command line. Claude Code merges these with the user's own hooks; it does not replace them.

Why HTTP rather than a Unix socket: Claude Code's hooks speak HTTP or run a command. A socket would need a helper binary launched on every hook, per platform. Loopback HTTP works identically on macOS, Windows and Linux, and the listener is locked down (token per agent, `Host` check, JSON only, size cap).

Prompts, model output and tool _results_ are never recorded. A tool call is reduced to a short summary ("Edit src/app.ts", "Run npm test") which is redacted before it is stored.

#### Runtime states and how we know

`RuntimeState` is what an agent _process_ is doing: `offline`, `starting`, `idle`, `thinking`, `coding`, `testing`, `researching`, `reviewing`, `waiting`, `blocked`, `paused`, `error`, `stopped`. Some rules worth knowing:

- Editing and reading tools say what they do (`reported`). A **shell command could be anything**, so "coding" or "testing" derived from one is our guess and is labelled `inferred`.
- Several tools can run at once; the agent stays busy until the last finishes.
- Claude Code reports nothing when a turn is interrupted. If you press Ctrl+C or Esc in the terminal (or use Interrupt), Shokuba shows the agent idle, labelled `inferred`; the next real report corrects it if the guess was wrong.
- Nothing decides an agent is finished by silence — only a `turn-finished` report or the process exiting.
- Everything from the demo provider is labelled `simulated`, never `reported`.

### Database

Tables are added by migrations _when a feature needs them_ — never speculatively. Today: `agent_events`, `audit_log`, `schema_migrations`, `employees`. Both logs are append-only, enforced by database triggers rather than convention. Employees are archived, not deleted, because events refer to them. Native modules (`better-sqlite3`, `node-pty`) are N-API, so the same binaries run under Node (tests) and Electron (app) with no rebuild step.

### The office

PixiJS 8 draws an original isometric-voxel room: each employee has a desk, a chair and a small block person whose pose follows their state (typing while coding, a raised hand when they need you). A status bubble above them says the state and what they are doing, and marks it `inferred` or `demo` when it is not a fact. The renderer imports PixiJS's `unsafe-eval` build, so the strict Content-Security-Policy stays as it was (no `unsafe-eval`).

The room shows four desks; more employees than that are counted but not drawn yet. The full world (rooms, pathfinding, walking, handoffs, camera) is Phase 5.

## Planned

### Orchestration

Missions decompose into a dependency-aware task graph with explicit states, retries, blocked handling and structured, loop-protected agent messages (hop limits, parent ids, circuit breaker).

### More providers

Codex, Gemini CLI and a generic CLI. They implement the same `ProviderAdapter`; if a CLI has no hooks, its `ObservationChannel` can parse structured output, and only as a last resort terminal text — always labelled `inferred`.

### Git isolation

Each coding task gets its own worktree and branch; unrelated agents never share a working tree.

### Verification

A task reaches `verified` only through a `VerificationReport` — harness-run static/unit/integration checks in the task's worktree, plus an **independent reviewer** that sees the diff and requirements but not the coder's transcript — and an exportable evidence pack.

### The full office

Rooms, A\* pathfinding, doors and interaction points; behaviour state machines driven by the event stream; visible handoffs; camera pan/zoom/follow. Life simulation (coffee, breaks, naps) only runs while an agent is idle or waiting, is switchable, and never sends anything to an agent.

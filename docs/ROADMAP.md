# Roadmap

Shokuba is built in small, tested increments. Each phase ends with something that runs and can be inspected. Boxes are ticked only when the thing works.

## Phase 0 — Foundation

- [x] Electron + React + TypeScript (strict) scaffold, ESLint, Prettier, Vitest
- [x] Cross-platform layer (`src/main/platform`) with tests for macOS, Windows and Linux branches
- [x] SQLite with checksummed, transactional migrations
- [x] Append-only event log, typed event bus, persist-then-broadcast event store
- [x] Secret redaction on everything persisted or logged
- [x] Sandboxed renderer, validated IPC with sender checks, strict CSP
- [x] Smoke test inside real Electron (SQLite, restart persistence, real PTY, Git)
- [ ] CI on macOS, Linux and Windows

## Phase 1 — First real agent + first glimpse of the office

- [ ] Provider adapter interface
- [ ] **Claude Code** adapter: detect, spawn in a PTY, observe via hooks over a local socket
- [ ] Terminal panel (xterm.js): type, interrupt, resize
- [ ] Employee model, persisted; create / edit an employee
- [ ] Minimal isometric office: one employee whose status bubble follows **real** events

## Phase 2 — Multi-agent

- [ ] Multiple employees and roles
- [ ] Missions and a dependency-aware task graph
- [ ] Structured messages, routing, loop protection, circuit breaker

## Phase 3 — Git

- [ ] Worktree + branch per task, diffs, commits, merge and conflict handling

## Phase 4 — Verification

- [ ] Harness-run checks in the worktree
- [ ] Independent reviewer agent
- [ ] Verification report and exportable evidence pack

## Phase 5 — The office

- [ ] Full isometric voxel world: rooms, desks, furniture, A\* pathfinding
- [ ] Animated employees driven by the event stream; visible handoffs
- [ ] Camera: pan, zoom, follow

> The MVP bar is met at the end of Phase 5: open a repo, run a real agent in an isolated worktree, have it verified by an independent reviewer with evidence, and watch it happen in the office.

## Later

- **Phase 6 — Life simulation:** coffee, tea, water, snacks, meetings, rest (always optional, always labelled as simulation)
- **Phase 7 — Customisation:** character, role, office and department editors
- **Phase 8 — GitHub:** issue → plan → implement → verify → PR
- **Phase 9 — Polish:** replay, cinematic camera, analytics, themes, accessibility, performance
- More providers: Codex, Gemini CLI, generic CLI
- Windows and Linux builds ([details](PLATFORMS.md))

Have an idea or want to take something on? Open an issue — see [CONTRIBUTING.md](../CONTRIBUTING.md).

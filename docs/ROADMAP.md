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
- [x] CI on macOS, Linux and Windows (typecheck, lint, unit tests, in-Electron smoke test)

## Phase 1 — First real agent + first glimpse of the office

- [x] Provider adapter interface (`ProviderAdapter` + `ObservationChannel`; the runtime owns the PTY)
- [x] **Claude Code** adapter: detect (PATH, common dirs, editor-bundled binaries) and launch in a PTY — verified against Claude Code 2.1.276, whose real interface renders in the terminal panel
- [ ] Claude Code **observed through hooks, end to end.** Hook delivery is verified against the real Claude Code 2.1.276 in headless mode (`claude -p`): the events arrive authenticated and parse. A full _interactive_ turn is **not yet verified**, because the CLI's one-time first-run setup has not been completed on the development machine. Once it has: `SHOKUBA_LIVE_CLAUDE=1 npm test -- live-claude`
- [x] Terminal panel (xterm.js): type, interrupt, resize, reconnect — verified with real keystrokes
- [x] Employee model, persisted; create / edit / remove
- [x] Minimal isometric office: an employee whose status bubble follows the event stream — verified with the demo agent, whose activity is labelled `simulated`
- [x] Demo (simulated) provider, so the office and terminal can be used and tested without an AI account

## Phase 2 — Multi-agent

Built in slices, each checked before the next.

- [x] **2a: Missions and the task graph.** Missions with tasks that depend on each other (cycles are refused); assign tasks to employees; while a mission is Running, a ready task is handed to its assignee once that agent has _reported_ itself idle; agents report back through Shokuba's own MCP tools; `submitted` is a claim, and only a person accepting it makes a task `done`. Verified with the demo agent on macOS, Linux and Windows. **Not yet verified:** a real, interactive Claude Code receiving a pasted briefing and calling the tools (the MCP handshake itself is verified against Claude Code 2.1.276 in headless mode)
- [x] **2b: Messages between agents, routing and loop protection.** Agents (and you) send persisted, structured messages; a message reaches an agent as a continuation when its turn ends, or is pasted if it is already idle; Shokuba counts the chain of replies itself and, at 6 hops, holds the message and halts the conversation for you to resume or close. Verified with demo agents on macOS, Linux and Windows, including a runaway exchange being stopped. Continuation is verified against Claude Code 2.1.276 in headless mode; **not yet verified** with an interactive session
- [x] **2c: Circuit breaker.** Watches each agent for repeated identical calls, repeated failures, failed turns, too many files edited, a turn that will not end and conversations halted as loops. It warns, then limits (no new tasks or teammate messages; the looping call is refused), then pauses (interrupted; only handing work back is allowed); stopping is only ever a person's decision. Verified with demo agents on real terminals, including a stubborn agent being paused and interrupted. A refused call is verified against Claude Code 2.1.276 in headless mode; **not yet verified** with an interactive session. **Not built:** a spend limit, because Claude Code's hooks report no cost
- [x] **2d: Teams, roles as templates, and the manager rule.** An employee is either a **manager**, who talks to you, or reports to one. **Employees who report to a manager never message you directly:** they ask their manager, who takes to you only what needs you. Shokuba enforces this itself rather than trusting the agent's instructions; an employee with no manager can still message you, and you can still write to anyone. A blocked employee's manager is told. New employees can start from a built-in role template (Manager, Engineer, Reviewer, QA) and every field, including what the role is for, stays editable. Verified with fake terminals end to end, and the rule is unit-tested at the service, the tool and the breaker. **Not built:** saving your own templates, and a manager doing anything more than being the route to you (that is 2e)
- [x] **2e: A manager drafts missions for their team.** A manager's agent is offered five extra tools (`draft_mission`, `add_task`, `remove_task`, `get_draft`, `team_status`); nobody else is. It can only draft: it may change just the missions it drafted itself, only until you run them, and assign work only to itself or people who report to it, up to 3 open drafts of 25 tasks each. You still press **Run mission**, and only you accept work. A draft says who wrote it. Verified with demo agents over real MCP connections and terminals. **Not verified:** a real Claude Code manager drafting a plan in an interactive session
- [x] Several employees running at once, each with their own terminal and desk

## Phase 3 — Git

Built in slices, each checked before the next.

- [x] **3a: The Git layer.** Making a mission branch and a branch plus working folder per task (in Shokuba's data folder, never in your project), committing a task's work as the employee, listing and showing what a task changed, and merging a task into its mission branch **without checking anything out**, with a conflict reported by file and nothing changed. It can only create or move `shokuba/…` branches, so it cannot move `main`, and a repository's hooks, filters and merge drivers never run from it. Verified against real Git on macOS, Linux and Windows. **Not yet used by tasks:** nothing in the app calls it until 3b
- [ ] 3b: A branch and working folder per task: a fresh agent started in the task's folder, the work committed when the agent submits, and the diff shown in the task's detail. A task whose folder is not a Git repo runs as today, labelled "not isolated"
- [ ] 3c: Accepting a task merges it into its mission branch; a conflict sends the task back to the agent with the files named; finished working folders are removed. Shokuba never touches `main` and never pushes: you merge the mission branch yourself

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

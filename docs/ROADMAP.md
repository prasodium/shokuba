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

## Phase 3 — Git (complete)

Built in slices, each checked before the next.

- [x] **3a: The Git layer.** Making a mission branch and a branch plus working folder per task (in Shokuba's data folder, never in your project), committing a task's work as the employee, listing and showing what a task changed, and merging a task into its mission branch **without checking anything out**, with a conflict reported by file and nothing changed. It can only create or move `shokuba/…` branches, so it cannot move `main`, and a repository's hooks, filters and merge drivers never run from it. Verified against real Git on macOS, Linux and Windows. **Not yet used by tasks:** nothing in the app calls it until 3b
- [x] **3b: A branch and working folder per task.** When a task is handed out, its assignee's agent is restarted in a working folder of its own, on a branch cut from the mission's branch, so a dependent task starts from the work accepted before it. The work is saved as a commit when the agent submits (before the task shows as submitted), the task's detail shows the changed files and a diff, **accepting merges the task into the mission branch, and a conflict sends the task back to its agent** with the files named and how to fix it. A task whose folder is not a Git repository (or with Git missing or too old) runs as before and says why it was not isolated. Your own checkout and branches are never touched, and nothing is pushed. Verified with demo agents on real terminals, and with real Git in tests. _(The accept-merge and conflict path was planned for 3c; it moved here because a dependent task cannot start from accepted work without it.)_
- [x] **3c: Cleanup and the finish.** A finished task's working folder is removed as soon as no running agent is in it (when its agent moves on to its next task or is stopped, and at startup), and its branch stays, so the work can still be read. A cancelled task's unsaved edits are saved to its branch first, and a folder whose work cannot be saved is never removed. Each mission shows the branch its accepted work is collecting on, with commands to read and merge it yourself (Shokuba never merges into your branches). Verified with demo agents on real terminals, including the folder being removed after a real agent process has left it. **Not done:** task branches are kept, so a busy repository collects `shokuba/…` branches (list them with `git branch --list 'shokuba/*'`); an idle agent stays in its last task's folder until its next task

## Phase 4 — Verification (complete)

Built in slices, each checked before the next.

- [x] **4a: Checks.** Commands **you** define per project in Shokuba (never read from the task's branch, so an agent cannot add or weaken one) are run by Shokuba on the work an agent submits, in the task's own folder, on the exact commit it submitted. Setup steps (such as installing dependencies) run first; each step's exit code, duration and redacted output are kept, and a failing check does not stop the others. Nothing runs until you have acknowledged that these run agent-written code, **unsandboxed**, with your account's access. They run automatically when an agent submits (and again on request), one run at a time, and a run is dropped if the task is sent back. Accepting work whose checks failed warns you first (it never blocks you). Verified with real commands on real terminals. **Not built:** checks on a mission's merged branch, and any sandbox
- [x] **4b: An independent reviewer.** You (or, if you set it up for a project, Shokuba on every submission) ask a **different** employee to review a task's work; the author can never review their own. The reviewer is restarted in a folder of its own holding the code exactly as submitted, held to **plan mode**, and is handed what was asked and the diff, **never the author's own summary or the check results**. They hand in a verdict (approve, request changes, comment) and findings through a tool only they are offered, and it is **advice**: it never accepts, rejects or sends back anything, and accepting work a reviewer asked changes for only warns you. A review is tied to the commit it read, says when the work has changed since, and is dropped if the task is sent back. Verified with two demo agents on real terminals and real Git. **Not built:** a reviewer that runs the code or the checks, and the reviewer's own words being shown anywhere but the task
- [x] **4c: An evidence pack per task.** On any task that has been handed out, **Export the evidence pack** saves a new folder where you choose (in a dialog the app shows, so the page never names a path) holding `report.md` (what was asked, the agent's own account labelled as a claim, the commits and files, every run of the checks, every review, who accepted it and when, and a timeline from the event log), `evidence.json` (the same as data), `changes.diff` (the code exactly as Git produced it) and one log per check step. It says whether the checks and the review were of the commit the work ended at, never overwrites or follows a link, holds no full paths of its own (only the project's folder name), and records the export in the audit log. Text is redacted of secret-looking values, and the diff, which must stay exact, is scanned and the pack warns you what it found. Everything an agent or person wrote is shown as inert text, so a report cannot be turned into links, images or HTML. Verified with real Git and a real database in tests (each guarantee checked by mutation) and by exporting the pack of an accepted, reviewed task in the in-Electron smoke check. **Not built:** signing, so a pack is a record and not tamper-proof; exporting a whole mission; a zip file (a folder is easy to inspect and to archive yourself)

## Phase 5 — The office

Built in slices, each checked before the next. The rule throughout: the office reads recorded events and never invents activity. Nobody wanders on their own (life simulation is Phase 6), and every movement is a picture of something that really happened, labelled `inferred` where it is deduced.

- [x] **5a: The world and the camera.** The floor plan is data (`src/renderer/office/map.ts`) and grows with the team: a commons room and a first desk room always, then another desk room of four for every four employees, up to **twelve desks** (more are counted but not drawn). The commons room holds the shared places, each standing for something real: **your inbox**, a **QA bench**, a **reading room** and the **mission board**. They stand idle for now; the board is bare, the bench screens dark and the trays empty, so an idle office never looks busy. Walls between rooms are low, with doors, and everything on the floor is drawn in depth order. The camera pans by drag or arrow keys, zooms by wheel or +/−, fits with 0, and **follows** the selected employee (bringing the view in to them); controls are real buttons, and the office is keyboard-reachable. Bubbles and names shrink with the view so a small panel does not pile them on top of each other. Verified by unit tests of the plan (nothing overlaps, every door and standing spot is clear, the plan is deterministic and rooms already there never move as it grows) and the camera maths, and by looking at the running app with 1, 5 and 9 employees, zoomed, dragged and following. **Not built:** anything moving (5b), and the places showing real work (5c)
- [ ] 5b: Movement: pathfinding on the plan, and employees who walk. An employee may leave their desk for a real, recorded reason, or because the agent's own tool activity (running tests, say) says so, in which case it is **labelled `inferred`**, waits until the state has lasted a few seconds so it does not flicker, and starts with running tests going to the QA bench. Reduced motion means nobody walks.
- [ ] 5c: Handoffs, each a picture of a recorded event: a task card from the mission board to the assignee, submitted work landing in your inbox, checks on the QA bench, a reviewer walking to the reading room (where their agent really is working), a message carried between desks, accepted work stamped

> The MVP bar is met at the end of Phase 5: open a repo, run a real agent in an isolated worktree, have it verified by an independent reviewer with evidence, and watch it happen in the office.

## Later

- **Phase 6 — Life simulation:** coffee, tea, water, snacks, meetings, rest (always optional, always labelled as simulation)
- **Phase 7 — Customisation:** character, role, office and department editors
- **Phase 8 — GitHub:** issue → plan → implement → verify → PR
- **Phase 9 — Polish:** replay, cinematic camera, analytics, themes, accessibility, performance
- More providers: Codex, Gemini CLI, generic CLI
- Windows and Linux builds ([details](PLATFORMS.md))

Have an idea or want to take something on? Open an issue — see [CONTRIBUTING.md](../CONTRIBUTING.md).

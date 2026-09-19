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
│  MissionService         (missions, tasks, the graph and every status rule)      │
│  Dispatcher             (hands ready tasks to reported-idle agents)            │
│  MessageService/Router  (conversations, loop protection, delivery)             │
│  CircuitBreaker         (watches events; limits, pauses and refuses calls)     │
│  Teams                  (managers, reporting lines; who may message whom)      │
│  McpEndpoint            (the tools an agent calls: tasks, teammates, messages) │
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

| Area                | Location                                | Notes                                                                                                           |
| ------------------- | --------------------------------------- | --------------------------------------------------------------------------------------------------------------- |
| Provider interface  | `src/main/providers/types.ts`           | `ProviderAdapter` + `ObservationChannel` + provider-neutral `AgentSignal`                                       |
| Claude Code adapter | `src/main/providers/claude-code/`       | Detects `claude` (PATH, common dirs, editor-bundled binaries), builds the launch and the hook settings          |
| Demo adapter        | `src/main/providers/mock/`              | A scripted agent in a real PTY; everything it reports is labelled `simulated`                                   |
| Runtime             | `src/main/agents/runtime.ts`            | Start / stop (graceful, then forced) / interrupt / write / resize; bounded scrollback with stream offsets       |
| Report listener     | `src/main/agents/hook-server.ts`        | Loopback HTTP; per-agent token; see [SECURITY.md](../SECURITY.md)                                               |
| State tracker       | `src/main/agents/tracker.ts`            | Pure: signals in, events out. Every transition says how we know                                                 |
| Employees           | `src/main/employees/service.ts`         | Persisted; folder validated and canonicalised; launch settings locked while running                             |
| Terminal            | `src/renderer/components/TerminalPanel` | xterm.js; replay + live stream joined by offsets, so re-attaching loses and repeats nothing                     |
| Office              | `src/renderer/office/`                  | PixiJS isometric voxel office; the floor plan, camera, geometry, poses and bubble text are pure and unit-tested |

#### Provider adapters

One `ProviderAdapter` per kind of CLI. It **describes**; the runtime **does**:

- `detect()` — is the CLI installed, where, which version?
- `buildLaunch()` — pure: executable, arguments, extra environment, and files to write. No I/O.
- `observation` — turns the CLI's own reports into `AgentSignal`s (`turn-started`, `tool-started`, `attention`, …). Unknown or malformed input yields nothing, never an exception. It may also say how to answer a report: `continuation` (make the agent carry on with some text) and `deny` (refuse the tool call it was about to make).

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

### Missions (Phase 2, slice 2a)

A **mission** is a goal; its **tasks** form a graph (`task_dependencies`), not a flat list. A task is `pending` until every dependency is `done`, then `ready`. Dependency cycles are refused when they would be created.

```
pending ─► ready ─► in_progress ─► submitted ─► done
                        │              │
                        ▼              ▼
                     blocked     changes_requested ─► (handed out again)
```

**`submitted` is a claim; only a person makes a task `done`.** The agent's summary is shown as _what the agent says it did_, never as fact. Checks and an independent review (below) give evidence, and neither changes a task's status: only a person does.

`MissionService` owns every transition, so the rules hold whoever asks — a person, the dispatcher, or an agent's tool call. Each change is one transaction, and its events are published only after it commits. An agent may only touch the task it was handed.

**Dispatch.** While a mission is Running, the `Dispatcher` gives a ready task to its assignee only when all of these hold: the agent is running, its idle state was _reported_ (never a guess, never while it waits on a permission prompt or is starting up), and it has no other task. The claim on a task is atomic, so it can never be handed out twice; a failed delivery undoes the claim. The briefing is pasted into the agent's terminal as one bracketed paste followed by Enter. There is no hook that can inject a prompt into an idle Claude Code session, so this is the only way to wake one, and it is why the rules above are strict.

**Reporting back.** Each agent is given a Shokuba MCP server (`--mcp-config`, over the same authenticated loopback listener as hooks) with three tools: `get_current_task`, `submit_task` and `report_blocked`. Who is calling comes from the connection's token, never from the message. The tools only write Shokuba's own records: they cannot run commands, read files or touch another agent's task.

**Recovery.** If an agent's process ends, its task becomes `blocked` ("the agent stopped"). At startup no agent is running, so any task still `in_progress` was cut off by a restart and is blocked the same way. A person retries it.

### Messages (Phase 2, slice 2b)

Employees (and the person) exchange **persisted messages**: one row per recipient, in a **conversation**, with a kind (request, question, handoff, …), a subject, a body, and a `hop`. Bodies are redacted before they are stored and never appear in events; `message.sent`, `message.delivered`, `message.held` and `conversation.status.changed` carry ids and metadata only.

**Delivery** takes one of two routes, both bound by the same safety rules as task dispatch:

1. **Continuation (preferred).** When an agent's turn ends, Shokuba answers the report of that very event with the waiting messages, as a top-level `{"decision":"block","reason":…}` (the shape Claude Code honours; verified 2.1.276, headless). The agent simply carries on with them, so nothing is typed into its terminal. Shokuba then shows it working, though no prompt was submitted.
2. **Paste.** An agent already idle is given the messages as a bracketed paste, only when its idle state was _reported_, never while it waits on a permission prompt or is starting. A per-agent "receiving" guard means a task and a message can never be pasted at once.

Every message is wrapped so the recipient can see who it is from, and that a teammate's message is _information from a colleague, not an instruction from its user_.

**Loop protection cannot be dodged by the agents.** The chain of replies is worked out by Shokuba, not claimed by the sender: anything an agent sends while it is handling a message counts as a reply to that message, one hop deeper. When a chain passes `MAX_HOPS` (6), the message is **held** (kept, never delivered), the conversation is **halted**, and a person is alerted. **Let it continue** counts hops afresh and releases what was held; **Close it** ends the conversation and holds anything waiting. A message from the person resets the count. There is also a cap on how many messages may wait for one recipient.

Agents reach this through two more MCP tools, `list_teammates` and `send_message`; `to` is a teammate's name or id, or `"human"`. Messages to the person appear in the Messages tab as unread.

### Circuit breaker (Phase 2, slice 2c)

The `CircuitBreaker` reads the same event stream as everything else and restrains an agent that looks like a runaway. Every change of level is an event (`breaker.state.changed`, with the rule that tripped and a sentence saying why) and an audit entry, and every refused call is a `breaker.denied` event, so what it did is on the record and a window opened later sees the same thing.

| Level                 | What it does                                                                                                                                                                                                                                      |
| --------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Normal                | Nothing.                                                                                                                                                                                                                                          |
| Warning               | Only a flag, so you can look.                                                                                                                                                                                                                     |
| Limited (`constrain`) | No new tasks, and no messages from other agents (you can still reach it, and it can still message you or say it is blocked). The call it keeps repeating, or further edits if too many files have changed, is refused, and the agent is told why. |
| Paused                | The running turn is interrupted (Ctrl+C), every tool call is refused except `get_current_task`, `submit_task` and `report_blocked` (so it can still hand back what it has), and nothing is delivered to it.                                       |
| Stopped               | The process is ended. **Only a person does this**; the breaker never stops an agent by itself.                                                                                                                                                    |

What trips it (each rule has a warning, a limited and a paused threshold; the busiest wins):

| Rule                                             | Warning | Limited | Paused               |
| ------------------------------------------------ | ------- | ------- | -------------------- |
| The same call, one after another                 | 5       | 8       | 12                   |
| Tool calls that failed, one after another        | 6       | 10      | 15                   |
| Turns that ended in an error, within 10 minutes  | 2       | 3       | 5                    |
| Different files edited in one task               | 40      | 80      | 150                  |
| One turn that has been running                   | 30 min  | 90 min  | never, by time alone |
| Conversations halted as loops, within 30 minutes | 1       | 2       | never, by that alone |

It escalates by itself up to **Paused** and never lowers a level by itself, except that a warning fades after ten quiet minutes. **Reset** (a person) returns an agent to normal and forgets what tripped it; **Pause** lets a person pause an agent by hand; starting an agent again gives it a clean slate. The thresholds are defaults in `src/main/breaker/rules.ts`, not settings yet.

**How a refusal works.** A tool call is reported to Shokuba just before it runs (Claude Code's `PreToolUse` hook), and Shokuba's answer to that very report can refuse it. Claude Code then does not run the tool and tells the model the reason (verified against 2.1.276, headless). Because a refused call never finishes, Shokuba reports it as finished-and-not-ok itself, so the agent does not look stuck in the middle of it, and the breaker does not count its own refusals as the agent's failures. An agent that ignores a refusal and keeps retrying is caught by the repeat rule and paused. Lifting a restriction is itself an event the dispatcher and router react to, so a held task or message is sent without waiting for anything else.

**What it cannot see.** Be honest about these:

- "The same call" means the same tool with the same short summary (for example `Run npm test`), not byte-identical arguments.
- Hooks see tool calls, not what happens inside one: a loop inside a single shell command is invisible, and files changed through the shell are not counted as edits.
- A refusal only works if the CLI honours it. That is verified for Claude Code in headless mode; an interactive session is not yet verified. Pausing also writes Ctrl+C to the terminal as a backstop, and **Stop** always works.
- **There is no spend limit.** Claude Code's hooks report no cost or token counts, so budget cannot be measured. Time and repetition are.
- Levels are held in memory. Agents do not survive Shokuba quitting, so nothing is lost by that; the events remain as history.

### Teams (Phase 2, slice 2d)

An employee is a **manager** (`is_manager`), who talks to the person, or reports to one (`reports_to`, a manager's id). A team is a manager and the people who report to them, so there is no team table. Two levels only: a manager reports to the person, never to another manager. `instructions` holds what the role is for, on top of the one-word `role`; it is the employee's own copy, filled from a built-in template (`src/shared/roles.ts`) if you like, so editing a template never rewrites anyone.

**The communication rule.** Managers talk to the person. Everyone else talks to their manager and to their teammates as needed, **but not to the person**: when they need a decision, an answer or access, they ask their manager, who takes to the person only what needs the person. This is enforced in `MessageService.sendFromAgent`, not left to the agent's prompt: a message from an employee who has a manager, addressed to `human`, is refused with a reason that names the manager. Nothing is created (no message, no conversation, no event). The rest is unchanged:

- An employee with **no manager** (everyone before teams existed) can still message the person.
- The **person can write to anyone**, manager or not. That is how you steer an agent that is stuck or looping.
- Teammates can message each other freely, under the same hop limit and circuit breaker as before.

When an employee reports `report_blocked`, their manager is also sent a `warning` message with the reason and the task, so the person does not have to relay it. If that message cannot be sent (the manager's inbox is full, or the conversation is halted) the task is blocked all the same.

**Interplay with the circuit breaker.** A limited employee may not message teammates, but may still reach whoever it answers to: its manager, or the person if it has none. The breaker's advice to an agent names that contact.

**What each agent is told.** At launch the agent's system prompt says what its role is for, who its manager is (and that it does not message the person directly), or, for a manager, who reports to them and that they are the one who talks to the person. `list_teammates` shows the same structure. **The prompt is read when the agent starts**, so if you change someone's role, instructions or team while they run, they hear about it at their next start; the messaging rule itself is checked live on every message, and `list_teammates` is always current.

**Limits.** The rule governs the message channel, not what the person can see: an agent's terminal and its task summaries are still visible to you. A manager who is wrong or manipulated can still mislead you, and an employee can still mislead their manager. A manager can also draft missions for their team (see below), but never run them.

### Manager planning (Phase 2, slice 2e)

A manager's agent can plan work for its team, but only as a **draft**. Five extra MCP tools are offered to managers and to no one else (`tools/list` leaves them out for everyone else, and calling one by name answers as if it did not exist):

| Tool            | What it does                                                                                                                                |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `draft_mission` | Starts a draft mission, recorded as the manager's (`missions.created_by`, migration 0006).                                                  |
| `add_task`      | Adds a task to one of the manager's drafts: assigned to the manager or someone who reports to them, with dependencies by id or exact title. |
| `remove_task`   | Removes a task from one of the manager's drafts.                                                                                            |
| `get_draft`     | Shows a draft (or lists open drafts) so the manager can check the plan before telling the person.                                           |
| `team_status`   | Read-only: who reports to the manager, whether they are running, and what they are on.                                                      |

The rules live in one place, `ManagerPlanning` (`src/main/missions/planning.ts`), and the tools only translate to and from text. A manager may change only a mission **it drafted itself**, only while it is still a **draft**, may assign only to **itself or its own team**, and may have at most 3 open drafts of 25 tasks each. It cannot run, pause, cancel or archive a mission, and cannot accept, retry or change anything a person or another manager created. Everything else is the ordinary `MissionService`, so titles, dependencies, cycles and control characters are checked exactly as for a person. Events for what a manager does carry `source: reported` and the manager's id, so the log says an agent did it.

A plan only becomes real when a person presses **Run mission**, and a person still accepts each task. The Missions tab says who drafted a mission, and, while it is a draft, that nothing has been sent. The manager is told (by its instructions) to message the person when a draft is ready.

**Limits.** These are guardrails, not a judgement of the plan: a manager can still draft a poor, padded or misleading plan within the caps, and you are the one who reads it. The caps are constants in `planning.ts`, not settings. Nothing stops a draft's tasks being assigned to people who are busy; the dispatcher's usual rules decide when each is sent once you run it.

### Git (Phase 3, slice 3a)

`GitService` (`src/main/git/`) is the layer tasks will use to work in isolation: a branch and a working folder per task, a diff to review, and merging accepted work. Slice 3b connects it to dispatch and to accepting a task (next section).

**The model.** A mission gets a branch `shokuba/mission/<id>`, cut from the repository's current commit. Each task gets `shokuba/task/<id>` and its own working folder under `<data>/worktrees/`, never inside your project. Accepting a task merges its branch into the mission branch; you merge the mission branch yourself. (Missions and tasks use separate prefixes because Git cannot hold `shokuba/x` and `shokuba/x/y` at once.)

**Merging without a checkout.** `git merge-tree --write-tree` computes the merge in Git's object store, `commit-tree` writes the merge commit, and `update-ref` moves the branch only if it is still where the merge started. No working folder is touched, so your own checkout never changes, and a conflict is an answer (the files are named, nothing is changed), not a half-merged tree to clean up. This needs Git 2.38+, and 2.40+ for the attribute setting below, so Shokuba requires **Git 2.40 or newer** and says so when it is older.

**What keeps it safe.**

- It creates or moves only `shokuba/mission/<id>` and `shokuba/task/<id>` branches, built from ids and never from text an agent wrote, and every operation checks the name, so it cannot move `main` or any branch of yours. Start points must be a full commit id or one of these branches, never a revision expression.
- Working folders are created and removed only inside `<data>/worktrees`; a path outside it is refused, so a bug cannot delete something of yours.
- Git runs with an argument list, never through a shell, with a time limit and a cap on the output it reads.
- A repository's **hooks** never run from these commands (`core.hooksPath` points at an empty folder), and the **filters and merge drivers its attributes name** never run (attributes are not read). Otherwise a repository an agent had written to could make Shokuba run a command for it, at the moment you accept a task. Diffs disable external diff programs and text conversion.
- A branch is moved only if it is still where the merge started, and never while it is checked out in a working folder.
- Commands that change one repository run one at a time.
- Commits are made with a per-command identity (`Shokuba (name)`, an address that can never be real), so **your own Git settings are never read or written** for authorship or signing.

**Limits.** Attributes are ignored by Shokuba's own commands, so files a repository stores with Git LFS are committed as they are on disk, custom merge drivers do not run, and line-ending rules from `.gitattributes` are not applied (your own `core.autocrlf` still is). A task's folder is a fresh checkout, so dependencies such as `node_modules` are not there: the agent has to install them, and Shokuba does not run setup commands. Committing takes everything that is not ignored, so a secret file the project does not ignore would land in the local task branch (it is never pushed). This isolates work; it is not a sandbox, since an agent can still run Git commands that reach elsewhere.

### Task isolation (Phase 3, slices 3b and 3c)

`WorkspaceService` (`src/main/workspaces/`) decides whether a task is isolated and how, using `GitService`. Two tables record it (migration 0007): `mission_branches` (one branch per mission and repository) and `task_workspaces` (a task's branch, folder and commits, and `state`: `active`, `merged`, `none` or `removed`; `none` carries the reason it was not isolated).

**Handing a task over.** In the dispatcher's pass, for a task whose assignee's folder is in a Git repository:

1. The task's working folder is made (or reused, if it is being handed out again): a branch `shokuba/task/<id>` cut from the mission branch, which itself is cut once from the repository's current commit. An employee who works in a subfolder of the repository keeps working in that subfolder.
2. The agent is **restarted in that folder** and Shokuba waits until it has reported idle. An agent's file access starts in the folder it was launched in, so this is what makes the isolation real, not a request. This happens **before** the task is claimed: stopping the agent publishes `agent.stopped`, which the dispatcher reads as "the agent died mid-task", so restarting after the claim would block the task it was about to hand over.
3. The task is claimed and the briefing is pasted, with a note saying where the agent is working and that Shokuba saves its work. An agent that is already in the right folder (a task sent back to it) is not restarted.

**Saving and reviewing.** When the agent calls `submit_task`, its work is committed **before** the task shows as submitted (author `Shokuba (name)`), so a submitted task never lacks its changes. The task detail shows the changed files and a diff, read through `tasks.changes` and rendered as plain text.

**Accepting.** `TaskWorkflow` merges the task's branch into the mission branch before accepting the task, so tasks that depend on it start from it. If it conflicts with work accepted earlier, the task is **not** accepted: it goes back to its agent as "changes requested" with the files named and the steps to fix it (merge the mission branch in its own folder, resolve, submit again), and nothing on the mission branch changes. **Your own branches are never touched and nothing is pushed**; the mission branch is yours to review and merge.

**When a task cannot be isolated** (the folder is not a repository, it has no commits, Git is missing or older than 2.40, or the working folder could not be made) the task runs in the employee's own folder exactly as it always did, the task detail says why, and an agent left in an earlier task's folder is put back in its own. A Git problem never fails a task.

**Limits.**

- **A fresh agent session per task:** slower to start, and the agent does not remember earlier tasks. A stuck login screen on the restarted agent leaves the task waiting, unclaimed, until the wait (90 seconds) runs out and it is tried again.
- The mission branch is cut from the repository's **last commit** when the mission's first task is handed out. Uncommitted changes in your checkout, and commits made to your branch later, are not in it.
- A task's folder has no installed dependencies (for example `node_modules`); the agent has to install them.
- Everything not ignored in the folder is committed to the local task branch, including a secret the project does not ignore. Nothing is pushed.
- The agent can run Git in its folder, including switching branches or merging. Shokuba merges `shokuba/task/<id>` as it finds it.
- An idle agent stays in its last task's folder until its next task or until it is stopped, so that folder is kept until then (see below).
- **Task branches are kept**, so a busy repository collects `shokuba/task/…` branches. They are all under one prefix (`git branch --list 'shokuba/*'`) and are safe to delete once their mission's branch has been merged.

**Cleaning up (3c).** `WorkspaceCleaner` removes a finished task's working folder when the task is done or cancelled **and no running agent is in the folder**: after the task is accepted or cancelled, when its agent starts on something else or is stopped, and once at startup for anything an earlier run left. It never restarts an agent just to delete a folder, and a running process inside a folder would in any case keep it from being deleted on Windows. The rules, in `WorkspaceService`:

- Only folders Shokuba recorded itself, inside its own data folder, and only for a task that is merged or cancelled. A finished task whose work was never merged is left alone, not guessed at.
- **Unsaved work is saved first.** Whatever is uncommitted in a cancelled task's folder is committed to its branch before the folder goes, and if that cannot be done the folder is left exactly as it is and tried again later.
- The branch stays and the diff stays reviewable; the record notes when the folder was removed (`removed_at`, migration 0008). If a removed task is worked on again, its folder is brought back on its branch.
- "Is an agent in this folder?" compares resolved paths as well as the stored one, because the same place can be spelled two ways (a symbolic link, a short Windows name) while the runtime reports the agent's folder resolved. Getting this wrong would delete a folder from under a running agent; the smoke test caught exactly that on macOS.

**Merging is yours.** Each mission shows the branch its accepted work is collecting on (`shokuba/mission/<id>`), how many commits it holds, and the commands to read and merge it, each naming the repository and quoted for your shell. Shokuba never runs them.

### Checks (Phase 4, slice 4a)

A person defines, per project (a repository Shokuba has worked in), an ordered list of commands: **setup** steps such as `npm ci`, then **checks** such as `npm test`. Shokuba runs them on the work an agent submits and keeps what happened. Three tables (migration 0009): `project_checks_settings` and `project_checks` (the person's commands and when they acknowledged the notice), `check_runs` (one run against one commit) and `check_results` (each step **as it ran**, so a later edit never rewrites what was verified).

**Where the commands come from is the security decision.** They live in Shokuba's own database and are set only through the UI (a project path sent from the page is checked against repositories Shokuba has worked in). They are **never read from the repository**, so an agent that can edit its branch cannot add a command or weaken one, and **nothing an agent wrote is ever placed in a command**: the command string is fixed and only the folder it runs in varies. Suggestions ("from the project's files") read a fixed list of file names from the person's own checkout, turn only known script names into commands, and are just a form to fill in that the person reads and saves.

**What runs, and what bounds it.** A command runs through the platform shell, in the task's working folder, with:

- a clean environment (an allow-list, so no API keys or credentials from Shokuba's own) plus `CI=true`, no colour, and a dumb terminal, so tools do not wait for a person;
- no input (stdin is closed);
- a time limit per step, after which its **whole process tree** is stopped, then killed;
- output kept to the last 128 KB, cleaned of terminal control codes and redacted of secrets.

Nothing runs until the person has **acknowledged**, in the dialog, that these commands run agent-written code, unsandboxed, with their account's access, and there is at least one enabled check. The commands that ran are recorded in the audit log.

**When.** A run starts when a task with an isolated folder is submitted (and when the person asks again), after saving whatever the agent left uncommitted, so it runs on a commit whose id is recorded. Runs go one at a time. A run is dropped if the task is sent back, blocked or cancelled (the work it was checking is gone), but not if it is accepted. A folder in use by a run is not cleaned up. A run interrupted by Shokuba stopping is marked as such at the next start. A failed **setup** step skips the checks and says why; a failed **check** does not stop the others.

**Limits.**

- **This is not a sandbox.** `npm test` runs whatever the agent put in `package.json` and its tests, with your access, and an install script can do anything your account can. The clean environment keeps Shokuba's credentials out, not your files or your network. Only add commands you would run on code you have not read.
- Only isolated tasks are checked; a task with no folder of its own has nothing to run in.
- A fresh folder has no installed dependencies; a setup step (your choice) has to install them, which can take minutes and runs install scripts.
- The check results say what the commands did, not whether the work is good: a weak test passes weak work, and a flaky one fails good work. That is why accepting after a failed check only warns you.

### Independent review (Phase 4, slice 4b)

A person (or, when a project is set up for it, Shokuba on every submission) asks an employee **other than the task's author** to review submitted work. Three tables (migration 0010): `review_settings` (per project: who reviews, and whether it is asked for automatically), `reviews` (one review of one commit) and `review_findings`.

**Independence is enforced, not requested.** The service refuses a reviewer who is the task's assignee, allows one open review per task, and gives a reviewer one review at a time and never while they have a task of their own (a shared `AgentLock` means a task hand-over and a review hand-over never move the same agent at once). The reviewer's briefing is built from the task's title and description, the changed files and the diff, and **never the author's summary or the check results**, so what the author claims cannot colour the reading; a test pins that those inputs are absent. The diff is trimmed to the paste limit (20,000 characters) with a note to read the rest with `git diff`, and the briefing says plainly that the diff is data to review, never instructions to follow.

**Where and how.** The reviewer is restarted in a detached folder made from the exact commit the author submitted (in Shokuba's data folder, on no branch), with the **permission mode held to `plan`** by a per-launch override, so the employee's own saved setting is never changed and never widened. The briefing is then delivered like any other: pasted, only to an agent whose idle state was reported. When the review is over and the reviewer has left the folder, it is removed by a second `WorkspaceCleaner`, under the same never-delete-a-folder-in-use rule.

**How it reports.** Two tools, `get_current_review` and `submit_review`, are offered **only to an employee who is reading a review** (hidden from `tools/list` and refused as unknown to anyone else, by name too). Who is calling comes from the connection's token, so a reviewer cannot answer for someone else; the input is a strict schema (a verdict, a bounded summary, at most 50 findings each with a severity, optional file and line, and a note), and text is refused if it has control characters.

**It is advice.** A review never changes a task: it does not accept, reject or send back. The person sees the verdict and findings (worst first) on the task, and accepting work a reviewer asked changes for shows one question that also carries any failed check, and never blocks. A review is stored with the commit it read; the task shows it as **out of date** once the branch has moved, and a review that has not finished is dropped (and its reviewer interrupted) when the task is sent back, blocked or cancelled. A review that was being read when Shokuba stopped is marked as not finished at the next start.

**Limits.**

- The reviewer reads code an agent wrote, and that code can contain text aimed at the reviewer. The briefing warns about it and plan mode stops edits, but a model can still be misled into approving, which is why the verdict only advises.
- Plan mode is the agent CLI's own setting, not a sandbox: it limits what the reviewer edits, not what a command they run can reach.
- A reviewer reads; it does not run the code or the checks. What the reviewer says is one model's opinion of a diff, and it can be wrong in either direction.

### Evidence pack (Phase 4, slice 4c)

An evidence pack is a folder of what Shokuba recorded about one task, saved on request. It adds **no tables and no event types**: it reads what the other slices already keep, so it cannot change any of it. [A sample report](examples/evidence-report.md).

**What is read.** `EvidenceCollector` gathers the task and its mission, the workspace record (branch, where it started, where it ended, the merge commit, kept after the folder is gone because the branch stays), the task's own commits (first-parent only, so work merged in from another task is not counted as this one's), the changed files and the diff, every run of the checks with each step's exit code and output, every review with its findings, and the task's events from the append-only event log. **Who accepted it comes from that log**: the `task.status.changed` to `done` and the `source` it was recorded with (`user` for a person's action through the app), never from anything an agent said. Each check run and review is marked as being of the commit the work **ended at** or an earlier one, or unknown, so a pack can show that the checks passed on something other than what was accepted.

**What is written.** `report.md` for a person, `evidence.json` for a machine (`schemaVersion` 1), `changes.diff`, and `checks/run-N-step-M-name.log`. The report's opening summary is built from counts and states only. Every piece of text someone else wrote (task text, the agent's summary, a reviewer's words, names, commit subjects, commands, notes) is shown as a **code span or a fenced block whose fence is longer than anything inside it**, with control characters and text-direction overrides removed first, so it cannot become a link, an image that loads from the internet, HTML, a table cell boundary or a heading. Tests feed hostile text through every field and check that nothing outside a code span or fence contains it.

**Secrets.** Text in the pack goes through the same redactor as everything Shokuba stores. The diff is the exception, because a diff that has been edited is not the change: it is kept exactly as Git produced it and **scanned** instead (`scanSecrets`, using the redactor's own rules), and the pack and the dialog say which kinds were found and how many, without repeating them. A diff with control characters (such as terminal escape sequences) is flagged too. In the fields Shokuba writes itself the pack holds only the project's folder name and never a full path (a note that names one has it replaced), though what the checks printed and the code itself are kept as they were and can hold any path; and every time is in UTC, so it does not carry the timezone of the machine that made a commit.

**Writing it safely.** The destination is chosen by the person in a native folder dialog that the main process shows; the page only names the task, and a path sent from a page is never written to. The exporter makes a **new** folder (`-2`, `-3`… if the name is taken, and a link in the way is not followed), creates every file only if it does not exist (so nothing is overwritten and a link planted between steps is not followed), makes every name itself from plain characters (a step called `../../x` becomes `x`), and if writing fails part-way removes what it made, so a half-written pack never looks whole. Folder and files are private to the user where the OS supports it. Each export is recorded in the audit log (the folder's name, not its path).

**Limits.**

- **A pack is a record, not a proof, and it is not tamper-proof.** It is built from Shokuba's database and Git repository on the same computer, and it is not signed: anyone who can change those can change what a pack says. A signature would need a key kept somewhere the person and the agents cannot both write, which is not built.
- What a pack says about the work is only as good as its sources: a weak check passes weak work, a review is one model's opinion, and the agent's summary is its own claim (it is labelled as one).
- Redaction is by pattern, not a guarantee. Read a pack before you share it, especially its diff.
- Only the newest 200 commits, 20 runs of the checks, 20 reviews and 500 timeline entries are kept, and a diff over 5 MB is cut; the pack says when any of that happened.

### Database

Tables are added by migrations _when a feature needs them_ — never speculatively. Today: `agent_events`, `audit_log`, `schema_migrations`, `employees`, `missions`, `tasks`, `task_dependencies`, `conversations`, `messages`. Both logs are append-only, enforced by database triggers rather than convention. Employees are archived, not deleted, because events refer to them. Native modules (`better-sqlite3`, `node-pty`) are N-API, so the same binaries run under Node (tests) and Electron (app) with no rebuild step.

### The office

PixiJS 8 draws an original isometric-voxel office: each employee has a desk, a chair and a small block person whose pose follows their state (typing while coding, a raised hand when they need you). A status bubble above them says the state and what they are doing, and marks it `inferred` or `demo` when it is not a fact. The renderer imports PixiJS's `unsafe-eval` build, so the strict Content-Security-Policy stays as it was (no `unsafe-eval`).

**The plan is data.** `map.ts` builds the floor plan for a team of a given size, as plain rectangles: rooms, doors, tall walls on the two far sides, low partitions between rooms (in 0.25-tile pieces, so door edges land where they should), desk slots, props, and the shared places (each with a footprint and somewhere to stand). It is deterministic, and growing the team only ever adds: the rooms, desks and places already there never move. Tests check, for every team size, that nothing overlaps, that every door has a clear way through, and that every place has clear floor to stand on, which is also what makes the plan safe to walk on in slice 5b.

**One depth-sorted layer.** Everything that stands on the floor (a desk with its person, a run of wall, a plant, a piece of furniture) is one item in a single layer sorted by how near its centre is to the camera, so a person, a desk and a wall are drawn in the right order however they are arranged. Walls are split into short runs for exactly this reason.

**The camera is pure maths** (`camera.ts`): a point of the drawn world held at the centre of the panel, and a zoom measured against the size at which the whole office just fits, so the picture keeps its proportions when the window is resized or a room is added. Zooming keeps the point under the pointer still; the centre can never leave the office; following eases toward a target and brings the view in to a comfortable zoom, or jumps with reduced motion. Bubbles, names and place tags are drawn outside the scaled world so their text stays crisp, and shrink (down to a floor) as the office is squeezed into a small panel, so neighbours do not overlap.

**The shared places stand idle.** The board is bare, the bench's screens are dark and the trays are empty: nothing on them is shown until it is a picture of something recorded, so an idle office never looks busy. That is added on top of them in slice 5c.

The office has up to twelve desks; more employees than that are counted but not drawn.

**Walking (slice 5b).** Three small pure modules, each tested on its own, and the scene only draws what they say.

- `nav.ts` cuts the floor into half-tile cells and marks a cell free if a walker's body, standing at its centre, would be on the floor and clear of every desk (empty ones too, so paths do not change as people are hired), wall, plant and piece of furniture. A\* moves eight ways and never cuts a corner, and the result is straightened wherever the way is clear. A seat sits inside a blocked cell by design, so a person first steps out of it to the side (looking outward until it finds free floor, and never onto a pocket that leads nowhere). Tests prove, for every team size, that every place, door and seat is on one connected floor, which is what caught two reading desks that could not be reached, before anyone tried to walk to them.
- `walker.ts` moves one person along a path on a clock that is passed in: speed, which way they face, the swing of their legs, standing up from and sitting down into a seat, and never carrying time past the end of a path.
- `director.ts` decides who goes where from what agents are doing and what time it is. It is a table of rules (today one: a `testing` state goes to the QA bench, after three seconds, and back two and a half seconds after it ends), which is all a later slice needs to add to. It refuses to twitch (nothing happens for a state that has not lasted, and leaving lingers), gives each place a limited number of spots, and does nothing at all with reduced motion.

**What walking claims, and does not.** A person at the QA bench means only that the agent ran a shell command that looks like a test run. That is a guess (a command can look like a test run and not be one), so the bubble says so: _at the QA bench_, marked `inferred` (or `demo` for the simulated agent), even when the state itself was reported. The bench's screens stay dark: nothing on the bench pretends to be running anything. Nobody walks for a guess that lasts less than three seconds, or when the operating system asks for reduced motion.

Handoffs of work (5c) are not built yet.

## Planned

### More providers

Codex, Gemini CLI and a generic CLI. They implement the same `ProviderAdapter`; if a CLI has no hooks, its `ObservationChannel` can parse structured output, and only as a last resort terminal text — always labelled `inferred`.

### The living office

Pathfinding on the plan, walking employees driven by recorded events, and visible handoffs (Phase 5, slices 5b and 5c). Life simulation (coffee, breaks, naps) is Phase 6: it only runs while an agent is idle or waiting, is switchable, always labelled as simulation, and never sends anything to an agent.

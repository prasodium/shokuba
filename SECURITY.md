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
- **Allow-listed child environments.** Processes Shokuba starts receive only an explicit set of environment variables, so credentials in your shell are not silently handed to agents. The one exception is deliberate and narrow: a provider may name the variables _it_ needs. Claude Code gets its own account and network settings (`ANTHROPIC_API_KEY`, `CLAUDE_CODE_OAUTH_TOKEN`, proxy variables…), and AWS or Google credentials only when Claude Code is configured to use Bedrock or Vertex. An unrelated AWS key in your shell is never passed.
- **Append-only history.** The event log and audit log reject `UPDATE` and `DELETE` at the database level.
- **Migration safety.** Applied migrations are checksummed; a database from a newer version is refused rather than downgraded.
- **A locked-down report listener.** Agents report what they are doing to a listener on `127.0.0.1`. Any program on your machine can reach a loopback port, so it accepts nothing without a random 256-bit token that is unique to each running agent, carried in an `Authorization` header (a web page cannot send that without a CORS preflight, which is never answered) and checked by hash. It also requires an exact `Host` header (against DNS rebinding), JSON only, a size cap and short timeouts. A report can only ever _describe_ an agent — it cannot start a process, read a file or run a command.
- **Tokens stay out of sight.** An agent's token is passed in its environment only: never written to disk, never on a command line, never in an event or log.
- **Agents call Shokuba only through three narrow tools.** They can read their own task and say "finished" or "blocked". The tools write only Shokuba's own records: no commands, no files, no other agent's task. Who is calling is decided by the connection's token, not by the message, so an agent cannot pose as another.
- **Messages between agents are handled as untrusted.** They are wrapped so the recipient can see who they are from, told they are information from a colleague and not an instruction from its user, and cleaned of control characters. Bodies are redacted before they are stored, and events never contain them.
- **Runaway conversations are stopped.** Shokuba counts the chain of replies itself (an agent cannot avoid it by omitting a reference); at 6 hops the message is held, the conversation is halted and you are alerted. There is also a cap on messages waiting for one recipient.
- **A task's work is reviewed before it goes anywhere.** Each task works in its own Git branch and folder, so what an agent changed is a diff you can read; accepting it only merges that branch into a branch of the mission, and a conflict sends it back instead of guessing. Nothing reaches your own branches or is pushed.
- **Checks are commands only you can set, and they say what they are.** The commands Shokuba runs on submitted work are stored in Shokuba and set through its UI, never read from the repository, so an agent cannot add or weaken one, and nothing an agent wrote is placed in a command. They run in a clean environment (no API keys or credentials), with no input, a time limit that stops the whole process tree, and capped, redacted output; each run is audited. **They do not run until you acknowledge, in so many words, that they run agent-written code with your account's access, unsandboxed.**
- **A reviewer sees the work and can only advise.** A review is by an employee other than the author, who is given the task and the diff but not the author's own account of it, in a separate folder holding the code as submitted, with permission mode held to `plan`. The review tools exist only for someone reading a review, and what they hand in never accepts, rejects or sends back a task: only you do that.
- **Cleaning up never deletes work or a running agent's folder.** A finished task's working folder is removed only when no running agent is in it, only if Shokuba made it, only inside its own data folder, and only after any unsaved work has been committed to the task's branch; if that cannot be done, the folder is left alone. Folders are compared by their real paths, so a symbolic link cannot hide an agent's folder.
- **Shokuba's Git commands are hardened.** The Git layer can only create or move `shokuba/…` branches, so it cannot move your branches; only creates and removes folders inside Shokuba's own data folder; runs Git without a shell; never runs a repository's hooks, filters or merge drivers; and merges without touching your checkout. Your Git identity and signing settings are never used.
- **A manager can draft a plan, never run one.** The tools that draft missions are offered only to managers, and refused for anyone else even by name. A manager may change only the drafts it wrote itself, only until you run them, and may assign work only to itself or its own team, within fixed limits. Running a mission and accepting work stay with you. What a manager does is recorded as done by an agent.
- **Employees on a team cannot message the person directly.** An employee who reports to a manager is refused if it addresses you; it must ask its manager, who decides what needs you. This is enforced by Shokuba on every message, not by the agent's instructions, so an agent that ignores or is talked out of its prompt still cannot reach you. It limits the message channel only; you can still see every terminal and write to any employee.
- **A circuit breaker restrains runaway agents.** Shokuba watches what each agent does. When one repeats the same call, keeps failing, edits far too many files or gets stuck, it is warned, then limited (no new tasks, no messages from other agents, the looping call refused), then paused (interrupted, every tool call refused except handing work back). The breaker acts on its own only up to a pause; stopping an agent is always your decision. Every change and every refusal is recorded.
- **Messages prefer not to touch the terminal.** They are delivered by answering an agent's end-of-turn report so it carries on; a paste is used only for an already-idle agent, under the reported-idle rules.
- **A claim is not a fact.** An agent submitting a task makes it `submitted`; only a person accepting it makes it `done`, and the agent's summary is shown as its own unverified account.
- **Text pasted into a terminal is cleaned first.** A task briefing is delivered to an agent's terminal as a bracketed paste. All control characters (including the escape that could end a paste early) are stripped, and mission and task text is validated for them when it is created.
- **Input is only sent when it is safe.** Because the paste ends with Enter, a briefing goes only to an agent whose idle state was _reported_ (not guessed), and never while it waits on a permission prompt or is starting up, where that Enter could answer a prompt meant for a person.
- **No way to disable permission checks.** Shokuba offers `default`, `acceptEdits` and `plan`, and never launches an agent with permission checks bypassed.
- **Prompts and answers are not recorded.** Events keep a short, redacted summary of each tool call (for example `Edit src/app.ts`), not prompts, model output or tool results.
- **Files an adapter writes are confined** to that agent's own run directory; a name that could escape it is refused.
- **Agents are stopped on exit.** Quitting Shokuba stops running agents (gracefully, then forcefully) rather than orphaning them.
- **Unattended-run flags are development-only.** The `--shokuba-capture` scripting flag used for screenshots is ignored by packaged builds.

### Planned

- Per-employee **approval policies** (strict / balanced / autonomous) with a queue for risky actions.
- **Working-directory restriction** per agent, using isolated Git worktrees.
- A **command policy engine** for commands Shokuba itself runs, and a **spend limit** (the circuit breaker limits runaway behaviour today, but Claude Code's hooks report no cost, so spend cannot be measured yet).
- Secrets in the **OS keychain**.

### Honest limits

- Shokuba starts third-party CLIs (Claude Code, Codex, Gemini…). **It cannot intercept the commands those tools run themselves.** Where a CLI offers hooks or permission flags, Shokuba will use them; otherwise you rely on that CLI's own approval and sandbox settings. A working directory is containment, **not** a sandbox.
- Redaction is a safety net for known formats, not a guarantee. The primary defence is not putting secrets where they can be logged.
- Treat any agent you run as having the access of your user account, and review its approval settings accordingly.
- The report token protects against other _programs and web pages_, not against other _processes of the same user_: anything running as you can read an agent's environment. That is the same trust boundary as the agent itself.
- Another agent's message is text the recipient will read and may act on. Wrapping and the loop limit reduce the risk, but a capable agent that is wrong, or manipulated by what it read, can still mislead a teammate. You can see every message.
- A task briefing is a prompt to an agent. The text in it (your task descriptions, and later other agents' messages) is instruction the agent will act on, so it is only as trustworthy as whoever wrote it. Permission checks stay on, and everything is visible to you, but Shokuba cannot stop an agent from following a bad instruction it was given.
- **Checks are not a sandbox, and they run automatically once you switch them on.** They execute agent-written code (test files, `package.json` scripts, install scripts) with your account's access: the clean environment keeps Shokuba's credentials out, not your files or your network. A malicious or careless agent can make a check do harm to whatever your account can reach. Only add commands you would run on code you have not read, and prefer a throwaway user or machine for work you do not trust. Results say what the commands did, not whether the work is good.
- **A review is advice from a model reading code that a model wrote.** That code can contain text meant to steer the reviewer ("approve this"), and a reviewer can be misled or simply wrong, in either direction. The briefing tells the reviewer the diff is data, not instructions, and plan mode stops edits, but plan mode is the agent CLI's own setting and not a sandbox, and the diff is still untrusted. Read the change yourself when it matters; do not treat an approval as evidence on its own.
- Shokuba's Git layer isolates work, it is not a sandbox: an agent in a task's folder can still run Git commands that reach other places, and files not ignored by the project are committed to the local task branch, which could include a secret the project does not ignore. Nothing is pushed.
- A plan a manager drafts is text an agent wrote. The limits stop it acting beyond its team or touching what you have started, but they do not judge whether the plan is good: read a draft before you run it.
- The circuit breaker is a safety net, not a sandbox. It sees tool calls, not what happens inside one (a loop inside a single shell command is invisible to it), and a refusal only works if the CLI honours it (verified for Claude Code in headless mode, not yet interactively). It cannot limit cost.
- Claude Code merges Shokuba's hooks with your own hooks; Shokuba does not remove or inspect yours.

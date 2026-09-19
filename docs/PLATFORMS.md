# Platform support

Shokuba is developed **macOS first**. Windows and Linux are designed for from the start, so adding them should be a small, contained change — this page says exactly how, and what is and isn't verified.

## Status

|                                                                                | macOS | Windows                           | Linux                             |
| ------------------------------------------------------------------------------ | ----- | --------------------------------- | --------------------------------- |
| CI: install, typecheck, lint, unit tests                                       | ✅    | ✅                                | ✅                                |
| CI: in-Electron smoke test (SQLite, restart persistence, real PTY, Git)        | ✅    | ✅                                | ✅ (headless, `--no-sandbox`)     |
| Agent pipeline: demo agent in a real PTY → hook server → events → stop         | ✅    | ✅                                | ✅                                |
| Two-agent mission: task pasted into a real terminal → MCP submit → accept      | ✅    | ✅                                | ✅                                |
| Runaway two-agent conversation stopped at the hop limit                        | ✅    | ✅                                | ✅                                |
| Runaway agent refused, held back from tasks, then paused and interrupted       | ✅    | ✅                                | ✅                                |
| Manager drafts a mission; nothing sent until run; direct message refused       | ✅    | ✅                                | ✅                                |
| Git: task worktrees, commit, merge, conflict; main and checkout untouched      | ✅    | ✅                                | ✅                                |
| A task in its own branch: agent restarted in its folder, commit, accept merges | ✅    | ✅                                | ✅                                |
| Finished task's folder removed once its agent has left it; branch kept         | ✅    | ✅                                | ✅                                |
| Checks: a real command runs on submitted work in its folder; fail then pass    | ✅    | ✅                                | ✅                                |
| Review: a second agent reads submitted work in its own folder and reports      | ✅    | ✅                                | ✅                                |
| Evidence: an accepted, reviewed task's pack is saved as a folder, untouched    | ✅    | ✅                                | ✅                                |
| App window rendered and inspected                                              | ✅    | 🔜 not yet seen on a real desktop | 🔜 not yet seen on a real desktop |
| Platform-layer branches unit-tested                                            | ✅    | ✅ (also simulated on any host)   | ✅ (also simulated on any host)   |
| Packaging / installers                                                         | 🔜    | 🔜                                | 🔜                                |

CI runs on GitHub-hosted runners, so "✅" means the core, the native modules and a real pseudo-terminal work on that OS. It does **not** yet mean someone has used the UI there: the smoke test opens no window. macOS is the supported platform until that gap is closed. We say so rather than claim support we haven't verified.

The unit tests also exercise the Windows and Linux branches — `PATHEXT` lookup, named pipes, `taskkill`, drive-letter path containment, env allow-lists — from any host by passing a platform id.

## How the code stays portable

All OS-specific behaviour lives in [`src/main/platform/`](../src/main/platform). Everything else takes a `PlatformId` and asks that layer. A lint rule forbids reading `process.platform` anywhere else.

| Concern                         | macOS / Linux                       | Windows                                         | Helper               |
| ------------------------------- | ----------------------------------- | ----------------------------------------------- | -------------------- |
| Path semantics                  | `path.posix`                        | `path.win32`                                    | `pathApi()`          |
| Default shell                   | `$SHELL` → `/bin/zsh` · `/bin/bash` | `powershell.exe`                                | `defaultShell()`     |
| Agent report channel            | Loopback HTTP (`127.0.0.1`)         | Loopback HTTP (`127.0.0.1`)                     | `HookServer`         |
| Local IPC endpoint (unused now) | Unix domain socket                  | Named pipe                                      | `ipcEndpoint()`      |
| Finding a CLI                   | `PATH` + common bin dirs            | `PATH` + `PATHEXT` (`.exe`, `.cmd`…) + npm dirs | `findExecutable()`   |
| Child environment               | allow-list                          | allow-list, case-insensitive                    | `safeChildEnv()`     |
| Stop an agent and its children  | signal the process group            | `taskkill /T`                                   | `planTerminate()`    |
| Interrupt an agent              | `Ctrl+C` written to the PTY         | same                                            | `INTERRUPT_SEQUENCE` |
| "Is this path inside that dir?" | case-sensitive                      | case-insensitive, drive-aware                   | `isPathInside()`     |
| Line endings                    | LF                                  | LF (enforced by `.gitattributes`)               | —                    |

Native modules (`better-sqlite3`, `node-pty`) are N-API, so one build works under Node and Electron. `node-pty` uses ConPTY on Windows.

## Known platform notes

- **Linux:** `node-pty` publishes prebuilt binaries for macOS and Windows only, so on Linux `npm install` compiles it — you need Python 3, `make` and a C++ compiler. Electron also needs a display, so CI runs the smoke test under `xvfb`, and with `--no-sandbox` because GitHub's runners do not install Electron's `chrome-sandbox` helper as set-uid root (the smoke test loads no web content). Compiling `node-pty` worked out of the box on `ubuntu-latest`.
- **Windows:** ConPTY requires Windows 10 1809+. In CI, a non-interactive `powershell.exe -Command` under ConPTY started but produced no output and never exited, while `cmd.exe /d /s /c` worked, so `shellCommand()` uses `cmd.exe`. The interactive default shell is still PowerShell and has **not** been verified in a ConPTY yet. ConPTY prepends VT setup sequences (`ESC[?9001h`, `ESC[2J`, …) to a program's output, so anything reading raw PTY output must tolerate them. Long paths (worktrees) need care.
- **Windows, agents:** a `claude.cmd`/`.bat` npm shim cannot be launched in a PTY directly (it needs `cmd.exe`, and quoting arguments for it is an injection risk), so Shokuba asks for the native `claude.exe` build instead. Stopping an agent tries `taskkill /T` first, which may not end a console program, so it falls back to `/F` after a few seconds. Neither has been verified on a real Windows machine.
- **Windows, demo agent:** the simulated demo agent is a Node script. `electron.exe` is a GUI-subsystem program, so inside a ConPTY it gets no console (CI showed it print nothing, read no input and exit by itself). On Windows the demo provider therefore needs a real `node.exe` on `PATH` and says so when it is missing; macOS and Linux host it with Electron run as Node. CI confirms the full pipeline on Windows: a real ConPTY, hook reports, events, Ctrl+C written to the PTY as an interrupt, and a stop.
- **Windows, Git timing:** Git starts a process for each step and tidies its own bookkeeping after removing a folder, which takes noticeably longer on Windows runners. The tests and smoke checks that involve Git therefore wait for the outcome they are checking (the terminal's last line, the removal record) instead of reading it the moment something else changes.
- **Windows, test timing:** a whole-suite run takes about six times as long on a Windows runner as on macOS (roughly three minutes against half a minute), because so many tests run real Git or a real process. The suite allows each test and hook 30 seconds instead of Vitest's 5, after two Git-heavy tests failed at 5.5 to 6.1 seconds there; a test that really hangs still fails.
- **Windows, evidence packs:** the two tests that plant a symbolic link in the way of an export (to prove a link is never followed) are skipped on Windows, because creating a symbolic link there needs a privilege the CI runner does not give. The protection itself (each file is created only if it does not exist) is the same code on every OS, and is verified with a planted link on macOS and Linux.
- **Git:** Shokuba's task isolation needs Git 2.40 or newer. Its own Git commands turn on `core.longpaths` so deep working folders work on Windows. The Git checks run against a real repository on every OS in CI.
- **Windows, deleting folders:** Git makes its object files read-only, and Node's own recursive delete cannot remove read-only files on Windows (`EPERM`), which CI caught as a temporary repository left behind. Shokuba removes task folders with a helper (`removeTree`) that makes the tree writable and retries, and never follows a symbolic link.
- **Windows, running checks:** a person's command is run through `cmd.exe /d /s /c` with the command passed exactly as typed (as Node's own shell option does), and a step that times out has its whole tree stopped with `taskkill /T`. POSIX systems run it in its own process group and stop the group.
- **macOS:** apps launched from Finder get a minimal `PATH`, so CLI detection also searches common install locations (`/opt/homebrew/bin`, `~/.local/bin`, …).
- **Postinstall:** `scripts/postinstall.mjs` restores the execute bit on `node-pty`'s `spawn-helper` (npm drops it, which breaks every PTY spawn on macOS/Linux). It is a no-op on Windows.

## Adding Windows or Linux — the checklist

1. Add the OS to the CI matrix (`.github/workflows/ci.yml`) and fix what it finds.
2. Run `npm run smoke` on a real machine (Linux: under `xvfb-run`).
3. Fill in any missing branch in `src/main/platform/` — with a test.
4. Add an `electron-builder` target (remember `asarUnpack` for `node-pty` and its `spawn-helper`).
5. Update the table above.

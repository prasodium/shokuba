# Platform support

Shokuba is developed **macOS first**. Windows and Linux are designed for from the start, so adding them should be a small, contained change — this page says exactly how, and what is and isn't verified.

## Status

|                                                                         | macOS | Windows                           | Linux                             |
| ----------------------------------------------------------------------- | ----- | --------------------------------- | --------------------------------- |
| CI: install, typecheck, lint, unit tests                                | ✅    | ✅                                | ✅                                |
| CI: in-Electron smoke test (SQLite, restart persistence, real PTY, Git) | ✅    | ✅                                | ✅ (headless, `--no-sandbox`)     |
| App window rendered and inspected                                       | ✅    | 🔜 not yet seen on a real desktop | 🔜 not yet seen on a real desktop |
| Platform-layer branches unit-tested                                     | ✅    | ✅ (also simulated on any host)   | ✅ (also simulated on any host)   |
| Packaging / installers                                                  | 🔜    | 🔜                                | 🔜                                |

CI runs on GitHub-hosted runners, so "✅" means the core, the native modules and a real pseudo-terminal work on that OS. It does **not** yet mean someone has used the UI there: the smoke test opens no window. macOS is the supported platform until that gap is closed. We say so rather than claim support we haven't verified.

The unit tests also exercise the Windows and Linux branches — `PATHEXT` lookup, named pipes, `taskkill`, drive-letter path containment, env allow-lists — from any host by passing a platform id.

## How the code stays portable

All OS-specific behaviour lives in [`src/main/platform/`](../src/main/platform). Everything else takes a `PlatformId` and asks that layer. A lint rule forbids reading `process.platform` anywhere else.

| Concern                          | macOS / Linux                       | Windows                                         | Helper               |
| -------------------------------- | ----------------------------------- | ----------------------------------------------- | -------------------- |
| Path semantics                   | `path.posix`                        | `path.win32`                                    | `pathApi()`          |
| Default shell                    | `$SHELL` → `/bin/zsh` · `/bin/bash` | `powershell.exe`                                | `defaultShell()`     |
| Local IPC (agent signal channel) | Unix domain socket                  | Named pipe                                      | `ipcEndpoint()`      |
| Finding a CLI                    | `PATH` + common bin dirs            | `PATH` + `PATHEXT` (`.exe`, `.cmd`…) + npm dirs | `findExecutable()`   |
| Child environment                | allow-list                          | allow-list, case-insensitive                    | `safeChildEnv()`     |
| Stop an agent and its children   | signal the process group            | `taskkill /T`                                   | `planTerminate()`    |
| Interrupt an agent               | `Ctrl+C` written to the PTY         | same                                            | `INTERRUPT_SEQUENCE` |
| "Is this path inside that dir?"  | case-sensitive                      | case-insensitive, drive-aware                   | `isPathInside()`     |
| Line endings                     | LF                                  | LF (enforced by `.gitattributes`)               | —                    |

Native modules (`better-sqlite3`, `node-pty`) are N-API, so one build works under Node and Electron. `node-pty` uses ConPTY on Windows.

## Known platform notes

- **Linux:** `node-pty` publishes prebuilt binaries for macOS and Windows only, so on Linux `npm install` compiles it — you need Python 3, `make` and a C++ compiler. Electron also needs a display, so CI runs the smoke test under `xvfb`, and with `--no-sandbox` because GitHub's runners do not install Electron's `chrome-sandbox` helper as set-uid root (the smoke test loads no web content). Compiling `node-pty` worked out of the box on `ubuntu-latest`.
- **Windows:** ConPTY requires Windows 10 1809+. In CI, a non-interactive `powershell.exe -Command` under ConPTY started but produced no output and never exited, while `cmd.exe /d /s /c` worked, so `shellCommand()` uses `cmd.exe`. The interactive default shell is still PowerShell and has **not** been verified in a ConPTY yet. ConPTY prepends VT setup sequences (`ESC[?9001h`, `ESC[2J`, …) to a program's output, so anything reading raw PTY output must tolerate them. Long paths (worktrees) need care.
- **macOS:** apps launched from Finder get a minimal `PATH`, so CLI detection also searches common install locations (`/opt/homebrew/bin`, `~/.local/bin`, …).
- **Postinstall:** `scripts/postinstall.mjs` restores the execute bit on `node-pty`'s `spawn-helper` (npm drops it, which breaks every PTY spawn on macOS/Linux). It is a no-op on Windows.

## Adding Windows or Linux — the checklist

1. Add the OS to the CI matrix (`.github/workflows/ci.yml`) and fix what it finds.
2. Run `npm run smoke` on a real machine (Linux: under `xvfb-run`).
3. Fill in any missing branch in `src/main/platform/` — with a test.
4. Add an `electron-builder` target (remember `asarUnpack` for `node-pty` and its `spawn-helper`).
5. Update the table above.

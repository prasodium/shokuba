# Platform support

Shokuba is developed **macOS first**. Windows and Linux are designed for from the start, so adding them should be a small, contained change — this page says exactly how, and what is and isn't verified.

## Status

|                        | macOS          | Windows                            | Linux                              |
| ---------------------- | -------------- | ---------------------------------- | ---------------------------------- |
| Runs the app           | ✅ tested      | 🔜 not yet run on a real machine   | 🔜 not yet run on a real machine   |
| Platform-layer logic   | ✅ unit-tested | ✅ unit-tested (simulated `win32`) | ✅ unit-tested (simulated `linux`) |
| Packaging / installers | 🔜             | 🔜                                 | 🔜                                 |

"Unit-tested (simulated)" means the Windows/Linux branches — `PATHEXT` lookup, named pipes, `taskkill`, drive-letter path containment, env allow-lists — are exercised from any host by passing a platform id. It does **not** replace testing on the real OS, and we say so rather than claim support we haven't verified.

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

- **Linux:** `node-pty` publishes prebuilt binaries for macOS and Windows only, so on Linux `npm install` compiles it — you need Python 3, `make` and a C++ compiler. Electron also needs a display; CI will use `xvfb`.
- **Windows:** ConPTY requires Windows 10 1809+. The default shell is PowerShell. Long paths (worktrees) need care.
- **macOS:** apps launched from Finder get a minimal `PATH`, so CLI detection also searches common install locations (`/opt/homebrew/bin`, `~/.local/bin`, …).
- **Postinstall:** `scripts/postinstall.mjs` restores the execute bit on `node-pty`'s `spawn-helper` (npm drops it, which breaks every PTY spawn on macOS/Linux). It is a no-op on Windows.

## Adding Windows or Linux — the checklist

1. Add the OS to the CI matrix (`.github/workflows/ci.yml`) and fix what it finds.
2. Run `npm run smoke` on a real machine (Linux: under `xvfb-run`).
3. Fill in any missing branch in `src/main/platform/` — with a test.
4. Add an `electron-builder` target (remember `asarUnpack` for `node-pty` and its `spawn-helper`).
5. Update the table above.

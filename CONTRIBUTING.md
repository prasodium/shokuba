# Contributing to Shokuba

Thanks for being here. Shokuba is early, so contributions of every size matter — a typo fix, a test, a bug report, or a whole subsystem.

## Setup

You need **Node.js 22+** and **Git**.

```bash
git clone https://github.com/prasodium/shokuba.git
cd shokuba
npm install
npm run dev
```

| Command          | What it does                                                                             |
| ---------------- | ---------------------------------------------------------------------------------------- |
| `npm run dev`    | Launch the app with hot reload                                                           |
| `npm run check`  | Typecheck + lint + tests — run this before every PR                                      |
| `npm test`       | Unit tests (Vitest)                                                                      |
| `npm run smoke`  | Build, then run the app in real Electron and check SQLite, a restart, a real PTY and Git |
| `npm run format` | Format with Prettier                                                                     |

**Trying it without an AI account:** create an employee with the **Demo agent (simulated)** provider, start it, click into its terminal, type anything and press Enter. Its activity is labelled `simulated` throughout.

**Demo-agent knobs (development):** `SHOKUBA_MOCK_STEP_MS=200` makes it work faster; `SHOKUBA_MOCK_CHATTY=1` makes every demo agent answer each message it gets, which starts a runaway exchange so you can watch the loop protection stop it. Typing `loop` into a demo agent's terminal makes it repeat one call until the circuit breaker refuses it; `stubborn` keeps trying after being refused, until the breaker pauses and interrupts it. Typing `plan` into a demo agent that is a **manager** makes it draft a small mission for the first person who reports to it, through the real planning tools.

**Testing against the real Claude Code** (spends a few cents; opt-in): `SHOKUBA_LIVE_CLAUDE=1 npm test -- live-claude`. Claude Code's first-run setup must have been completed once on the machine.

**Screenshots and unattended runs (development only):** `electron . --shokuba-capture=plan.json` runs a scripted timeline — `wait`, `eval` (JavaScript in the page), `type`, `press` and `shot` steps — against the real app. See `src/main/devtools/capture.ts`. A `frames` step takes a run of screenshots at a steady pace, which `ffmpeg` can turn into an animation; the README's is made like this:

```bash
ffmpeg -framerate 7.7 -i frames/frame-%04d.png \
  -vf "scale=1000:-1:flags=lanczos,split[s0][s1];[s0]palettegen=max_colors=160:stats_mode=diff[p];[s1][p]paletteuse=dither=bayer:bayer_scale=5:diff_mode=rectangle" \
  -loop 0 out.gif
```

The `frames` step reports how long the run really took, so set `-framerate` to frames divided by seconds. Typing `test` into a demo agent's terminal makes it run one long test command, which sends its employee to the QA bench. A reviewer's demo review reads nine files, so it lasts long enough for the reviewer to walk to a reading desk and sit. To film a whole scenario (dispatch, submit, checks, review, accept), start it from one `eval` step that schedules its steps with timers, then take `frames`; `SHOKUBA_MOCK_STEP_MS=1500` gives the review time to be seen. The app under test is the built one (`npm run build`), not the source. A `frames` step takes at most 600 frames. Simulated tea and snack breaks need an agent to have been idle for a minute or more, so let the capture wait, and to film them up close focus the office (`.office-canvas`) and send it `keydown` events for `+` and the arrow keys from an `eval` step.

> **Tip:** if the app exits immediately saying it is "running as plain Node", your shell has `ELECTRON_RUN_AS_NODE` set (some other Electron app's terminal leaks it). The npm scripts clear it for you; if you run `electron` by hand, unset it first.

## Architecture rules

These keep the project honest. Reviews check for them.

1. **The event log is the source of truth.** State the UI shows must come from persisted events, not from a component guessing. New event types get a Zod schema in `src/shared/events/schema.ts` _when a feature starts emitting them_ — not before.
2. **Nothing crosses a process boundary unvalidated.** Every IPC handler goes through `handle()` in `src/main/ipc/handlers.ts` (sender check + Zod schema).
3. **All OS-specific code lives in `src/main/platform/`.** Do not read `process.platform` anywhere else — a lint rule enforces this. Take a `PlatformId` and call the platform helpers. See [PLATFORMS.md](docs/PLATFORMS.md).
4. **Secrets never reach logs, events or the UI.** Anything persisted or logged goes through the redactor. Child processes get an allow-listed environment (`safeChildEnv`), never a copy of `process.env`.
5. **Schema changes are migrations.** Add a new file under `src/main/database/migrations/` and append it to the list. Never edit or reorder an applied migration — the migrator will refuse.
6. **No fake features.** A button either works, is wired to real state, or is clearly marked unavailable. Demo/simulated data must be labelled as such.
7. **Tests for core behaviour.** Bug fixes come with a test that fails without the fix.

## Code style

- TypeScript `strict`, no `any` (lint error), `import type` for type-only imports.
- Small modules, dependency injection for anything that touches the OS, clock or database — so it can be tested from any machine.
- Prettier formats everything (`npm run format`). Line endings are LF.

## Commits and pull requests

- Use [Conventional Commits](https://www.conventionalcommits.org/): `feat:`, `fix:`, `docs:`, `test:`, `refactor:`, `chore:`.
- Keep PRs focused. Describe **what** and **why**; include how you tested it.
- CI must pass on your PR.

## Where help is most wanted

- **Windows and Linux** — the code paths exist and are unit-tested, but they need real-machine testing. See [PLATFORMS.md](docs/PLATFORMS.md).
- **Provider adapters** — Codex, Gemini CLI and generic CLI adapters. The interface is in `src/main/providers/types.ts`; the Claude Code adapter is the worked example.
- **Voxel art and animation** — original isometric-voxel assets for the office (no copied game assets, please).
- **Docs and tests** — always.

Check the [roadmap](docs/ROADMAP.md) and open an issue before starting anything big, so we can agree on the approach first.

## Reporting security issues

Please don't open a public issue. See [SECURITY.md](SECURITY.md).

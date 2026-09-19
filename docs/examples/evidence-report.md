# Evidence pack

What Shokuba recorded about one task: what was asked, what was done, what the checks and a reviewer found, and who accepted it.

Task `Add the login form` · exported `2026-09-19T21:19:59.853Z` by Shokuba `0.0.1`

## Summary

- **Outcome:** Accepted by a person, through Shokuba, at `2026-09-19T21:19:59.838Z`.
- **Sent back for changes:** 0 times
- **The work:** 1 commit by `Ren`; 1 file changed (+1 −0).
- **Checks:** 1 of 2 checks did not pass on the final commit.
- **Independent review:** The reviewer asked for changes on the final commit, with 2 findings.

## What was asked

- **Task:** `Add the login form`
- **Mission:** `Ship login`
- **Assigned to:** `Ren` (`Engineer`)
- **Priority:** normal

```text
Add the form and its validation.
```

## What the agent says it did

This is the agent's own account of its work. Nothing in this pack was checked against it.

```text
Added the form and validated the email.
```

## The work

| Fact                              | Value               |
| --------------------------------- | ------------------- |
| Project folder                    | `my-project`        |
| Task branch                       | `shokuba/task/id-2` |
| Started from                      | `02792cf1`          |
| Final commit                      | `6031632b`          |
| Merged into the mission branch as | `7ceb9ada`          |
| Working folder                    | still there         |

### Commits

| Commit     | Made by | When                       | Message                    |
| ---------- | ------- | -------------------------- | -------------------------- |
| `6031632b` | `Ren`   | `2026-09-19T21:19:59.000Z` | `Task: Add the login form` |

### Files changed

| File       | Added | Removed |
| ---------- | ----- | ------- |
| `login.ts` | 1     | 0       |

The full change is in `changes.diff`, exactly as Git produced it (181 bytes).

## Checks

1 of 2 checks did not pass on the final commit.

These are commands the person set up, run by Shokuba on the agent-written code. They report what each command did, not whether the work is right.

### Run 1: failed

- **On commit:** `6031632b` (the final commit)
- **Started:** `2026-09-19T21:19:59.782Z`, automatically on submission
- **Finished:** `2026-09-19T21:19:59.782Z`

| Step         | Kind  | Result | Exit code | Took | Output                                                                   |
| ------------ | ----- | ------ | --------- | ---- | ------------------------------------------------------------------------ |
| `Type check` | check | passed | 0         | 4s   | [checks/run-1-step-1-type-check.log](checks/run-1-step-1-type-check.log) |
| `Lint`       | check | failed | 1         | 2s   | [checks/run-1-step-2-lint.log](checks/run-1-step-2-lint.log)             |

## Independent review

The reviewer asked for changes on the final commit, with 2 findings.

A review is one employee's opinion of the change, made without seeing the author's own account of it. It is advice: it did not accept or reject the work.

### Review 1: submitted

- **Reviewer:** `Sora`
- **Read commit:** `6031632b` (the final commit)
- **Asked:** `2026-09-19T21:19:59.782Z`, by a person
- **Verdict:** request changes
- **Handed in:** `2026-09-19T21:19:59.782Z`

```text
The email check is too loose.
```

| Severity | Where        | Finding                                 |
| -------- | ------------ | --------------------------------------- |
| major    | `login.ts:1` | `includes("@") accepts "@" on its own.` |
| nit      | —            | `Name the parameter.`                   |

## Timeline

From Shokuba's event log. "Who" is how the log recorded where each event came from.

| When                       | Who                  | What                                                     |
| -------------------------- | -------------------- | -------------------------------------------------------- |
| `2026-09-19T21:19:59.672Z` | a person             | `Task created`                                           |
| `2026-09-19T21:19:59.673Z` | a person             | `Assigned to Ren`                                        |
| `2026-09-19T21:19:59.673Z` | Shokuba              | `Status ready → in_progress: handed to its assignee`     |
| `2026-09-19T21:19:59.744Z` | Shokuba              | `Working folder and branch created`                      |
| `2026-09-19T21:19:59.776Z` | Shokuba              | `Work saved as commit 6031632b`                          |
| `2026-09-19T21:19:59.777Z` | the agent (reported) | `Status in_progress → submitted: submitted by the agent` |
| `2026-09-19T21:19:59.838Z` | Shokuba              | `Work merged into the mission branch`                    |
| `2026-09-19T21:19:59.838Z` | a person             | `Status submitted → done: accepted`                      |

## What this record does not show

- This is a record, not a proof. Checks show what commands did; a weak test passes weak work. A review is one model's opinion. The agent's summary is its own claim.
- It is not tamper-proof. It is made from Shokuba's database and Git repository on this computer, and it is not signed: anyone who can change those can change what this says.
- Commits are the ones on local branches. Nothing was pushed anywhere.
- Secret-looking values (by pattern, not a guarantee) are removed from the text of this pack, except in the diff, which is the code exactly as it was written. Read it before you share the pack.
- It holds no prompts, model output or terminal transcripts.

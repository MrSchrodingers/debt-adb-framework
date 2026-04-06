---
name: phase
description: >
  This skill should be used when the user asks "/phase", "what phase", "where are we",
  "phase status", "what to do next", "show progress", "current phase", "next action",
  or wants to see the current development state of debt-adb-framework.
---

# /phase — Development Status & Next Actions

Show the current development state and what to do next. This is the ENTRY POINT for every session.

## Execution

### Step 1: Read State

Read these files in order:

1. `/var/www/adb_tools/.dev-state/progress.md` — phase status table
2. `/var/www/adb_tools/CLAUDE.md` — execution bullets for all phases (section "Execution Bullets")
3. If a phase is `IN_PROGRESS`: read `.dev-state/phase-{N}-review.md` if it exists

### Step 2: Build Status Table

Present a table showing ALL phases:

```
Phase | Status     | Deps Met? | Next Action
------+------------+-----------+----------------------------
  1   | READY      | ✅        | /execute (start scaffold)
  2   | BLOCKED    | ❌ (1)    | Wait for Phase 1 APPROVED
  ...
```

### Step 3: Show Execution Bullets for Active Phase

From CLAUDE.md, find the execution bullets section for the current/next phase.
Show ONLY unchecked bullets (`- [ ]`). Checked bullets (`- [x]`) are done.

Format:

```
## Fase N: <Title> — Next Actions

  1. [ ] <next unchecked bullet>
  2. [ ] <following bullet>
  3. [ ] ...

Invoke /execute to start working on bullet 1.
```

### Step 4: Suggest Command

Based on status:
- Phase `READY` + no bullets checked → suggest `/execute` (starts with grill)
- Phase `IN_PROGRESS` + some bullets done → suggest `/execute` (continues)
- Phase `IN_REVIEW` → suggest `/validate`
- All bullets checked → suggest `/validate`
- Phase `APPROVED` + next phase READY → suggest `/execute` on next phase
- Phase `FAILED_REVIEW` → show blocking issues, suggest fixes

## Output Format

Keep it concise. One table, one bullet list, one command suggestion.
Do NOT read or output entire files — only the relevant sections.

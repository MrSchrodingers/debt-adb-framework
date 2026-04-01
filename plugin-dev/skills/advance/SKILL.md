---
name: advance
description: >
  This skill should be used when the user asks "/advance", "advance phase",
  "approve phase", "next phase", "mark approved", "phase done", "move forward",
  or wants to mark the current phase as APPROVED after validation passed.
---

# /advance — Approve Phase & Unblock Next

Mark a validated phase as APPROVED, commit, update GitHub issue, and show
which phases are now unblocked.

## Execution

### Step 1: Verify Validation

1. Read `.dev-state/phase-{N}-review.md` — must exist and say `APPROVED` or `PASSED`
2. If review says `NEEDS_FIX` or doesn't exist: **ABORT** — "Run /validate first"

### Step 2: Update Progress

Edit `.dev-state/progress.md`:
- Set phase status to `APPROVED`
- Set `Approved` timestamp to now
- Add entry to "Phase Approval Log" table
- Update blocked phases: check if their deps are now all APPROVED → set to `READY`

### Step 3: Commit & Push

```bash
git add -A
git commit -m "phase(N): approve — <one-line summary of what was built>"
git push
```

### Step 4: Update GitHub Issue

```bash
gh issue comment N --repo MrSchrodingers/debt-adb-framework --body "## ✅ Phase N APPROVED

All acceptance criteria verified. Tests passing. E2E confirmed.

Validation report: \`.dev-state/phase-{N}-review.md\`
Commit: <sha>"

gh issue close N --repo MrSchrodingers/debt-adb-framework
```

### Step 5: Show Unblocked Phases

```
✅ Phase N: APPROVED

Newly unblocked phases:
  Phase X: <title> — now READY (/execute to start)
  Phase Y: <title> — still BLOCKED (needs Phase Z)

Next suggested action: /execute (starts Phase X)
```

### Step 6: Suggest Next

Based on the dependency graph and critical path:
- If critical path phase is READY → suggest that
- If parallel track phase is READY → mention it as option
- If ALL phases APPROVED → "🎉 All phases complete! Project done."

## Rules

- **Never advance without validation report** — /validate must have run
- **Never advance with blocking issues** — all must be resolved
- **Always close the GitHub issue** — marks it as done
- **Always push** — progress must be in remote

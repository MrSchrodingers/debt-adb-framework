---
name: execute
description: >
  This skill should be used when the user asks "/execute", "execute phase",
  "start working", "implement next", "run batch", "next batch", "continue phase",
  "keep going", "build it", or wants to execute the next batch of work on the
  current phase of debt-adb-framework.
---

# /execute — Execute Next Batch of Work

Pick the next unchecked execution bullets from the current phase and execute them
as a batch with mandatory grill, TDD, and review gates.

## Execution

### Step 1: Load Context

1. Read `/var/www/adb_tools/.dev-state/progress.md` — find current phase
2. Read `/var/www/adb_tools/CLAUDE.md` — find execution bullets for that phase
3. Read `/var/www/adb_tools/plans/dispatch-implementation.md` — phase details
4. If first execution of this phase: read GitHub issue (`gh issue view N --repo MrSchrodingers/debt-adb-framework`)
5. Read `.dev-state/grill-review-plan.md` — resolved decisions

If no phase is `IN_PROGRESS` or `READY`, abort with: "No phase ready. Run /phase to check status."

### Step 2: Determine Batch

Find the first unchecked bullet (`- [ ]`) in the execution bullets for the current phase.
Group bullets into a logical batch (typically 2-3 related bullets):

**Batch types:**
- **Grill batch**: A `Grill` bullet → invoke `/grill-me` on the topic
- **TDD Red batch**: A `TDD Red` bullet → write failing tests first
- **Implement batch**: 1-3 `Implement` bullets → code the feature
- **TDD Green batch**: A `TDD Green` bullet → make all tests pass
- **E2E batch**: An `E2E` bullet → run real device test (send to `5543991938235`)
- **Review batch**: `Simplify` + `Code Review` + `Verify` bullets → full review cycle

### Step 3: Execute Batch

For each batch type, follow the specific protocol:

#### Grill Batch
```
1. Invoke /grill-me with the topic from the bullet
2. Resolve all questions
3. Document decisions in .dev-state/phase-{N}-review.md
4. Check the bullet in CLAUDE.md
```

#### TDD Red Batch
```
1. Read the acceptance criteria from the plan
2. Write failing tests that verify each criterion
3. Run tests — all new tests MUST FAIL (red)
4. Check the bullet in CLAUDE.md
```

#### Implement Batch
```
1. Pick 1-3 implement bullets
2. Write minimal code to make tests pass
3. Run tests after each bullet
4. Check completed bullets in CLAUDE.md
```

#### TDD Green Batch
```
1. Run full test suite: `npm test`
2. ALL tests must pass
3. If failures: fix before proceeding
4. Check the bullet
```

#### E2E Batch
```
1. Connect device via USB
2. Send test message to 5543991938235
3. Take screenshot as proof
4. Save to /var/www/adb_tools/reports/phase-{N}-e2e-{timestamp}.png
5. Check the bullet
```

#### Review Batch
```
1. Invoke /simplify on changed code
2. Invoke superpowers:requesting-code-review
3. Invoke superpowers:verification-before-completion
4. If issues found: fix before checking bullets
5. Check all review bullets
```

### Step 4: Update Progress

After EACH batch:
1. Mark completed bullets as `- [x]` in CLAUDE.md
2. Update `.dev-state/progress.md`:
   - First batch: set status to `IN_PROGRESS`, set `Started` timestamp
   - Add session note with what was done
3. Commit with: `phase(N): <batch description>`

### Step 5: Report & Checkpoint

After each batch, report to user:

```
## Batch Complete: <description>

✅ Completed:
  - [x] bullet 1
  - [x] bullet 2

⏭️ Next batch (N remaining):
  - [ ] next bullet

Continue with /execute or pause here?
```

### Step 6: Detect Phase Complete

If ALL bullets are checked:
```
🏁 All execution bullets complete for Phase N.
Run /validate to verify artifacts and approve.
```

## Rules

- **Never skip grill** — if the grill bullet isn't checked, do it first
- **Never skip TDD red** — tests must exist before implementation
- **Never implement without reading the plan** — context first, code second
- **Always commit after each batch** — survives context rotation
- **Always update CLAUDE.md bullets** — progress tracking
- **Test phone**: `5543991938235` — ALWAYS this number for E2E
- **Device serial**: `9b01005930533036340030832250ac` (POCO Serenity)

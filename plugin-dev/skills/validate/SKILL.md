---
name: validate
description: >
  This skill should be used when the user asks "/validate", "validate phase",
  "check phase", "are we done", "review phase", "phase complete", "run validation",
  or wants to verify that all artifacts and criteria for the current phase are met
  before advancing to the next phase.
---

# /validate — Phase Completion Validation

Comprehensive validation of a completed phase against PRD criteria, plan criteria,
code quality, tests, and E2E proof. Gate before `/advance`.

## Execution

### Step 1: Load Phase Context

1. Read `.dev-state/progress.md` — find phase `IN_PROGRESS` or `IN_REVIEW`
2. Read `plans/dispatch-implementation.md` — phase acceptance criteria
3. Read `CLAUDE.md` — execution bullets (verify all checked)
4. Read GitHub issue comments for grill review additions

### Step 2: Verify All Bullets Checked

From CLAUDE.md execution bullets for this phase:
- Count total bullets vs checked bullets
- If ANY unchecked: **FAIL** — list unchecked, suggest `/execute`

### Step 3: Run Test Suite

```bash
cd /var/www/adb_tools && npm test 2>&1
```

- ALL tests MUST pass
- If failures: **FAIL** — show failures, suggest fixes

### Step 4: Verify Acceptance Criteria

From `plans/dispatch-implementation.md`, check EVERY criterion for this phase:

```
## Phase N Acceptance Criteria Verification

- [x] Criterion 1 — VERIFIED: <how>
- [x] Criterion 2 — VERIFIED: <how>
- [ ] Criterion 3 — FAILED: <why>
```

Verification methods:
- **Code exists**: Grep for the function/module
- **Test exists**: Grep for test covering the criterion
- **E2E proof**: Check `reports/phase-{N}-e2e-*.png` exists
- **Config exists**: Check `.env.example` or `dispatch.config.json`

### Step 5: Code Quality Check

Run review on all files changed in this phase:

```bash
git diff main..HEAD --name-only  # files changed
```

Check against:
- [ ] No `any` types in TypeScript
- [ ] No hardcoded credentials
- [ ] No `console.log` (use pino)
- [ ] All public functions have tests
- [ ] Error handling on all async paths
- [ ] Idempotency on all write operations
- [ ] correlationId in all log statements

### Step 6: Generate Validation Report

Write to `.dev-state/phase-{N}-review.md`:

```markdown
# Phase N Validation Report
## Date: <timestamp>
## Status: PASSED / FAILED

### Execution Bullets: X/Y checked
### Tests: X passed, Y failed, Z skipped
### Acceptance Criteria: X/Y verified

### Criteria Detail
- [x] Criterion 1 — verified via test_xxx
- [ ] Criterion 2 — BLOCKING: <reason>

### Code Quality
- [x] No any types
- [x] No hardcoded credentials
- ...

### E2E Proof
- Screenshot: reports/phase-N-e2e-<timestamp>.png
- Message sent to: 5543991938235
- Device: POCO Serenity (9b01005930533036340030832250ac)

### Issues Found
#### Blocking
- <none or list>

#### Non-Blocking
- <list>

### Verdict: APPROVED / NEEDS_FIX
```

### Step 7: Present Verdict

If **PASSED**:
```
✅ Phase N VALIDATED — all criteria met, tests passing, E2E confirmed.
Run /advance to approve and unblock next phases.
```

If **FAILED**:
```
❌ Phase N VALIDATION FAILED

Blocking issues:
1. <issue>
2. <issue>

Fix these and run /validate again.
```

Update `.dev-state/progress.md` status to `IN_REVIEW`.

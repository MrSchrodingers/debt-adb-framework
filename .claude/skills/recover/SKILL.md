---
name: recover
description: >
  This skill should be used when the user asks "/recover", "recover context",
  "where was I", "resume", "continue from last session", "context lost",
  "new session", "what happened", or starts a new session and needs to
  recover development state for debt-adb-framework.
---

# /recover — Context Recovery After Rotation

Recover full development context after session rotation, context compilation,
or starting a new conversation. Reads all state files and presents a briefing.

## Execution

### Step 1: Read All State Files

Read in this order (all in `/var/www/adb_tools/`):

1. `.dev-state/progress.md` — current phase, blockers, approval log
2. `CLAUDE.md` — execution bullets, dependency graph, conventions
3. `plans/dispatch-implementation.md` — phase details (only current phase section)
4. `.dev-state/grill-review-plan.md` — resolved architectural decisions
5. `.dev-state/phase-{N}-review.md` — if current phase has a review file

### Step 2: Check Git State

```bash
cd /var/www/adb_tools
git log --oneline -5          # recent commits
git status --short             # uncommitted changes
git branch                     # current branch
```

### Step 3: Check Test State

```bash
npm test 2>&1 | tail -5       # if packages exist
```

### Step 4: Present Briefing

```
## 🔄 Context Recovered — debt-adb-framework

**Current Phase**: N — <title>
**Status**: IN_PROGRESS | READY | IN_REVIEW
**Branch**: phase/N-description
**Last Commit**: <sha> <message> (<time ago>)
**Tests**: X passing, Y failing (or "not yet set up")

### Uncommitted Changes
<list or "none">

### Phase Progress
- [x] bullet 1 (done)
- [x] bullet 2 (done)
- [ ] bullet 3 ← YOU ARE HERE
- [ ] bullet 4
- [ ] ...

### Key Decisions (from grill review)
- Locking: BEGIN IMMEDIATE + CAS
- Network: reverse proxy + domain
- Trust: Dispatch trusts Oralsin
- Rate limit: 20-35s base, 1.5x scale per 10 msgs

### Next Action
/execute to continue from bullet 3
```

### Step 5: Verify Device (if Phase involves ADB)

```bash
adb devices -l 2>/dev/null
```

If device connected: show serial + status.
If not: "⚠️ No device connected. Plug in USB for ADB operations."

## Rules

- **Always read state files** — never assume from memory
- **Show only the current phase bullets** — not all 8 phases
- **Keep briefing under 40 lines** — concise recovery, not a novel
- **End with one clear next action** — what command to run

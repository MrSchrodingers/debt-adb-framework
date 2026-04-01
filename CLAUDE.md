# DEBT ADB Framework — Development Protocol

## Project Identity

**Product**: DEBT ADB Framework (codename Dispatch)
**Repo**: https://github.com/MrSchrodingers/debt-adb-framework
**PRD**: `docs/PRD-dispatch.md`
**Plan**: `plans/dispatch-implementation.md`
**Stack**: Turborepo monorepo — Node.js 22, TypeScript, Fastify, React 19, Electron, SQLite, adbkit
**Architecture**: Headless-first, plugin-based. Core runs standalone or embedded in Electron.

## Test Phone

**ALL integration tests and E2E sends must target this number:**
```
TEST_PHONE_NUMBER=5543991938235
```
This is the developer's personal number for real-device monitoring. Never send to any other number during development.

## Context Recovery Protocol

> **CRITICAL**: This project uses file-based state that survives context rotation.
> On EVERY new session or after context compilation, ALWAYS run:

```
1. Read `.dev-state/progress.md` — current phase, blockers, pending reviews
2. Read `plans/dispatch-implementation.md` — full implementation plan
3. Read the phase-specific file `.dev-state/phase-{N}-review.md` if it exists
4. Resume from where progress.md says we are
```

**Never assume you know the current state. Always read the files first.**

## Development Workflow — Mandatory Pipeline

Every piece of work follows this pipeline. No exceptions. No shortcuts.

```
┌──────────────────────────────────────────────────────────────────────┐
│                    PHASE EXECUTION PIPELINE                          │
│                                                                      │
│  ┌─────────┐    ┌─────────┐    ┌──────────┐    ┌────────────────┐  │
│  │ GRILL   │───►│  TDD    │───►│ IMPLEMENT│───►│ CODE REVIEW    │  │
│  │         │    │         │    │          │    │                │  │
│  │ Stress  │    │ Red →   │    │ Green →  │    │ Architecture + │  │
│  │ test    │    │ Write   │    │ Make     │    │ Security +     │  │
│  │ design  │    │ failing │    │ tests    │    │ Conventions    │  │
│  │ before  │    │ tests   │    │ pass     │    │                │  │
│  │ coding  │    │ first   │    │          │    │                │  │
│  └─────────┘    └─────────┘    └──────────┘    └───────┬────────┘  │
│                                                         │           │
│                    ┌──────────────┐    ┌─────────────────▼────────┐ │
│                    │ PHASE GATE   │◄───│ E2E VALIDATION           │ │
│                    │              │    │                          │ │
│                    │ All criteria │    │ Run full test suite +    │ │
│                    │ met? Review  │    │ send test msg to         │ │
│                    │ artifacts    │    │ 5543991938235            │ │
│                    │ approved?    │    │                          │ │
│                    │              │    │ Screenshot proof         │ │
│                    │ YES → next   │    │ saved to reports/        │ │
│                    │ NO → fix     │    │                          │ │
│                    └──────────────┘    └──────────────────────────┘ │
└──────────────────────────────────────────────────────────────────────┘
```

## Phase Dependency Graph

```
Phase 1 (Tracer Bullet) ──────────────────────────────────┐
  ├── Phase 2 (Multi-Device) ─────────────────────┐       │
  │     ├── Phase 3 (Send Engine) ──────────┐     │       │
  │     │     ├── Phase 7 (Plugins) ◄───────┼─ Phase 5   │
  │     │     └── Phase 8 (Hardening) ◄─────┤             │
  │     └── Phase 6 (Dashboard) ◄───────────┘             │
  └── Phase 4 (WAHA Listener) ────────────────────────────┘
        └── Phase 5 (Chatwoot Bridge)

Critical Path: 1 → 2 → 3 → 7
Parallel Track: 1 → 4 → 5 (merges at 7)
```

## Slash Commands — Development Operations

### `/phase-start <N>`

Start working on Phase N. Mandatory checklist:

1. **Read** `.dev-state/progress.md` — verify all dependencies are APPROVED
2. **Read** `plans/dispatch-implementation.md` Phase N section
3. **Read** the GitHub issue (MrSchrodingers/debt-adb-framework#N)
4. **Verify** dependency phases are APPROVED in progress.md
5. **Grill** the design: stress-test edge cases, concurrency, failure modes
6. **Write** failing tests FIRST (TDD red phase)
7. **Update** `.dev-state/progress.md` status to `IN_PROGRESS`
8. **Create** `.dev-state/phase-{N}-review.md` with initial checklist

If a dependency phase is not APPROVED, STOP and inform the developer.

### `/phase-review <N>`

Trigger end-of-phase review. Mandatory steps:

1. **Run** full test suite: `npm test`
2. **Run** E2E validation if applicable (send to TEST_PHONE_NUMBER)
3. **Review** all code written in this phase against:
   - PRD criteria (docs/PRD-dispatch.md)
   - Plan criteria (plans/dispatch-implementation.md Phase N)
   - Clean architecture principles
   - Security (no hardcoded credentials, injection risks)
   - Idempotency of all write operations
   - Error handling and resilience
4. **Generate** review report in `.dev-state/phase-{N}-review.md`:
   - Files changed (with line counts)
   - Tests written (with pass/fail)
   - Criteria checklist (from plan)
   - Issues found (blocking / non-blocking)
   - Screenshots/proof of E2E if applicable
5. **Update** `.dev-state/progress.md`

### `/phase-approve <N>`

Mark Phase N as APPROVED after review passes:

1. **Read** `.dev-state/phase-{N}-review.md` — verify no BLOCKING issues
2. **Verify** all acceptance criteria are checked
3. **Verify** test suite passes
4. **Update** `.dev-state/progress.md` — set phase to APPROVED with timestamp
5. **Commit** with message: `phase(N): approve — <summary>`
6. **Comment** on GitHub issue #N with approval summary
7. **Announce** which phases are now unblocked

### `/phase-status`

Show current development status:

1. **Read** `.dev-state/progress.md`
2. Show table of all phases with status
3. Show which phases are READY (dependencies met, not started)
4. Show blockers if any

### `/test-send <message>`

Send a test WhatsApp message via ADB to verify the pipeline:

1. Target: `5543991938235` (ALWAYS this number)
2. Execute via ADB: intent → typing → send → screenshot
3. Save screenshot to `reports/test-send-{timestamp}.png`
4. Report success/failure with timing

### `/grill <topic>`

Stress-test a design decision before implementation:

1. Identify the topic (module, flow, edge case)
2. Ask adversarial questions:
   - "What if this fails mid-execution?"
   - "What if two workers race for the same message?"
   - "What if the device disconnects during typing?"
   - "What happens at 10x expected volume?"
3. Document findings in the phase review file
4. Block implementation until all concerns are resolved

## Code Conventions

### TypeScript
- Strict mode, no `any`
- Barrel exports per module (`index.ts`)
- Errors: custom error classes extending `DispatchError`
- Async/await, no callbacks
- Zod for runtime validation of API inputs

### Naming
- Files: `kebab-case.ts`
- Classes: `PascalCase`
- Functions/variables: `camelCase`
- Constants: `UPPER_SNAKE_CASE`
- DB tables: `snake_case`
- API routes: `kebab-case`

### Testing
- Test files: `*.test.ts` colocated with source
- Vitest as runner
- `describe` per public method, `it` per behavior
- Mock only at boundaries (ADB, HTTP, clock)
- No test should depend on another test
- No test should depend on real devices

### Git
- Branch per phase: `phase/N-short-description`
- Commits: `type(scope): message` — types: feat, fix, test, refactor, docs, chore
- PR per phase, reviewed before merge to main
- Never force-push main

### Logging
- pino with JSON output
- Every log MUST have `correlationId` for message tracking
- Levels: error (failures), warn (degraded), info (operations), debug (detail)

## Architecture Rules

1. **Core MUST work without Electron** — headless-first
2. **Core MUST work without any plugin** — plugins are optional extensions
3. **WAHA and Chatwoot are native** — they live in core, not plugins
4. **Every write operation MUST be idempotent** — use idempotency keys
5. **Every message MUST have an audit trail** — no fire-and-forget
6. **Rate limiting MUST match Oralsin WAHA client** — same algorithm, same config keys
7. **UI MUST consume only REST API + Socket.IO** — no direct DB access from renderer
8. **SQLite MUST use WAL mode** — concurrent reads during writes
9. **All credentials MUST be encrypted at rest** — never plaintext in SQLite or config

## Monorepo Structure (Target)

```
debt-adb-framework/
├── packages/
│   ├── core/                    # Headless engine
│   │   ├── src/
│   │   │   ├── adb/            # ADB Bridge (adbkit wrapper)
│   │   │   ├── queue/          # Message Queue (SQLite)
│   │   │   ├── engine/         # Send Engine (typing, validation)
│   │   │   ├── waha/           # WAHA Listener (passive)
│   │   │   ├── chatwoot/       # Chatwoot Bridge (bidirectional)
│   │   │   ├── monitor/        # Device Monitor (health, alerts)
│   │   │   ├── plugins/        # Plugin System (registry, events)
│   │   │   ├── api/            # REST API (Fastify routes)
│   │   │   ├── config/         # Configuration management
│   │   │   └── index.ts        # Entry point
│   │   ├── test/
│   │   └── package.json
│   ├── ui/                      # React SPA
│   │   ├── src/
│   │   │   ├── components/     # shadcn/ui components
│   │   │   ├── pages/          # Dashboard, Queue, Audit, Devices
│   │   │   ├── hooks/          # Socket.IO, API hooks
│   │   │   └── App.tsx
│   │   └── package.json
│   ├── electron/                # Electron shell
│   │   ├── src/
│   │   │   ├── main.ts         # Main process (loads core)
│   │   │   └── preload.ts
│   │   └── package.json
│   └── plugins/
│       └── oralsin/             # Oralsin NotificationBilling plugin
│           ├── src/
│           └── package.json
├── docs/
│   ├── PRD-dispatch.md
│   └── adr/                     # Architecture Decision Records
├── plans/
│   └── dispatch-implementation.md
├── scripts/                     # ADB utility scripts
├── .dev-state/                  # Development progress tracking
│   ├── progress.md              # Current state (survives context rot)
│   └── phase-N-review.md       # Per-phase review artifacts
├── CLAUDE.md                    # THIS FILE
├── turbo.json
├── package.json
└── .gitignore
```

## Recovery Checklist (After Context Rotation)

If you are starting a new session and this project is in context:

```markdown
## Quick Recovery Steps
1. cat .dev-state/progress.md          → Where are we?
2. cat plans/dispatch-implementation.md → What's the plan?
3. gh issue list --repo MrSchrodingers/debt-adb-framework → Open issues
4. git log --oneline -10               → Recent commits
5. npm test (if packages exist)        → Are tests passing?
6. Resume from progress.md current phase
```

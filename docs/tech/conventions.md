# Code Conventions — Dispatch ADB Framework

## TypeScript

- **Strict mode**, no `any`
- Barrel exports per module (`index.ts`)
- Custom error classes extending `DispatchError`
- Async/await, no callbacks
- Zod for runtime validation of API inputs

## Naming

| Context | Convention | Example |
|---------|-----------|---------|
| Files | kebab-case | `message-queue.ts` |
| Classes | PascalCase | `MessageQueue` |
| Functions/variables | camelCase | `fetchDevices` |
| Constants | UPPER_SNAKE | `MAX_RETRIES` |
| DB tables | snake_case | `message_history` |
| DB columns | snake_case | `to_number` |
| API routes | kebab-case | `/api/v1/keep-awake` |
| Test files | colocated | `module.test.ts` next to `module.ts` |

## Testing (Vitest)

### Setup Pattern
```typescript
import { describe, it, expect, beforeEach, afterEach, vi } from 'vitest'
import Database from 'better-sqlite3'

let db: Database.Database
beforeEach(() => {
  db = new Database(':memory:')
  db.pragma('journal_mode = WAL')
  // create instance, call initialize()
})
afterEach(() => { db.close() })
```

### Mocking: Dependency Injection (NO vi.mock)
```typescript
const fakeShell = vi.fn<(serial: string, cmd: string) => Promise<string>>()
const mapper = new WaAccountMapper(db, { shell: fakeShell })
```

### Test Data Factories
```typescript
function makeEnqueueParams(overrides = {}): PluginEnqueueParams {
  return { idempotencyKey: `test-${Date.now()}`, ... , ...overrides }
}
```

### Event Testing
```typescript
const events: unknown[] = []
emitter.on('message:sent', (data) => events.push(data))
// ... trigger action ...
expect(events).toHaveLength(1)
```

### Structure
```typescript
describe('ModuleName', () => {
  describe('methodName', () => {
    it('specific behavior under test', () => { ... })
  })
})
```

## Git

- Commits: `type(scope): message`
- Types: feat, fix, test, refactor, docs, chore
- Co-Author: `Co-Authored-By: Claude Opus 4.6 (1M context) <noreply@anthropic.com>`
- Never force-push main

## Logging (pino)

```typescript
server.log.info({ messageId, device }, 'Worker: sending message')
server.log.error({ err, serial }, 'Health collection failed')
```

- JSON output with pino-pretty in dev
- Every log SHOULD have context (messageId, serial, plugin)
- Levels: error (failures), warn (degraded), info (operations), debug (detail)

## API Design

- Zod validation on all POST/PATCH bodies
- 201 for creates, 200 for reads/updates, 204 for deletes
- Error format: `{ "error": "message" }` or `{ "error": "message", "details": [...] }`
- Idempotency via unique constraint on `idempotency_key`

## SQLite Patterns

- WAL mode always: `db.pragma('journal_mode = WAL')`
- Atomic dequeue: `BEGIN IMMEDIATE` + `RETURNING *`
- Timestamps: `strftime('%Y-%m-%dT%H:%M:%fZ', 'now')` (ISO 8601 UTC)
- IDs: `nanoid()` (default 21 chars)
- JSON fields: stored as TEXT, `JSON.parse()` in app layer
- Stale lock cleanup: 120s timeout, 30s poll

## React/UI Patterns

- Functional components only
- useState + useCallback + useEffect (no useReducer)
- Socket.IO in useEffect with cleanup
- API calls via fetch (no axios)
- Tailwind classes inline (no CSS modules)
- lucide-react for icons
- Recharts for charts
- All text in Portuguese in the UI

## Error Handling

- API routes: try/catch, return structured error
- Plugin handlers: try/catch isolated, 5s timeout
- Worker loop: try/catch, log error, continue
- Callbacks: retry 3x, persist failed to DB
- ADB commands: try/catch, graceful degradation

## File Organization

```
packages/core/src/
  module/
    module-name.ts       # Implementation
    module-name.test.ts  # Tests (colocated)
    types.ts             # Types for this module
    index.ts             # Barrel export
```

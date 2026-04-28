# scripts/

Utility scripts for Dispatch operations. Run from the project root unless noted.

## backfill-screenshot-status.ts

**Run once** after deploying Task 7.5 on Kali to populate the `screenshot_status`
column on existing messages that have `NULL` (rows written before the column was added).

```bash
pnpm tsx scripts/backfill-screenshot-status.ts
```

With a custom DB path:

```bash
DB_PATH=/var/www/adb_tools/dispatch.db pnpm tsx scripts/backfill-screenshot-status.ts
```

Idempotent — re-running on an already-populated database is a no-op (only rows
where `screenshot_status IS NULL` are touched).

## hash-password.ts

Generate a bcrypt hash for `DISPATCH_AUTH_PASSWORD`:

```bash
pnpm tsx scripts/hash-password.ts <plaintext>
```

## rotate-keys.ts

Rotate plugin API keys. See inline docs.

## phase-3-e2e.ts

End-to-end validation script for Phase 3 (Send Engine). Sends a real message
to the test phone number `5543991938235` and saves a screenshot to `reports/`.

# Snapshot Calibration Playbook

When `wa_contact_checks` shows a spike in `ui_state = unknown` or
`unknown_dialog`, the WhatsApp UI introduced a layout the classifier doesn't
recognize. Each occurrence persists the XML to disk so a developer can update
the classifier without reproducing the bug on hardware.

## 1. Find a representative snapshot path

```sql
sqlite3 /var/www/debt-adb-framework/packages/core/dispatch.db "
  SELECT json_extract(evidence,'$.snapshot_path') AS path,
         json_extract(evidence,'$.ui_state') AS state,
         checked_at
  FROM wa_contact_checks
  WHERE json_extract(evidence,'$.snapshot_path') IS NOT NULL
  ORDER BY checked_at DESC
  LIMIT 10;
"
```

Or via the admin endpoint:

```bash
curl 'http://127.0.0.1:7890/api/v1/plugins/adb-precheck/admin/probe-snapshots?since=2026-05-06&state=unknown' | jq .
```

## 2. Copy the snapshot to the test fixtures

The path looks like
`/var/www/debt-adb-framework/packages/core/data/probe-snapshots/2026-05-06/103045_9999_unknown_58048.xml`.
Copy it into the repo's fixture directory so the new test exercises it:

```bash
cp /var/www/debt-adb-framework/packages/core/data/probe-snapshots/2026-05-06/<file> \
   packages/core/test/fixtures/ui-states/<descriptive-new-state>.xml
```

Pick a name that describes what the screen actually shows (e.g.
`whatsapp_terms_acceptance.xml`, `business_account_upgrade_modal.xml`).

## 3. Sanitize PII

Captured XML may include real phone numbers and contact names from
production. Before committing to the repo, replace:
- All real phone numbers with `+55 99 99999-9999` (or `99999-0001`, `99999-0002` for distinct rows)
- All real names with `CLIENTE TESTE 1`, `CLIENTE TESTE 2`, etc.
- Any company-specific signatures (e.g. `DEBT | Oral Sin`) with `EMPRESA TESTE`

The classifier rules don't depend on the *content* of these fields — only on
structural patterns and known text markers — so anonymization does not affect
test outcomes.

## 4. Add a fixture-driven failing test

In `packages/core/src/check-strategies/ui-state-classifier.test.ts`, add a
test that asserts the new state. Example:

```typescript
it('classifies <new state> via the new fixture', () => {
  const r = classifyUiState({ xml: FIX('<descriptive-new-state>.xml') })
  expect(r.state).toBe('<expected_state>')  // existing or NEW state
})
```

If this is a brand-new state, also add it to the `UiState` union in
`ui-state-classifier.ts` and to the `RETRYABLE` or `DECISIVE` set as
appropriate.

## 5. Add a classifier rule

In `ui-state-classifier.ts`, add an `if` branch in priority order. Run the
fixture against the existing rules first to confirm it falls through to
`unknown` — if it now matches a wrong rule, the new rule must run BEFORE that
match in source order.

Match on the most specific signal you can. Prefer `resource-id` over text
patterns; prefer text inside a `text="..."` attribute over loose substring
matches (use `text="[^"]*<phrase>[^"]*"`).

## 6. Verify

```bash
cd packages/core && npx vitest run src/check-strategies/ui-state-classifier.test.ts
```

All 19+ classifier tests should pass with the new fixture.

## 7. Commit + ship

```bash
git add packages/core/test/fixtures/ui-states/<file>.xml
git add packages/core/src/check-strategies/ui-state-classifier.ts
git add packages/core/src/check-strategies/ui-state-classifier.test.ts
git commit -m "feat(probe): classify <new state> from production sample"
```

Deploy. The next probe of this UI will classify correctly and either resolve
to a decisive answer or trigger the appropriate recovery action.

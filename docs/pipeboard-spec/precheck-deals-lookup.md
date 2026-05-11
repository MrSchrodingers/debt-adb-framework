# Pipeboard — `POST /precheck/deals/lookup` (proposed)

**Audience:** Pipeboard router maintainers.
**Author:** Dispatch (`adb-precheck` plugin).
**Status:** Proposal — needs sign-off + implementation by Pipeboard team.
**Tracking:** see Dispatch repo `docs/pipeboard-spec/`.

---

## 1. Motivation

Today the Pipeboard precheck surface supports two phone-keyed queries
(`GET /phones/{tel}/state`, `POST /phones/state`) and a pool stream
(`GET /deals?pasta_prefix=…`). There is **no way for Dispatch to ask
"what is the current state of this specific (pasta, deal_id,
contato_tipo, contato_id)?"** — only prefix scans, which return any
row in the prefix tree and silently ignore unknown filters
(empirically confirmed during the 2026-05-11 audit: passing
`?pasta=12382471-A` returned 10 unrelated deals because `pasta` is not
a recognized parameter — `pasta_prefix` is).

This gap blocks three operational needs that surfaced during the
2026-05-11 reconciliation run:

1. **Resolve `rejected_no_match`.** 18 of the 1.006 invalidated phones
   and 60 of the 591 valid phones came back from `phones/state` with
   `invalidated.exists=false AND active.exists=false`. The upstream
   `prov_consultas` row was almost certainly cleaned by the ETL after
   Dispatch scanned it, but we cannot prove it without scanning the
   whole pool again. A point-lookup tells us authoritatively: "this
   `(pasta, deal_id, contato_tipo, contato_id)` was deleted at T" — or
   "it is alive, here are its current phones".

2. **Crash recovery diagnostics.** After a partial scan (e.g. power loss
   at deal 347 of 1.000), Dispatch persists the partial set in its
   local `adb_precheck_deals`. We want to verify which of those 347
   deals were mutated by Pipeboard's ETL between our scan and the
   crash recovery — those need to be re-scanned. Today the only signal
   is `recheck_after_days` (a coarse 30-day filter); a `last_modified_at`
   per row would let us be surgical.

3. **Drift detection during long scans.** A 1.000-deal run takes ~7h.
   The ETL refreshes `prov_consultas` from Pipedrive periodically; if
   it runs mid-scan, some of the keys we processed in the first hour
   may have new phones by the time we finish. With a `last_modified_at`
   per key, Dispatch can snapshot at scan start and detect drift at
   scan end (`last_modified_at > job.started_at`).

Dispatch can absorb (1)–(3) without help, but the cost is "re-scan the
whole tenant" which is expensive at the 6k-pool scale and grows
quadratically. A targeted batch lookup turns each problem into a
~500-key call.

---

## 2. Endpoint contract

```
POST  /api/v1/adb/precheck/deals/lookup
Auth: Authorization: Bearer <api_key>   ; scope = precheck:read
Idem: none required (read-only)
Rate: same bucket as /phones/state — hard cap 500 keys per call
```

### Request body

```json
{
  "keys": [
    {
      "pasta": "16071653-A",
      "deal_id": 115277,
      "contato_tipo": "person",
      "contato_id": 360411
    },
    {
      "pasta": "13735652-A",
      "deal_id": 108126,
      "contato_tipo": "organization",
      "contato_id": 15476
    }
  ]
}
```

| Field          | Required | Validation                                                      |
| -------------- | -------- | --------------------------------------------------------------- |
| `keys`         | yes      | array, 1 ≤ length ≤ 500                                         |
| `pasta`        | yes      | string, 1–64 chars, matches `^[0-9A-Za-z._-]+$`                 |
| `deal_id`      | yes      | integer ≥ 1                                                     |
| `contato_tipo` | yes      | `"person"` \| `"organization"`                                  |
| `contato_id`   | yes      | integer ≥ 1                                                     |

Duplicate keys MUST be honored (return one result per input position,
in input order). The endpoint is read-only so this is just a query
shape — no idempotency key required.

### Response body (HTTP 200)

```json
{
  "results": [
    {
      "key": {
        "pasta": "16071653-A",
        "deal_id": 115277,
        "contato_tipo": "person",
        "contato_id": 360411
      },
      "status": "active",
      "last_modified_at": "2026-05-09T14:22:01.337Z",
      "active_phones": {
        "telefone_1": "5551935646163",
        "telefone_2": "5551934291549",
        "telefone_3": null,
        "telefone_4": "5562982410247",
        "telefone_5": null,
        "telefone_6": null,
        "telefone_hot_1": null,
        "telefone_hot_2": null,
        "whatsapp_hot": null,
        "telefone_localizado": null
      },
      "invalidated_phones": [
        {
          "telefone": "5551935646163",
          "coluna_origem": "telefone_1",
          "motivo": "whatsapp_nao_existe",
          "fonte": "dispatch_adb_precheck",
          "invalidado_em": "2026-05-07T19:08:36.031Z"
        }
      ]
    },
    {
      "key": {
        "pasta": "13735652-A",
        "deal_id": 108126,
        "contato_tipo": "organization",
        "contato_id": 15476
      },
      "status": "deleted",
      "last_modified_at": "2026-04-26T08:14:32.000Z",
      "deleted_at": "2026-04-26T08:14:32.000Z",
      "active_phones": null,
      "invalidated_phones": [
        { "telefone": "5562982410247", "coluna_origem": "telefone_1",
          "motivo": "whatsapp_nao_existe", "fonte": "dispatch_adb_precheck",
          "invalidado_em": "2026-04-25T00:12:50.000Z" }
      ]
    }
  ]
}
```

### Status values

| `status`     | Semantics                                                                                                                                                                                                                                                  |
| ------------ | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `active`     | Row exists in `tenant_adb.prov_consultas` right now. `active_phones` is the full set of `telefone_*` columns (nulls preserved). `last_modified_at` is the row's `updated_at` (or import timestamp if the schema doesn't track row-level writes yet).       |
| `deleted`    | Row WAS in the pool and has been removed by ETL since. Pipeboard knows because (a) `prov_consultas_snapshot` retains the tombstone, OR (b) `prov_telefones_invalidos` has historical occurrences pointing at the same key. `deleted_at` carries the time. |
| `not_found`  | Pipeboard has no record of this key in `prov_consultas` OR in any archive/blocklist. Either the caller fabricated the key or Pipeboard's retention dropped it. Treated by Dispatch as terminal — we tombstone our local copy.                              |

### Fields per result

| Field                  | Type                  | Notes                                                                                                                                |
| ---------------------- | --------------------- | ------------------------------------------------------------------------------------------------------------------------------------ |
| `key`                  | object                | Echoes input. Lets callers correlate when keys repeat.                                                                              |
| `status`               | enum                  | `active` \| `deleted` \| `not_found`.                                                                                                |
| `last_modified_at`     | ISO-8601 \| null      | When the row was last seen / modified. `null` for `not_found`.                                                                       |
| `deleted_at`           | ISO-8601 \| null      | Present only when `status=deleted`. May equal `last_modified_at` when the deletion is the latest event.                              |
| `active_phones`        | object \| null        | Full `telefone_*` map for `active`; `null` otherwise. Use `null` (not `undefined`) for absent columns so the shape stays predictable. |
| `invalidated_phones`   | array \| null         | History of invalidations for this key in `prov_telefones_invalidos`. Helps Dispatch reconcile when its local invalid set drifted.   |
| `invalidated_phones[].coluna_origem` | string \| null | Which column this phone was cleared from. Null when historical data lost the attribution.                                  |

### Error responses

| HTTP | When                                          | Body                                                                                                                                          |
| ---- | --------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| 400  | Malformed payload, bad enum, key over-limit   | `{"error": "invalid_request", "field": "keys[3].contato_tipo", "detail": "must be 'person' or 'organization'"}`                                |
| 401  | Missing / wrong bearer token                  | `{"error": "unauthorized"}`                                                                                                                   |
| 403  | Token lacks `precheck:read` scope             | `{"error": "forbidden", "scope_required": "precheck:read"}`                                                                                   |
| 429  | Rate budget exhausted                         | `{"error": "rate_limited", "retry_after_s": <int>}`                                                                                           |

### Latency budget

Aim for parity with `POST /phones/state`: ~370ms for 100 keys, ~1.2s
for 500 keys observed in the 2026-05-11 reconciliation run. The
query plan should land in two indexed lookups per key (one on the
primary table, one on `prov_telefones_invalidos`) — well under
1ms/key in PG with the `(pasta, deal_id, contato_tipo, contato_id)`
unique constraint already in place.

---

## 3. Dispatch-side integration sketch

Three flows on the Dispatch side will consume the new endpoint:

### 3.1 Resolve `rejected_no_match`

```ts
// packages/core/src/plugins/adb-precheck/pipeboard-rest.ts
async lookupDeals(keys: DealKey[]): Promise<DealLookupResult[]> {
  const res = await this.request('POST', '/precheck/deals/lookup', { keys })
  return ((await res.json()) as { results: DealLookupResult[] }).results
}

// New reconciliation step after a `phones/state` sweep:
const rejected = sweepResult.filter((r) => r.predicted_post_outcome === 'rejected_no_match')
const keys = rejected.flatMap((r) => deriveLocalKeysFor(r.telefone))   // join via adb_precheck_deals
const lookups = await client.lookupDeals(keys)                          // ≤500 at a time

for (const lk of lookups) {
  if (lk.status === 'deleted' || lk.status === 'not_found') {
    // tombstone the local row — our scan was correct, upstream removed it
    store.tombstoneDeal(lk.key, lk.deleted_at ?? null)
  } else if (lk.status === 'active') {
    // upstream has it under different phones now → schedule a rescan
    rescanQueue.enqueue(lk.key)
  }
}
```

### 3.2 Drift check at scan end

```ts
// At scan start, snapshot `last_modified_at` for the first page only
const snapshot = await client.lookupDeals(firstPage.map(toKey))
const driftBaseline = new Map(snapshot.map((s) => [keyId(s.key), s.last_modified_at]))

// On scan finish:
const final = await client.lookupDeals([...driftBaseline.keys()].map(parseId))
for (const f of final) {
  const before = driftBaseline.get(keyId(f.key))
  if (before && f.last_modified_at && f.last_modified_at > scanStartedAt) {
    logger.warn('drift_during_scan', { key: f.key, before, after: f.last_modified_at })
    rescanQueue.enqueue(f.key)
  }
}
```

### 3.3 Crash recovery

When the orphan reaper marks a job `failed`, the operator triggers
`POST /retry-errors` (existing). The retry path can be augmented:

```ts
const errorDeals = store.listDealsWithErrors(orphanedJobId)
const lookups = await client.lookupDeals(errorDeals.map((d) => d.key))
const stillActive = lookups.filter((l) => l.status === 'active')
// Only re-probe deals whose source row still exists.
```

This narrows recovery work to the deals Pipeboard can still serve,
saving ADB cycles on already-deleted rows.

---

## 4. Open questions for the Pipeboard team

1. **Does `prov_consultas` already track `updated_at`?** If not, what
   timestamp can stand in (e.g. `imported_at` from the ETL batch)? The
   contract gracefully degrades — `last_modified_at: null` is allowed
   for `active` rows — but a real timestamp unlocks 3.2.

2. **Tombstone retention.** How long does `prov_consultas_snapshot`
   keep deleted rows? If short, `status=deleted` is rare and most
   gone-deals come back as `not_found`. Either is workable, but we'd
   like to document it in the precheck runbook so operators know how
   to interpret a `not_found` response (genuine bad key vs. retention
   eviction).

3. **`contato_tipo` casing.** Today the existing endpoints accept
   `person`/`organization` lower-case. Confirm we should keep that
   here (vs. allowing the legacy uppercase `PERSON`/`ORGANIZATION`
   we still see in some older `prov_telefones_invalidos` rows).

4. **Performance of the join.** The `invalidated_phones` join is the
   only potentially expensive part. If it strains the 1.2s budget at
   500 keys, an opt-in flag (`?include_invalidated=false`) is fine —
   Dispatch can call separately when it needs that view.

---

## 5. Acceptance criteria (for our integration)

A green-light run on Dispatch's side requires, in this order:

- [ ] Pipeboard ships the route behind a feature flag.
- [ ] Curl-level smoke test: 1 active key + 1 deleted key + 1 not_found
      key returns the documented shape in <1s.
- [ ] Batch of 500 mixed keys returns under 2s p99.
- [ ] Dispatch's `lookupDeals` client (new) ships behind an env flag
      `PLUGIN_ADB_PRECHECK_LOOKUP_ENABLED`.
- [ ] Reconciliation script consumes the new endpoint to resolve the
      current 78 `rejected_no_match` cases on prod (18 invalid + 60
      valid). Expected outcome: ≥90% classified as `deleted`, ≤10% as
      `not_found`, ≤1% as `active` (which would indicate fresh re-imports).
- [ ] Drift-check (3.2) wired into the next 1.000-deal scan; alerts in
      `logger.warn('drift_during_scan')` for any mid-scan ETL refresh.

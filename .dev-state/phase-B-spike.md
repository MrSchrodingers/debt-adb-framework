# Phase B Spike — tenant_sicoob phone shape (T11)

**Date**: 2026-05-15
**SSH**: `claude@188.245.66.92` → `docker exec docker-db-1 psql -U postgres -d pipeboard`
**Goal**: confirm JSONB key layout for phones in `tenant_sicoob.pessoas` before T13 router projection.

## Findings — `tenant_sicoob.pessoas` table

### Direct columns
- `id BIGINT NOT NULL` (PK)
- `cf_telefone_contatos_primary_value TEXT` — primary phone (text, multiple Brazilian formats)
- `cf_telefone_contatos_primary_label TEXT` — usually `"mobile"`
- `cf_email_contatos_primary_value TEXT` — primary email
- `cf_cpf TEXT` — CPF (used for `pasta` derivation)
- `name TEXT`, `first_name TEXT`, `last_name TEXT`
- `custom_fields_jsonb JSONB` — secondary container (see below)

### `custom_fields_jsonb` keys (phone-bearing)
- `telefone_contatos_list` (JSONB array of strings) — ALL phones the person has, e.g. `["11974994064", "1146935113"]`. May be absent for ~12% of pessoas.
- `telefone_contatos_primary_value` (string) — duplicates the direct column above.
- `telefone_contatos_primary_label` (string) — duplicates the direct column above.
- `email_contatos_list`, `email_contatos_primary_value`, `email_contatos_primary_label` — email parallels.

### Coverage stats (62987 pessoas total)
| Field | Count | % |
|-------|-------|---|
| `cf_telefone_contatos_primary_value IS NOT NULL` | 56966 | 90.4% |
| `custom_fields_jsonb->>'telefone_contatos_list' IS NOT NULL` | 55799 | 88.6% |

### Phone format observations (inconsistent — normalize on TS side)
- `(43) 984292585` (formatted local with DDD prefix)
- `55047991501806` (E.164 13-digit)
- `55045999329191` (E.164 13-digit)
- `17 99129-2345` (formatted with dash)
- `4330252416` (10-digit landline)
- `43991052039` (11-digit mobile w/o country code)

**All formats are handled by existing `normalizeBrPhone()` in `packages/core/src/plugins/adb-precheck/phone-extractor.ts`.**

### Multi-phone pessoas
Examples of `telefone_contatos_list` arrays with >1 entry:
- `["11974994064", "1146935113"]`
- `["4330252416", "62994583959"]`
- `["4331584118", "43991052039", "43991167722"]`

## Findings — `tenant_sicoob.negocios` table

### Direct columns relevant to projection
- `id BIGINT NOT NULL` (PK; used for cursor)
- `title TEXT`
- `person_id BIGINT` (FK → pessoas.id)
- `pipeline_id BIGINT`, `stage_id BIGINT` (direct columns — no JOIN with pipelines/etapas_funil needed for filtering)
- `stage_change_time TIMESTAMPTZ` (used for `exclude_after` filter)
- `is_deleted BOOLEAN`, `is_archived BOOLEAN` (defaults FALSE)
- `update_time TIMESTAMPTZ`
- `custom_fields_jsonb JSONB` (also exists on negocios; not used for phones in raw mode)

## Decision for T13 router projection

The raw projection SQL in `precheck_raw_projection.go` should:

1. **JOIN** `tenant_<schema>.negocios n` LEFT JOIN `tenant_<schema>.pessoas p ON p.id = n.person_id`
2. **WHERE** `n.pipeline_id = $1` (+ optional `n.stage_id = $2`, `n.stage_change_time < $3`, cursor by `n.id > $4`)
3. **AND** `COALESCE(n.is_deleted, FALSE) = FALSE AND COALESCE(n.is_archived, FALSE) = FALSE`
4. **Project**:
   - `whatsapp_hot` ← `p.cf_telefone_contatos_primary_value`
   - `telefone_hot_1`, `telefone_hot_2`, `telefone_hot_3` ← `jsonb_array_elements_text(p.custom_fields_jsonb->'telefone_contatos_list')` (skip primary if duplicate)
   - `pasta` ← `COALESCE(p.cf_cpf, n.id::text)` (when CPF absent, fall back to deal id — "1 pasta == 1 deal")
   - `deal_id` ← `n.id`
   - `contato_tipo` ← `'pessoa'` (sicoob has no organization probe today)
   - `contato_id` ← `p.id`

5. **Cursor**: keyset by `n.id` (negocios.id is bigint PK; assumed unique within a tenant schema).
6. **Phone normalization**: defer to TS side (`normalizeBrPhone`) — same as prov-tenant. Don't normalize in SQL.

## Open items for T13

- Project shape MUST match the existing `dealRow` struct in `precheck_deals.go` so the TS client deserializes identically.
- If projecting >3 secondary phones is needed (the existing prov path has `PHONE_COLUMNS` whitelist of `whatsapp_hot`, `telefone_hot_1..5`), use `jsonb_array_elements_text` and `LATERAL` to fan-out up to 5 secondaries.
- `is_deleted` and `is_archived` defaults FALSE — confirmed `NULL` values exist; use `COALESCE` defensively.

## Risk notes

- 12% of pessoas have NO phone — produce `dealRow` with all phone columns NULL; downstream scanner treats as zero-phone deal.
- Phone duplicates between primary and list are common — TS-side `normalizeBrPhone + Set` dedup handles this.
- `negocios.person_id` can be NULL — left join is mandatory.

## Verification commands (reproducible)

```bash
ssh -i ~/.ssh/id_waha claude@188.245.66.92 'docker exec docker-db-1 psql -U postgres -d pipeboard -c "\d tenant_sicoob.pessoas"' | head -80
ssh -i ~/.ssh/id_waha claude@188.245.66.92 'docker exec docker-db-1 psql -U postgres -d pipeboard -c "SELECT id, custom_fields_jsonb FROM tenant_sicoob.pessoas WHERE custom_fields_jsonb IS NOT NULL LIMIT 5"'
ssh -i ~/.ssh/id_waha claude@188.245.66.92 'docker exec docker-db-1 psql -U postgres -d pipeboard -c "SELECT COUNT(*), COUNT(cf_telefone_contatos_primary_value), COUNT(custom_fields_jsonb->>\\"telefone_contatos_list\\") FROM tenant_sicoob.pessoas"'
```

# Pipeboard Precheck — Provider integration spec

How external providers (e.g. `debt_adb_provider`) call the Pipeboard
Precheck REST API to invalidate phones on the ADB tenant.

This is the **provider-facing** interface. Dispatch's internal
integration uses the same endpoint via the internal vhost
(`pipelineanalytics.debt.com.br`) — see
[ADR 0002](../adr/0002-pipeboard-rest-migration.md) and
[`pipeboard-precheck.openapi.yaml`](../api/pipeboard-precheck.openapi.yaml)
for the full contract.

## Endpoint

```
POST https://adb.debt.com.br/api/v1/adb/precheck/phones/invalidate
```

- **Tenant** (`adb`) is on the path — the API key is bound to the
  tenant server-side via `router_api_keys`.
- **Edge whitelist**: `adb.debt.com.br` only forwards `/precheck/*`
  to the upstream router. Every other path returns 404 at the edge.
- HSTS preload, X-Frame-Options DENY, body cap 1 MiB.

## Auth

```
X-API-Key: pbk_-x466bBJWTCZdL9ddIUrWawpx_XUzuztM2tQrzian2c5vZxxPBd4YA
```

Or:

```
Authorization: Bearer pbk_-x466bBJWTCZdL9ddIUrWawpx_XUzuztM2tQrzian2c5vZxxPBd4YA
```

- Scope: `precheck:write`
- Tenant binding: `adb` (server-side, no header needed)
- Rate limit: **1000 req/min** (default; ask Pipeboard team to raise
  if your batch flow needs more)

## Idempotency

```
Idempotency-Key: <UUID v4>
```

Required on every POST. Replay (same key + same body) returns the
original response with `idempotent: true` — treat as success. Same
key + **different** body returns **409** with
`{"error": "Idempotency-Key collision"}` — caller bug, generate a
new key.

## Request body

```jsonc
{
  "fonte":            "debt_adb_provider",
  "deal_id":          12345,
  "pasta":            "AB-2024/12",
  "contato_tipo":     "person",
  "contato_id":       67890,
  "motivo":           "número inexistente",
  "job_id":           "<provider-side correlation id, optional>",
  "phones": [
    {
      "telefone":      "5543991938235",
      "coluna_origem": "telefone_3",  // optional
      "confidence":    0.95           // optional, 0..1
    }
  ],
  "archive_if_empty": false           // ALWAYS false for the provider
}
```

### Field rules

| Field | Required | Notes |
|---|---|---|
| `fonte` | yes | Must be `"debt_adb_provider"` for provider keys. The CHECK constraint enforces this server-side. |
| `deal_id` / `pasta` / `contato_tipo` / `contato_id` | yes | Composite key matching `tenant_adb.prov_consultas`. Pasta + deal_id usually come from the original assignment payload. |
| `motivo` | yes | Free text up to 200 chars. Common values: `número inexistente`, `desligado`, `empresa errada`, `outro`. |
| `phones[]` | yes | 1–50 entries per call. Batch when possible to save round-trips. |
| `phones[].telefone` | yes | E.164-normalized digits. Brazilian numbers should be 13 digits (55 + DDD + 9 + 8 dígitos). |
| `phones[].coluna_origem` | no | Hint for which `prov_consultas` column held the number — informational only. |
| `phones[].confidence` | no | 0..1 — how sure the provider is the number is invalid. |
| `archive_if_empty` | yes | **Always `false`** for providers. Decision to archive a deal belongs to Dispatch's batch flow, not per-phone callers. |

## Response (HTTP 200)

```jsonc
{
  "request_id": "uuid",
  "idempotent": false,
  "applied": [
    {
      "telefone":     "5543991938235",
      "status":       "applied",
      "cleared_from": ["telefone_3"]
    }
  ],
  "deal_archived": false,
  "pipedrive": {
    "scenario":    "per_phone",
    "workflow_id": "precheck-pipedrive-per_phone-..."
  }
}
```

### Per-phone status

| Status | Meaning | Action |
|---|---|---|
| `applied` | First time this number was blocked. | Done. `cleared_from` shows which `prov_consultas` columns were NULLified. |
| `duplicate_already_moved` | Number was already in the blocklist before this call. | Treat as success — idempotent at the row level. |
| `rejected_invalid_input` | Server-side validation failed (malformed E.164, invalid characters). | Caller bug — fix the format and retry with a **new** `Idempotency-Key`. |
| `rejected_no_match` | The number is not present in `prov_consultas` for the given deal. | Most likely the deal/contato moved or was archived. Treat as no-op. |

`pipedrive` is present whenever a Pipedrive activity workflow was
scheduled server-side (Temporal). Its existence tells you a CRM
artifact is on the way; you don't need to act on it.

## Error responses

| HTTP | Meaning | Action |
|---|---|---|
| `400` | Body malformed (Zod validation failed). Body holds `details`. | Fix payload, retry with new `Idempotency-Key`. |
| `401` | API key missing or invalid. | Rotate / get a fresh key from Pipeboard team. |
| `403` | Key valid but missing `precheck:write` scope. | Contact Pipeboard team. |
| `409` | `Idempotency-Key` collision (same key, different body). | Generate a new key. |
| `429` | Rate limit exceeded. | Honour `Retry-After`, slow down. |
| `5xx` | Server / DB issue. | Retry with the **same** `Idempotency-Key` after backoff (idempotency guarantees no double-apply). |

## Tables touched server-side

| Table | What |
|---|---|
| `tenant_adb.prov_telefones_invalidos` | Per-phone blocklist, append-only, full audit trail. |
| `tenant_adb.prov_telefones_invalidos_requests` | One row per REST call (full `raw_body` JSONB, idempotency cache). |
| `tenant_adb.prov_consultas` | Phone columns NULLified atomically in a SERIALIZABLE transaction. |

## Compromisso

- **Não compartilhe a chave.** Se vazar, peça rotação.
- **Auditoria total**: cada chamada deixa rastro em
  `prov_telefones_invalidos_requests` com seu IP, body e response.
- **Bloqueio é permanente**: uma vez removido, o número não volta.
  Para revalidar (acreditar que reportou errado), abrir ticket — não
  há endpoint self-service.

## Smoke test (curl)

```bash
KEY="pbk_-x466bBJWTCZdL9ddIUrWawpx_XUzuztM2tQrzian2c5vZxxPBd4YA"
IDEMP=$(uuidgen)

curl -i -X POST \
  -H "X-API-Key: $KEY" \
  -H "Idempotency-Key: $IDEMP" \
  -H "Content-Type: application/json" \
  https://adb.debt.com.br/api/v1/adb/precheck/phones/invalidate \
  -d '{
    "fonte":"debt_adb_provider",
    "deal_id":12345,
    "pasta":"AB-2024/12",
    "contato_tipo":"person",
    "contato_id":67890,
    "motivo":"smoke test",
    "phones":[{"telefone":"5500000000001","coluna_origem":"telefone_1","confidence":0.99}],
    "archive_if_empty":false
  }'
```

Replay the same command with the same `IDEMP` — the response should
echo `"idempotent": true` with the same `request_id`.

## Sample TypeScript client

See [`scripts/precheck-provider-example.ts`](../../scripts/precheck-provider-example.ts).

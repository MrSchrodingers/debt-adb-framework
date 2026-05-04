# adb-precheck REST cutover — canary playbook

Operational runbook for switching `adb-precheck` from the SSH-tunnelled
`PipeboardPg` backend to the REST `PipeboardRest` backend in production.

ADR: [0002 Pipeboard REST migration](../adr/0002-pipeboard-rest-migration.md)
Contract: [`pipeboard-precheck.openapi.yaml`](../api/pipeboard-precheck.openapi.yaml)

## Pre-flight checks

Run from the operator workstation (with Tailscale + key access to the
Kali host):

1. **Pipeboard reachability**
   ```bash
   curl -fsS https://pipelineanalytics.debt.com.br/api/v1/adb/precheck/healthz
   # Expect: {"status":"ok","tenant":"adb","schema_check":3,"schema_expected":3,...}
   ```
2. **API key in env**
   ```bash
   ssh adb@dispatch grep -c PLUGIN_ADB_PRECHECK_REST_API_KEY \
     /var/www/debt-adb-framework/packages/core/.env
   # Expect: 1
   ```
3. **Backend flag still on `sql` (we are about to flip)**
   ```bash
   ssh adb@dispatch grep PLUGIN_ADB_PRECHECK_BACKEND \
     /var/www/debt-adb-framework/packages/core/.env
   # Expect: PLUGIN_ADB_PRECHECK_BACKEND=sql
   ```
4. **dispatch-core healthy**
   ```bash
   ssh adb@dispatch systemctl is-active dispatch-core.service
   ```

## Cutover

```bash
ssh adb@dispatch
cd /var/www/debt-adb-framework
sed -i 's/^PLUGIN_ADB_PRECHECK_BACKEND=sql/PLUGIN_ADB_PRECHECK_BACKEND=rest/' \
  packages/core/.env
sudo systemctl restart dispatch-core.service
journalctl -u dispatch-core.service -f --since "1m ago"
```

Wait for the boot log line confirming the REST client picked up:

```
... ADB pre-check plugin initialized
```

If you see `adb-precheck: backend=rest requires restBaseUrl and restApiKey`,
the env is misconfigured — abort the cutover (see Rollback below).

## Trigger canary scan

Choose **one small, real pasta** (10–50 deals). Avoid prefixes used for
any synthetic data:

```bash
curl -fsS -X POST -H "Content-Type: application/json" \
  http://localhost:3001/api/v1/plugins/adb-precheck/scan \
  -d '{
    "pasta_prefix": "PASTA-XXXX/",
    "writeback_invalid": true,
    "writeback_localizado": true,
    "limit": 50,
    "external_ref": "canary-rest-1"
  }'
```

## Observability — what to watch

### Dispatch side (Prometheus on `:3001/metrics`)

```promql
# Volume + status distribution
sum by (op, status) (rate(dispatch_precheck_pipeboard_request_total[5m]))

# Buffer must stay at 0
dispatch_precheck_pipeboard_pending_writebacks
```

Healthy signal:
- `op="invalidate"` requests with `status="200"` dominant
- `status="enqueued"` at 0
- `pending_writebacks` gauge at 0

Investigate immediately if:
- `pending_writebacks > 0` for more than 30s
- `status="429"` appears (rate limit)
- `status="409"` appears in significant volume (idempotency-key collisions =
  caller bug)
- Any `status="500"`/`"502"`/`"503"`

### Pipeboard side (your queries)

```sql
-- Volume + outcome by minute
SELECT date_trunc('minute', recebido_em) AS t, fonte, status, count(*)
FROM tenant_adb.prov_telefones_invalidos_requests
WHERE recebido_em > now() - interval '15 min'
  AND fonte = 'dispatch_adb_precheck'
GROUP BY 1,2,3 ORDER BY 1 DESC;

-- Phones effectively blocked
SELECT date_trunc('minute', invalidado_em) AS t, count(*)
FROM tenant_adb.prov_telefones_invalidos
WHERE invalidado_em > now() - interval '15 min'
  AND invalidado_por = 'dispatch_adb_precheck'
GROUP BY 1 ORDER BY 1 DESC;
```

Red flags from Pipeboard:
- `status='duplicate_already_moved'` proportion > 5% → Dispatch retrying more
  than expected
- Postgres log `WARNING: prov_consultas_block_invalid_phones: dropped` in
  volume → ETL Python is reintroducing numbers that were just invalidated
  (the guardrail trigger is catching it)

### Dispatch logs (where pasta is in every entry)

The scanner already logs `key.pasta` in every relevant warn/info. Tail:

```bash
ssh adb@dispatch journalctl -u dispatch-core.service -f \
  | grep -E 'precheck|pending_writebacks|invalidation|localization'
```

## Rollback

If anything red appears in the first hour:

```bash
ssh adb@dispatch
cd /var/www/debt-adb-framework
sed -i 's/^PLUGIN_ADB_PRECHECK_BACKEND=rest/PLUGIN_ADB_PRECHECK_BACKEND=sql/' \
  packages/core/.env
sudo systemctl restart dispatch-core.service
```

The SSH tunnel (`pipeboard-tunnel.service`) was never disabled, so reverting
just flips the env and restarts. Pending writebacks already in the local
SQLite buffer remain there and will drain when REST is re-enabled — they
do NOT replay through the SQL path.

## Decommissioning the SSH tunnel (only after 2 weeks of REST-only)

```bash
ssh adb@dispatch
sudo systemctl disable --now pipeboard-tunnel.service
sudo rm /etc/systemd/system/pipeboard-tunnel.service
sudo systemctl daemon-reload
# Pipeboard side: remove the id_waha pubkey from claude@188.245.66.92 authorized_keys
# Pipeboard side: close port 15432 on the bastion
sudo chown adb:adb /home/adb/.ssh && sudo chmod 700 /home/adb/.ssh
sudo rm /home/adb/.ssh/id_waha /home/adb/.ssh/id_waha.pub
```

-- Migration 044: Backfill phantom prov_consultas rows + extend lost-deals cleanup
--
-- Two responsibilities:
-- 1. Move all-NULL-phone rows from prov_consultas to prov_consultas_snapshot
--    with motivo='legacy_todos_telefones_invalidos'. These are the residue of
--    pre-blocklist runs of adb-precheck that NULLed phones in place without
--    archiving. Phone values cannot be reconstructed (already lost), but the
--    deal lineage is preserved for auditing.
-- 2. Add tenant_adb.prov_telefones_invalidos to the lost-deals cleanup
--    (mirrors migration 022's cascade).
--
-- Idempotent: ON CONFLICT DO NOTHING + a WHERE clause on the DELETE that
-- matches the same predicate as the INSERT.

BEGIN;

-- 1. Snapshot the empty rows (one-shot; predicate already excludes anything
-- with a non-NULL phone column).
INSERT INTO tenant_adb.prov_consultas_snapshot (
    pasta, deal_id, contato_tipo, contato_id, stage_nome, pipeline_nome,
    add_time, update_time, stage_change_time, local_do_acidente,
    data_do_acidente, veiculo_segurado, aviso_de_sinistro, localizado,
    telefone_localizado, encontrado_por, encontrado_em, contato_nome,
    contato_relacao, telefone_1, telefone_2, telefone_3, telefone_4,
    telefone_5, telefone_6, removido_em, motivo, whatsapp_hot,
    telefone_hot_1, telefone_hot_2, stage_id, pipeline_id
)
SELECT
    pasta, deal_id, contato_tipo, contato_id, stage_nome, pipeline_nome,
    add_time, update_time, stage_change_time, local_do_acidente,
    data_do_acidente, veiculo_segurado, aviso_de_sinistro, localizado,
    telefone_localizado, encontrado_por, encontrado_em, contato_nome,
    contato_relacao, telefone_1, telefone_2, telefone_3, telefone_4,
    telefone_5, telefone_6, now(), 'legacy_todos_telefones_invalidos',
    whatsapp_hot, telefone_hot_1, telefone_hot_2, stage_id, pipeline_id
FROM tenant_adb.prov_consultas
WHERE whatsapp_hot IS NULL AND telefone_hot_1 IS NULL AND telefone_hot_2 IS NULL
  AND telefone_1 IS NULL AND telefone_2 IS NULL AND telefone_3 IS NULL
  AND telefone_4 IS NULL AND telefone_5 IS NULL AND telefone_6 IS NULL
ON CONFLICT (pasta, deal_id, contato_tipo, contato_id) DO NOTHING;

-- 2. Delete the now-archived rows. Same predicate: only those that have no
-- phones. Safe to run repeatedly; a row populated again by a later sync will
-- not match the predicate.
DELETE FROM tenant_adb.prov_consultas
WHERE whatsapp_hot IS NULL AND telefone_hot_1 IS NULL AND telefone_hot_2 IS NULL
  AND telefone_1 IS NULL AND telefone_2 IS NULL AND telefone_3 IS NULL
  AND telefone_4 IS NULL AND telefone_5 IS NULL AND telefone_6 IS NULL;

COMMIT;

SELECT 'Migration 044: phantom prov_consultas backfilled to snapshot' AS message;

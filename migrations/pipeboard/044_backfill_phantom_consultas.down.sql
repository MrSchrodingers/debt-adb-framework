-- Migration 044 DOWN: best-effort restore of legacy backfill
--
-- The DELETE in 044.up cannot be precisely undone (we don't keep a separate
-- audit). The rows still live in prov_consultas_snapshot under
-- motivo='legacy_todos_telefones_invalidos', so we copy them back. If the
-- ETL has since re-created any of these keys, ON CONFLICT preserves the
-- current row.

BEGIN;

INSERT INTO tenant_adb.prov_consultas (
    pasta, deal_id, contato_tipo, contato_id, stage_nome, pipeline_nome,
    add_time, update_time, stage_change_time, local_do_acidente,
    data_do_acidente, veiculo_segurado, aviso_de_sinistro, localizado,
    telefone_localizado, encontrado_por, encontrado_em, contato_nome,
    contato_relacao, telefone_1, telefone_2, telefone_3, telefone_4,
    telefone_5, telefone_6, whatsapp_hot, telefone_hot_1, telefone_hot_2,
    stage_id, pipeline_id
)
SELECT
    pasta, deal_id, contato_tipo, contato_id, stage_nome, pipeline_nome,
    add_time, update_time, stage_change_time, local_do_acidente,
    data_do_acidente, veiculo_segurado, aviso_de_sinistro, localizado,
    telefone_localizado, encontrado_por, encontrado_em, contato_nome,
    contato_relacao, telefone_1, telefone_2, telefone_3, telefone_4,
    telefone_5, telefone_6, whatsapp_hot, telefone_hot_1, telefone_hot_2,
    stage_id, pipeline_id
FROM tenant_adb.prov_consultas_snapshot
WHERE motivo = 'legacy_todos_telefones_invalidos'
ON CONFLICT (pasta, deal_id, contato_tipo, contato_id) DO NOTHING;

DELETE FROM tenant_adb.prov_consultas_snapshot
WHERE motivo = 'legacy_todos_telefones_invalidos';

COMMIT;

-- Migration 043: Create tenant_adb.prov_telefones_invalidos
--
-- Per-phone invalid record. Authoritative blocklist consumed by the
-- Pipeboard ETL (sync_consultas_flow) and written by Dispatch (adb-precheck).
--
-- A phone listed here with revalidado_em IS NULL is filtered out of
-- prov_consultas on every sync. Setting revalidado_em lifts the block.
--
-- Cross-repo coordination:
--   - Dispatch (Node) writes via PipeboardPg.recordInvalidPhone()
--   - Pipeboard (Python ETL) reads via _load_invalid_phones_blocklist()

CREATE TABLE IF NOT EXISTS tenant_adb.prov_telefones_invalidos (
    pasta            TEXT          NOT NULL,
    deal_id          BIGINT        NOT NULL,
    contato_tipo     VARCHAR(20)   NOT NULL,
    contato_id       BIGINT        NOT NULL,
    telefone         VARCHAR(20)   NOT NULL,
    motivo           TEXT          NOT NULL,
    coluna_origem    TEXT,
    invalidado_em    TIMESTAMPTZ   NOT NULL DEFAULT now(),
    invalidado_por   TEXT          NOT NULL,
    job_id           TEXT,
    confidence       NUMERIC(4,3),
    revalidado_em    TIMESTAMPTZ,
    revalidado_por   TEXT,
    PRIMARY KEY (pasta, deal_id, contato_tipo, contato_id, telefone)
);

CREATE INDEX IF NOT EXISTS idx_prov_tel_inv_active
    ON tenant_adb.prov_telefones_invalidos (deal_id, contato_tipo, contato_id)
    WHERE revalidado_em IS NULL;

CREATE INDEX IF NOT EXISTS idx_prov_tel_inv_telefone
    ON tenant_adb.prov_telefones_invalidos (telefone);

CREATE INDEX IF NOT EXISTS idx_prov_tel_inv_invalidado_em
    ON tenant_adb.prov_telefones_invalidos (invalidado_em);

COMMENT ON TABLE tenant_adb.prov_telefones_invalidos IS
    'Per-phone invalid record. Authoritative blocklist for ETL filtering.';
COMMENT ON COLUMN tenant_adb.prov_telefones_invalidos.telefone IS
    'Normalized E.164 (55DD9XXXXXXXX). Same convention as prov_consultas phone columns.';
COMMENT ON COLUMN tenant_adb.prov_telefones_invalidos.motivo IS
    'whatsapp_nao_existe | oralsin_callback_invalid | <other source-defined codes>';
COMMENT ON COLUMN tenant_adb.prov_telefones_invalidos.coluna_origem IS
    'Last seen prov_consultas column (whatsapp_hot, telefone_1, ...). Audit only.';
COMMENT ON COLUMN tenant_adb.prov_telefones_invalidos.revalidado_em IS
    'Non-NULL = block lifted. ETL filter MUST honor "revalidado_em IS NULL".';

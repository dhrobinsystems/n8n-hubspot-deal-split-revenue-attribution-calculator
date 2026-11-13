-- =============================================================================
-- sql/schema.sql
-- Optional analytics-database table for deal split rows (PostgreSQL syntax).
-- Load it into your own analytics database; the n8n workflow sends records to
-- ANALYTICS_INGEST_URL (your service) or you can swap the "Analytics Ingest" node
-- for an n8n Postgres node that inserts the rows from "Build Sheet Rows".
--
-- Connection details belong in the n8n Postgres credential or your service's
-- secret store (see ANALYTICS_DATABASE_URL in .env.example); never in this file.
--
-- DISCLAIMER: provided "AS IS", without warranty of any kind. See disclaimer.md.
-- =============================================================================

CREATE TABLE IF NOT EXISTS deal_split_lines (
    calculation_id      TEXT        NOT NULL,           -- deterministic hash: same inputs => same ID
    line_number         INTEGER     NOT NULL,
    deal_id             TEXT        NOT NULL,
    deal_name           TEXT,
    pipeline            TEXT,
    close_date          DATE,
    currency            CHAR(3)     NOT NULL,
    deal_amount         NUMERIC(20, 4) NOT NULL,
    participant_type    TEXT        NOT NULL CHECK (participant_type IN ('REP', 'PARTNER')),
    participant_id      TEXT        NOT NULL,           -- HubSpot owner ID or company ID (no personal data)
    role                TEXT        NOT NULL,
    split_source        TEXT        NOT NULL,           -- SPLIT_PROPERTIES | DEAL_OWNER_DEFAULT | PARTNER_ASSOCIATION
    split_percent       NUMERIC(9, 4)  NOT NULL,
    credit_amount       NUMERIC(20, 4) NOT NULL,
    commission_rate     NUMERIC(9, 6)  NOT NULL,
    commission_amount   NUMERIC(20, 4) NOT NULL,
    rounding_mode       TEXT        NOT NULL,
    calculated_at       TIMESTAMPTZ NOT NULL,
    mode                TEXT        NOT NULL CHECK (mode IN ('SANDBOX', 'LIVE')),
    calculator_version  TEXT        NOT NULL,
    PRIMARY KEY (calculation_id, line_number)          -- idempotent: re-delivery cannot duplicate rows
);

CREATE INDEX IF NOT EXISTS deal_split_lines_deal_idx        ON deal_split_lines (deal_id);
CREATE INDEX IF NOT EXISTS deal_split_lines_participant_idx ON deal_split_lines (participant_type, participant_id);
CREATE INDEX IF NOT EXISTS deal_split_lines_close_date_idx  ON deal_split_lines (close_date);

-- Latest calculation per deal (a deal recalculated after an amount change has a new calculation_id).
CREATE OR REPLACE VIEW deal_split_lines_latest AS
SELECT l.*
FROM deal_split_lines l
JOIN (
    SELECT deal_id, MAX(calculated_at) AS calculated_at
    FROM deal_split_lines
    WHERE mode = 'LIVE'
    GROUP BY deal_id
) latest ON latest.deal_id = l.deal_id AND latest.calculated_at = l.calculated_at
WHERE l.mode = 'LIVE';

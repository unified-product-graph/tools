-- 005_edge_properties.sql
--
-- Framework-exercise parity (UPG 0.8.6): edges may now carry a structured
-- payload. The local `.upg` format gained gated edge `properties` in 0.8.4
-- (the `framework_exercise_includes_node` edge records a framework's per-entity
-- result on the edge, not the node). This brings the Postgres-backed cloud
-- store to parity by adding a dedicated `properties` JSONB column, distinct from
-- the server-managed `metadata` column.
--
-- Additive + idempotent: safe to run on an existing deployment. Existing edges
-- get a NULL payload (read back as "no properties").

ALTER TABLE upg.edges
  ADD COLUMN IF NOT EXISTS properties JSONB;

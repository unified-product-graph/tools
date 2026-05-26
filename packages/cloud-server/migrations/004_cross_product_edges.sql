-- Cross-product edges: portfolio-level relationships between products.
-- Supports the portfolio family of tools and `repair_dangling_edges`.
--
-- In local .upg files, cross-product edges live in portfolio.cross_edges[].
-- Cloud needs a dedicated table because products are rows, not files.
-- IDs are TEXT (nanoid-prefixed, matching the cloud server's id minting pattern)
-- rather than UUID, matching how the MCP server generates IDs at the tool layer.

CREATE TABLE IF NOT EXISTS upg.cross_product_edges (
  id TEXT PRIMARY KEY,
  source TEXT NOT NULL,                     -- qualified: "{product_id}/{node_id}"
  target TEXT NOT NULL,                     -- qualified: "{product_id}/{node_id}"
  type TEXT NOT NULL,                       -- must be in UPG_CROSS_EDGE_TYPES
  created_by_product_id TEXT NOT NULL,      -- which product "owns" this cross-edge
  created_at TIMESTAMPTZ NOT NULL DEFAULT NOW()
);

CREATE INDEX IF NOT EXISTS idx_cross_product_edges_owner
  ON upg.cross_product_edges(created_by_product_id);

CREATE INDEX IF NOT EXISTS idx_cross_product_edges_type
  ON upg.cross_product_edges(type);

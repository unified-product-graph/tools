-- UPG Cloud Server: Initial Schema
-- Run this against your Postgres database before starting the server.

CREATE SCHEMA IF NOT EXISTS upg;

-- Products
CREATE TABLE upg.products (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  title TEXT NOT NULL,
  description TEXT,
  stage TEXT DEFAULT 'idea' CHECK (stage IN ('idea', 'mvp', 'growth', 'scale')),
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Nodes (entities)
CREATE TABLE upg.nodes (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES upg.products(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  title TEXT NOT NULL,
  description TEXT,
  status TEXT DEFAULT 'active',
  tags TEXT[] DEFAULT '{}',
  data JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now(),
  updated_at TIMESTAMPTZ DEFAULT now()
);

-- Edges (relationships)
CREATE TABLE upg.edges (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES upg.products(id) ON DELETE CASCADE,
  source UUID NOT NULL REFERENCES upg.nodes(id) ON DELETE CASCADE,
  target UUID NOT NULL REFERENCES upg.nodes(id) ON DELETE CASCADE,
  type TEXT NOT NULL,
  metadata JSONB DEFAULT '{}',
  created_at TIMESTAMPTZ DEFAULT now()
);

-- Full-text search on nodes
CREATE INDEX idx_nodes_fts ON upg.nodes USING gin(
  to_tsvector('english', coalesce(title, '') || ' ' || coalesce(description, ''))
);

-- Performance indexes
CREATE INDEX idx_nodes_product ON upg.nodes(product_id);
CREATE INDEX idx_nodes_type ON upg.nodes(product_id, type);
CREATE INDEX idx_edges_product ON upg.edges(product_id);
CREATE INDEX idx_edges_source ON upg.edges(source);
CREATE INDEX idx_edges_target ON upg.edges(target);
CREATE INDEX idx_edges_type ON upg.edges(product_id, type);

-- Updated_at trigger
CREATE OR REPLACE FUNCTION upg.update_updated_at()
RETURNS TRIGGER AS $$
BEGIN
  NEW.updated_at = now();
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER trg_products_updated_at
  BEFORE UPDATE ON upg.products
  FOR EACH ROW EXECUTE FUNCTION upg.update_updated_at();

CREATE TRIGGER trg_nodes_updated_at
  BEFORE UPDATE ON upg.nodes
  FOR EACH ROW EXECUTE FUNCTION upg.update_updated_at();

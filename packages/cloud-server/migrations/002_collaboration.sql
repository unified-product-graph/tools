-- Collaboration primitives: audit log, comments, access control

-- Audit log: who changed what, when
CREATE TABLE upg.audit_log (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES upg.products(id) ON DELETE CASCADE,
  user_id TEXT,
  action TEXT NOT NULL CHECK (action IN ('create', 'update', 'delete')),
  entity_type TEXT NOT NULL CHECK (entity_type IN ('node', 'edge', 'product')),
  entity_id UUID NOT NULL,
  changes JSONB,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_audit_log_product ON upg.audit_log(product_id, created_at DESC);
CREATE INDEX idx_audit_log_entity ON upg.audit_log(entity_id);

-- Comments on entities
CREATE TABLE upg.comments (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES upg.products(id) ON DELETE CASCADE,
  node_id UUID REFERENCES upg.nodes(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  body TEXT NOT NULL,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_comments_node ON upg.comments(node_id, created_at DESC);

-- Access control
CREATE TABLE upg.access (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES upg.products(id) ON DELETE CASCADE,
  user_id TEXT NOT NULL,
  role TEXT NOT NULL CHECK (role IN ('owner', 'editor', 'viewer')),
  created_at TIMESTAMPTZ DEFAULT now(),
  UNIQUE(product_id, user_id)
);

CREATE INDEX idx_access_product ON upg.access(product_id);
CREATE INDEX idx_access_user ON upg.access(user_id);

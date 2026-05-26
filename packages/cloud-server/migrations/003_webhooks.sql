-- Webhook event system

CREATE TABLE upg.webhooks (
  id UUID PRIMARY KEY DEFAULT gen_random_uuid(),
  product_id UUID NOT NULL REFERENCES upg.products(id) ON DELETE CASCADE,
  event TEXT NOT NULL,
  url TEXT NOT NULL,
  secret TEXT,
  active BOOLEAN DEFAULT true,
  created_at TIMESTAMPTZ DEFAULT now()
);

CREATE INDEX idx_webhooks_product ON upg.webhooks(product_id);
CREATE INDEX idx_webhooks_event ON upg.webhooks(product_id, event);

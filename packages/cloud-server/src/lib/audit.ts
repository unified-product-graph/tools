/**
 * Audit-log writer for the cloud server.
 *
 * `upg.audit_log` is the canonical history of mutations, read back by
 * `get_audit_log` and `get_changes`. Every mutation must record a row here, or
 * those tools return empty forever (the bug fixed in).
 *
 * `appendAudit` MUST be called with a **transaction-scoped client**, in the
 * same transaction as the mutation it records, so the audit row commits or
 * rolls back atomically with the write; important for the batch tools'
 * all-or-nothing semantics.
 *
 * `userId` is `null` on the stdio path until request-level auth context is
 * plumbed (see, Tier-3 enforcement).
 */
import type { PoolClient } from 'pg'

export type AuditAction = 'create' | 'update' | 'delete'
export type AuditEntityType = 'node' | 'edge' | 'product'

export interface AuditEntry {
  productId: string
  action: AuditAction
  entityType: AuditEntityType
  entityId: string
  /** Optional JSON payload (e.g. the created entity, the patch, or merge info). */
  changes?: unknown
  /** Actor; null on the unauthenticated stdio path. */
  userId?: string | null
}

export async function appendAudit(client: PoolClient, entry: AuditEntry): Promise<void> {
  await client.query(
    `INSERT INTO upg.audit_log (product_id, user_id, action, entity_type, entity_id, changes)
     VALUES ($1, $2, $3, $4, $5, $6)`,
    [
      entry.productId,
      entry.userId ?? null,
      entry.action,
      entry.entityType,
      entry.entityId,
      entry.changes !== undefined && entry.changes !== null ? JSON.stringify(entry.changes) : null,
    ],
  )
}

/**
 * Cloud-side id minters.
 *
 * The cloud schema (`migrations/001_initial.sql`) declares `id` / `source` /
 * `target` as Postgres `UUID` columns, so cloud mints native UUIDs. This is
 * deliberately NOT the file-SDK's `nodeId`/`edgeId` (which produce the
 * human-readable `n_…` / `e_…` ids used inside `.upg` files): ids are a
 * storage-format concern, not shared graph semantics. The shared logic cloud
 * derives from `@unified-product-graph/sdk/logic` is edge inference and the
 * validators — not id format.
 *
 * Before this, cloud reused the `n_…` / `e_…` generators, which Postgres
 * rejected with "invalid input syntax for type uuid" — a bug masked by the
 * mocked-pool unit tests and only surfaced by running the server for real.
 */
import { randomUUID } from 'node:crypto'

/** Generate a node id (Postgres UUID). */
export function nodeId(): string {
  return randomUUID()
}

/** Generate an edge id (Postgres UUID). */
export function edgeId(): string {
  return randomUUID()
}

/**
 * Adapter interface and shared types.
 *
 * Every adapter implements UPGAdapter and converts records from one
 * source format into UPG nodes and edges.
 */

import type { UPGBaseNode, UPGEdge } from '@unified-product-graph/core'

// ─── Configuration ────────────────────────────────────────────────────────────

/** Configuration for an adapter */
export interface AdapterConfig {
  /** Adapter-specific connection config (API key, file path, etc.) */
  [key: string]: unknown
}

// ─── Source items ─────────────────────────────────────────────────────────────

/** An item discovered in the source system */
export interface SourceItem {
  /** Unique ID in the source system */
  source_id: string
  /** Source-specific type (e.g. "page", "issue", "database_item") */
  source_type: string
  /** Human-readable title */
  title: string
  /** Raw content or description */
  content?: string
  /** Source-specific metadata */
  metadata?: Record<string, unknown>
  /** Children or nested items */
  children?: SourceItem[]
}

// ─── Import result ────────────────────────────────────────────────────────────

/** Result of an import conversion */
export interface ImportResult {
  nodes: UPGBaseNode[]
  edges: UPGEdge[]
  /** Mapping of source ID to UPG node ID for traceability */
  source_map: Record<string, string>
  /** Warnings or notes from the conversion */
  warnings?: string[]
}

// ─── Adapter interface ────────────────────────────────────────────────────────

/** The adapter interface. Every adapter implements this. */
export interface UPGAdapter {
  /** Adapter name (e.g. "markdown", "notion") */
  name: string
  /** Human-readable label */
  label: string
  /** Source system description */
  description: string

  /** Discover what's available in the source */
  list(config: AdapterConfig): Promise<SourceItem[]>

  /** Convert source items to UPG entities */
  convert(items: SourceItem[], config?: AdapterConfig): Promise<ImportResult>
}

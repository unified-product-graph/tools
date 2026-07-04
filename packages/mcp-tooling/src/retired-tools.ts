/**
 * Loader for the 0.19.0 tool-consolidation equivalence contract
 * (`retired-tools.json` at the package root). The contract is the single
 * source of truth for the catalog-parity gate: it maps every retired
 * spec-introspection tool to its replacement on the faceted surface.
 *
 * Kept as data (JSON) so it is the human-ratifiable artifact the Captain signs
 * off, and loaded here typed so the parity test + prepublish gate drive off
 * one file. Resolved relative to this module (both `dist/` and `src/` sit one
 * level under the package root, so `../retired-tools.json` works in the built
 * package and under vitest/tsx alike).
 */

import { fileURLToPath } from 'node:url'
import * as fs from 'node:fs'
import * as path from 'node:path'

export interface RetiredListEntry {
  via: 'list_catalog'
  kind: string
  filters: string[]
  arg_remap?: Record<string, string>
  note?: string
}
export interface RetiredGetEntry {
  via: 'get_catalog_entry'
  kind: string
  id_param: string
}
export interface RetiredFoldEntry {
  via: 'get_entity_schema'
  include?: string
  source_id_param?: string
  schema_arg: string
  schema_source?: string
  schema_edge_target_arg?: string
  source_args?: string[]
  result_field: string
  note?: string
}
export interface RetiredPromptEntry {
  via: 'skill'
  skill: string
  note?: string
}

export interface RetiredToolsContract {
  version: string
  phase: number
  list: Record<string, RetiredListEntry>
  get: Record<string, RetiredGetEntry>
  fold: Record<string, RetiredFoldEntry>
  prompt: Record<string, RetiredPromptEntry>
}

let cached: RetiredToolsContract | undefined

/** Load + cache the equivalence contract from `retired-tools.json`. */
export function loadRetiredTools(): RetiredToolsContract {
  if (cached) return cached
  const here = path.dirname(fileURLToPath(import.meta.url))
  const jsonPath = path.join(here, '..', 'retired-tools.json')
  const raw = fs.readFileSync(jsonPath, 'utf-8')
  cached = JSON.parse(raw) as RetiredToolsContract
  return cached
}

/** Flat list of every retired tool name across all four buckets (48 total). */
export function retiredToolNames(contract = loadRetiredTools()): string[] {
  return [
    ...Object.keys(contract.list),
    ...Object.keys(contract.get),
    ...Object.keys(contract.fold),
    ...Object.keys(contract.prompt),
  ]
}

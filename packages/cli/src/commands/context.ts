/**
 * `upg context` - lens-aware product summary.
 *
 * Mirrors getProductContext from the MCP server: product header, lens preamble,
 * entity counts by type, and domain guides for every domain the product has
 * entities in.
 *
 * Usage:
 *   upg context                          default product lens overview
 *   upg context --domains personas,ux    filter display to matching domains
 *   upg context --lens engineering       override lens for this invocation
 *   upg context --summary                include edge counts and orphan stats
 *   upg context --json                   machine-readable JSON
 */

import { Command } from 'commander'
import chalk from 'chalk'
import {
  UPG_DOMAINS,
  UPG_DOMAIN_GUIDES,
  UPG_LENSES,
  getDomainForType,
  resolveLabel,
} from '@unified-product-graph/core'
import { discoverUPGFile, loadStore } from '../lib/graph.js'
import { upgHeader } from '../lib/formatter.js'
import { die, usageError } from '../lib/errors.js'
import { sanitizeForTerminal } from '../lib/sanitize.js'

// ── helpers ───────────────────────────────────────────────────────────────────

function lensAwareLabel(entityType: string, lensId: string): string {
  const lens = UPG_LENSES.find((l) => l.id === lensId)
  if (lens?.label_overrides?.[entityType]) {
    return lens.label_overrides[entityType]
  }
  return resolveLabel(entityType, lens?.framework_id)
}

function row(key: string, value: unknown): string {
  const v =
    value === null || value === undefined
      ? chalk.dim('-')
      : chalk.white(String(value))
  return `  ${chalk.dim(key.padEnd(20))} ${v}`
}

// ── command ───────────────────────────────────────────────────────────────────

export const contextCommand = new Command('context')
  .description('Lens-aware product summary: entity counts, domain guides, graph stats.')
  .option('--file <path>', 'Path to .upg file')
  .option('--lens <id>', 'Lens to use (product, engineering, ux_design, growth)')
  .option('--domains <list>', 'Comma-separated domain ids to include (filters entity counts and guides)')
  .option('--summary', 'Include edge counts by type and orphan count')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts) => {
    try {
      const filePath = await discoverUPGFile(opts.file)
      const store = await loadStore(filePath)

      const doc = store.getDocument()
      const product = doc.product
      const nodes = store.getAllNodes()
      const edges = store.getAllEdges()

      // Lens: explicit flag or product default or 'product'
      const lensId: string =
        opts.lens ??
        (product as { lens?: string }).lens ??
        'product'

      // Validate lens flag if provided
      const knownLenses = new Set(UPG_LENSES.map((l) => l.id))
      if (opts.lens && !knownLenses.has(opts.lens)) {
        store.stopWatching()
        die(usageError(
          `Unknown lens "${sanitizeForTerminal(opts.lens)}". Valid: ${[...knownLenses].join(', ')}.`,
        ))
      }

      // Domains filter
      const domainsFilter: Set<string> | null = opts.domains
        ? new Set((opts.domains as string).split(',').map((d: string) => d.trim()).filter(Boolean))
        : null

      // Count by type
      const countsByType: Record<string, number> = {}
      for (const n of nodes) {
        if (domainsFilter) {
          const d = getDomainForType(n.type)
          if (!d || !domainsFilter.has(d.id)) continue
        }
        countsByType[n.type] = (countsByType[n.type] ?? 0) + 1
      }

      // Lens-specific preamble counts
      const lensData: Record<string, unknown> = {}
      if (lensId === 'engineering') {
        const bugs = nodes.filter((n) => n.type === 'bug' && n.status !== 'closed' && n.status !== 'fixed')
        const inFlight = nodes.filter((n) => n.type === 'feature' && n.status === 'in_progress')
        const debt = nodes.filter((n) => n.type === 'technical_debt_item')
        const blockers = edges.filter((e) => e.type.includes('blocks') || e.type.includes('causes'))
        const investigations = nodes.filter((n) => n.type === 'investigation' && n.status !== 'resolved')
        lensData.open_bugs = bugs.length
        lensData.critical_bugs = bugs.filter((b) => (b.properties as Record<string, unknown>)?.bug_severity === 'critical').length
        lensData.in_flight_features = inFlight.length
        lensData.technical_debt = debt.length
        lensData.active_blockers = blockers.length
        lensData.open_investigations = investigations.length
      } else if (lensId === 'ux_design') {
        lensData.screens = nodes.filter((n) => n.type === 'screen').length
        lensData.components = nodes.filter((n) => n.type === 'design_component').length
        lensData.user_flows = nodes.filter((n) => n.type === 'user_flow').length
        lensData.design_tokens = nodes.filter((n) => n.type === 'design_token').length
        lensData.design_systems = nodes.filter((n) => n.type === 'design_system').length
        lensData.design_decisions = nodes.filter((n) => n.type === 'decision').length
      } else if (lensId === 'growth') {
        lensData.funnels = nodes.filter((n) => n.type === 'funnel').length
        lensData.channels = nodes.filter((n) => n.type === 'acquisition_channel').length
        lensData.campaigns = nodes.filter((n) => n.type === 'growth_campaign').length
        lensData.segments = nodes.filter((n) => n.type === 'behavioral_segment').length
      } else {
        // product lens
        const hypotheses = nodes.filter((n) => n.type === 'hypothesis')
        lensData.personas = nodes.filter((n) => n.type === 'persona').length
        lensData.outcomes = nodes.filter((n) => n.type === 'outcome').length
        lensData.hypotheses = hypotheses.length
        lensData.hypotheses_validated = hypotheses.filter((h) => h.status === 'validated').length
      }

      // Active domains
      const activeDomains = new Set<string>()
      for (const n of nodes) {
        const d = getDomainForType(n.type)
        if (d) activeDomains.add(d.id)
      }

      // Optional summary stats
      let summaryData: Record<string, unknown> | undefined
      if (opts.summary) {
        const edgesByType: Record<string, number> = {}
        for (const e of edges) edgesByType[e.type] = (edgesByType[e.type] ?? 0) + 1
        const connectedNodes = new Set<string>()
        for (const e of edges) {
          connectedNodes.add(e.source)
          connectedNodes.add(e.target)
        }
        summaryData = {
          orphan_nodes: nodes.filter((n) => !connectedNodes.has(n.id)).length,
          edges_by_type: edgesByType,
        }
      }

      store.stopWatching()

      // ── JSON output ───────────────────────────────────────────────────────
      if (opts.json) {
        const guides = UPG_DOMAIN_GUIDES
          .filter((g) => activeDomains.has(g.domain_id))
          .filter((g) => !domainsFilter || domainsFilter.has(g.domain_id))
          .map((g) => ({
            domain_id: g.domain_id,
            anchor_entity: g.anchor_entity,
            creation_sequence: g.creation_sequence,
          }))
        const out: Record<string, unknown> = {
          product: { id: product.id, title: product.title, stage: (product as { stage?: string }).stage ?? null },
          lens: lensId,
          lens_preamble: lensData,
          graph: { nodes: nodes.length, edges: edges.length, entity_types: Object.keys(countsByType).length },
          entities_by_type: Object.entries(countsByType)
            .sort(([, a], [, b]) => b - a)
            .map(([type, count]) => ({ type, label: lensAwareLabel(type, lensId), count })),
          domain_guides: guides,
        }
        if (summaryData) out.summary = summaryData
        console.log(JSON.stringify(out, null, 2))
        return
      }

      // ── Human output ──────────────────────────────────────────────────────
      process.stderr.write(upgHeader('Context') + '\n')

      console.log(row('product', sanitizeForTerminal(product.title)))
      if (product.description) {
        console.log(row('description', sanitizeForTerminal(product.description)))
      }
      const stage = (product as { stage?: string }).stage
      if (stage) console.log(row('stage', sanitizeForTerminal(stage)))
      console.log(row('lens', lensId))

      // Lens preamble block
      const lensEmoji: Record<string, string> = {
        engineering: 'Engineering',
        ux_design: 'Design',
        growth: 'Growth',
        product: 'Product',
      }
      const lensTitle = lensEmoji[lensId] ?? sanitizeForTerminal(lensId)
      console.log(`\n  ${chalk.bold(`${lensTitle} Lens`)}`)
      for (const [k, v] of Object.entries(lensData)) {
        console.log(`  ${chalk.dim(k.padEnd(26))} ${chalk.white(String(v))}`)
      }

      // Graph stats
      console.log(`\n  ${chalk.bold('Graph Stats')}`)
      console.log(`  ${chalk.dim('nodes'.padEnd(26))} ${chalk.white(String(nodes.length))}`)
      console.log(`  ${chalk.dim('edges'.padEnd(26))} ${chalk.white(String(edges.length))}`)
      console.log(`  ${chalk.dim('entity types'.padEnd(26))} ${chalk.white(String(Object.keys(countsByType).length))}`)

      // Entities by type
      const entityEntries = Object.entries(countsByType).sort(([, a], [, b]) => b - a)
      if (entityEntries.length > 0) {
        console.log(`\n  ${chalk.bold('Entities by Type')}`)
        for (const [type, count] of entityEntries) {
          const lbl = lensAwareLabel(type, lensId)
          console.log(`  ${chalk.dim(lbl.padEnd(26))} ${chalk.white(String(count))}  ${chalk.dim(`(${type})`)}`)
        }
      }

      // Domain guides
      const guideEntries = UPG_DOMAIN_GUIDES
        .filter((g) => activeDomains.has(g.domain_id))
        .filter((g) => !domainsFilter || domainsFilter.has(g.domain_id))
      if (guideEntries.length > 0) {
        console.log(`\n  ${chalk.bold('Domain Guides (active domains)')}`)
        for (const g of guideEntries) {
          const domainLabel = UPG_DOMAINS.find((d) => d.id === g.domain_id)?.label ?? g.domain_id
          const seq = g.creation_sequence.map((t) => chalk.dim(t)).join(chalk.dim(' -> '))
          console.log(`  ${chalk.white(domainLabel)}  ${chalk.dim('anchor:')} ${chalk.white(g.anchor_entity)}  ${chalk.dim('sequence:')} ${seq}`)
        }
      }

      // Optional summary
      if (opts.summary && summaryData) {
        console.log(`\n  ${chalk.bold('Graph Summary')}`)
        console.log(`  ${chalk.dim('orphan nodes'.padEnd(26))} ${chalk.white(String(summaryData.orphan_nodes))}`)
        const edgesByType = summaryData.edges_by_type as Record<string, number>
        const topEdges = Object.entries(edgesByType).sort(([, a], [, b]) => b - a).slice(0, 10)
        if (topEdges.length > 0) {
          console.log(`\n  ${chalk.bold('Edges by Type (top 10)')}`)
          for (const [etype, cnt] of topEdges) {
            console.log(`  ${chalk.dim(etype.padEnd(44))} ${chalk.white(String(cnt))}`)
          }
        }
      }

      process.stderr.write('\n')
    } catch (err) {
      die(err)
    }
  })

/**
 * `upg spec` - read-only browser over the UPG spec catalogue.
 *
 * Reads directly from `@unified-product-graph/core`. No graph file required.
 * Every noun maps to a core list function/array and an optional get function.
 * Subcommands are generated from a single NOUN_TABLE, so adding a new noun is
 * one table row.
 *
 * Usage:
 *   upg spec types                    list all entity types
 *   upg spec type <name>              get one entity type's metadata
 *   upg spec children <type>          list valid child types for a parent
 *   upg spec edges                    list all edge types
 *   upg spec edge <type>              get one edge type
 *   upg spec cross-edges              list portfolio cross-edge types
 *   upg spec resolve-edge <src> <tgt> resolve canonical edge for a pair
 *   upg spec regions                  list all regions
 *   upg spec region <id>              get one region
 *   upg spec region-for <type>        get region containing an entity type
 *   upg spec domains                  list domains (with usage guides)
 *   upg spec domain <id>              get domain usage guide
 *   upg spec rings                    list domain rings
 *   upg spec ring <id>                get one domain ring
 *   upg spec lenses                   list lenses
 *   upg spec lens <id>                get one lens (includes visible_types)
 *   upg spec frameworks               list frameworks
 *   upg spec framework <id>           get one framework
 *   upg spec framework-categories     list framework categories
 *   upg spec framework-patterns       list framework structure patterns
 *   upg spec playbooks                list playbooks
 *   upg spec playbook <id>            get one playbook
 *   upg spec approaches               list approaches
 *   upg spec approach <id>            get one approach
 *   upg spec lifecycles               list lifecycles
 *   upg spec lifecycle <type>         get lifecycle for an entity type
 *   upg spec status-values <type>     list valid status values for a type
 *   upg spec scales                   list assessment scales
 *   upg spec scale <id>               get one scale
 *   upg spec anti-patterns            list anti-patterns
 *   upg spec anti-pattern <id>        get one anti-pattern
 *   upg spec benchmarks               list benchmarks (requires --kind)
 *   upg spec stages                   list product stages
 *   upg spec migrations               list all migrations (type + edge + split)
 *   upg spec version                  get spec version and counts
 *   upg spec schema <type>            get entity schema (properties + edges)
 */

import { Command } from 'commander'
import chalk from 'chalk'
import {
  UPG_ENTITY_META,
  UPG_ENTITY_META_BY_NAME,
  UPG_ENTITY_TO_DOMAIN,
  UPG_EDGE_CATALOG,
  UPG_CROSS_EDGE_TYPES,
  UPG_REGIONS,
  UPG_REGION_MAP,
  UPG_REGION_COUNT,
  UPG_AREA_TAXONOMY,
  UPG_DOMAIN_GUIDES,
  UPG_DOMAINS,
  UPG_DOMAIN_RINGS,
  UPG_LENSES,
  UPG_FRAMEWORKS,
  UPG_FRAMEWORK_CATEGORIES,
  UPG_STRUCTURE_PATTERNS,
  UPG_PLAYBOOKS,
  UPG_APPROACHES,
  UPG_APPROACHES_BY_ID,
  UPG_LIFECYCLES,
  UPG_LIFECYCLE_FREE_TYPES,
  UPG_LIFECYCLE_PLANNED_TYPES,
  UPG_SCALES,
  UPG_ANTI_PATTERNS,
  UPG_COUNT_BENCHMARKS,
  UPG_RELATIONSHIP_BENCHMARKS,
  UPG_RATIO_BENCHMARKS,
  UPG_DOMAIN_ACTIVATION,
  UPG_PRODUCT_STAGES,
  UPG_MIGRATIONS,
  UPG_EDGE_MIGRATIONS,
  UPG_SPLIT_MIGRATIONS,
  UPG_VERSION,
  MARKDOWN_FORMAT_VERSION,
  UPG_ENTITY_COUNT,
  UPG_EDGE_COUNT,
  UPG_DOMAIN_COUNT,
  getCoverageKeysForRegion,
  getBusinessAreasForRegion,
  getLens,
  getVisibleTypes,
  getValidChildren,
  getRegionForEntityType,
  resolveContainmentEdge,
  type UPGEdgeDefinition,
  type UPGRegion,
} from '@unified-product-graph/core'
import { buildResolverHints } from '@unified-product-graph/sdk'
import { upgHeader } from '../lib/formatter.js'
import { die, runtimeError, usageError } from '../lib/errors.js'
import { sanitizeForTerminal } from '../lib/sanitize.js'

// ── Output helpers ────────────────────────────────────────────────────────────

function printJson(data: unknown): void {
  console.log(JSON.stringify(data, null, 2))
}

function row(key: string, value: unknown): string {
  const v =
    value === null || value === undefined
      ? chalk.dim('-')
      : Array.isArray(value)
        ? value.length === 0
          ? chalk.dim('(none)')
          : chalk.white(value.join(', '))
        : chalk.white(String(value))
  return `  ${chalk.dim(key.padEnd(22))} ${v}`
}

function printHeader(title: string): void {
  process.stdout.write(upgHeader(title))
}

function kv(label: string, value: unknown): void {
  console.log(row(label, value))
}

function tableRow(cols: string[], widths: number[]): string {
  return '  ' + cols.map((c, i) => c.padEnd(widths[i] ?? 0)).join('  ')
}

// ── Core data helpers ─────────────────────────────────────────────────────────

function typeToDomain(type: string): string | null {
  return (UPG_ENTITY_TO_DOMAIN as Record<string, string>)[type] ?? null
}

// ── Subcommand implementations ────────────────────────────────────────────────

// --- types / type / children ---

function cmdTypes(opts: { json?: boolean }): void {
  const typeToDomainMap = UPG_ENTITY_TO_DOMAIN as Record<string, string>
  const types = UPG_ENTITY_META.map((m) => ({
    name: m.name,
    maturity: m.maturity,
    domain_id: typeToDomainMap[m.name] ?? null,
    since: m.since,
  }))
  if (opts.json) { printJson({ total: types.length, types }); return }
  printHeader('Entity Types')
  const widths = [30, 12, 22, 10]
  console.log(chalk.dim(tableRow(['name', 'maturity', 'domain', 'since'], widths)))
  for (const t of types) {
    console.log(tableRow([
      chalk.white(t.name),
      chalk.dim(t.maturity),
      chalk.dim(t.domain_id ?? ''),
      chalk.dim(t.since ?? ''),
    ], widths))
  }
  console.log(chalk.dim(`\n  ${types.length} entity types`))
}

function cmdType(name: string, opts: { json?: boolean }): void {
  if (!name) die(usageError('Usage: upg spec type <name>'))
  const safe = sanitizeForTerminal(name)
  const meta = UPG_ENTITY_META_BY_NAME.get(name)
  if (!meta) die(runtimeError(`Unknown entity type: ${safe}`))
  const result = { ...meta, domain_id: typeToDomain(name) }
  if (opts.json) { printJson(result); return }
  printHeader(`Type: ${safe}`)
  kv('name', meta.name)
  kv('type_id', meta.type_id)
  kv('maturity', meta.maturity)
  kv('domain_id', typeToDomain(name))
  kv('since', meta.since)
  if ('deprecated_in' in meta && meta.deprecated_in) kv('deprecated_in', meta.deprecated_in)
  if ('replacement' in meta && meta.replacement) kv('replacement', meta.replacement)
}

function cmdChildren(parentType: string, opts: { json?: boolean }): void {
  if (!parentType) die(usageError('Usage: upg spec children <type>'))
  const safe = sanitizeForTerminal(parentType)
  const children = getValidChildren(parentType)
  if (opts.json) { printJson({ parent_type: parentType, valid_children: children }); return }
  printHeader(`Valid children of: ${safe}`)
  if (children.length === 0) {
    console.log(chalk.dim('  (none)'))
  } else {
    for (const c of children) console.log(`  ${chalk.white(c)}`)
  }
  console.log(chalk.dim(`\n  ${children.length} child type(s)`))
}

// --- edges / edge / cross-edges / resolve-edge ---

function cmdEdges(opts: { json?: boolean; source?: string; target?: string }): void {
  const entries: Array<{ type: string } & UPGEdgeDefinition> = []
  for (const [type, def] of Object.entries(UPG_EDGE_CATALOG) as Array<[string, UPGEdgeDefinition]>) {
    if (opts.source && def.source_type !== opts.source) continue
    if (opts.target && def.target_type !== opts.target) continue
    entries.push({ type, ...def })
  }
  if (opts.json) { printJson({ count: entries.length, edges: entries }); return }
  printHeader('Edge Types')
  const widths = [44, 22, 22, 16]
  console.log(chalk.dim(tableRow(['type', 'source', 'target', 'class'], widths)))
  for (const e of entries) {
    console.log(tableRow([
      chalk.white(e.type),
      chalk.dim(e.source_type),
      chalk.dim(e.target_type),
      chalk.dim(e.classification),
    ], widths))
  }
  console.log(chalk.dim(`\n  ${entries.length} edge type(s)`))
}

function cmdEdge(edgeType: string, opts: { json?: boolean }): void {
  if (!edgeType) die(usageError('Usage: upg spec edge <type>'))
  const safe = sanitizeForTerminal(edgeType)
  const def = (UPG_EDGE_CATALOG as Record<string, UPGEdgeDefinition>)[edgeType]
  if (!def) die(runtimeError(`Unknown edge type: ${safe}`))
  const result = { type: edgeType, ...def }
  if (opts.json) { printJson(result); return }
  printHeader(`Edge: ${safe}`)
  kv('type', edgeType)
  kv('source_type', def.source_type)
  kv('target_type', def.target_type)
  kv('classification', def.classification)
  if ('forward_verb' in def && def.forward_verb) kv('forward_verb', def.forward_verb)
  if ('reverse_verb' in def && def.reverse_verb) kv('reverse_verb', def.reverse_verb)
}

function cmdCrossEdges(opts: { json?: boolean }): void {
  if (opts.json) { printJson({ count: UPG_CROSS_EDGE_TYPES.length, types: UPG_CROSS_EDGE_TYPES }); return }
  printHeader('Cross-Edge Types')
  for (const t of UPG_CROSS_EDGE_TYPES) console.log(`  ${chalk.white(t)}`)
  console.log(chalk.dim(`\n  ${UPG_CROSS_EDGE_TYPES.length} cross-edge type(s)`))
}

function cmdResolveEdge(src: string, tgt: string, opts: { json?: boolean }): void {
  if (!src || !tgt) die(usageError('Usage: upg spec resolve-edge <source_type> <target_type>'))
  const safeSrc = sanitizeForTerminal(src)
  const safeTgt = sanitizeForTerminal(tgt)
  const edgeType = resolveContainmentEdge(src, tgt)
  const response: Record<string, unknown> = { source_type: src, target_type: tgt, edge_type: edgeType }
  if (edgeType === null) Object.assign(response, buildResolverHints(src, tgt))
  if (opts.json) { printJson(response); return }
  printHeader(`Resolve Edge: ${safeSrc} -> ${safeTgt}`)
  kv('source_type', src)
  kv('target_type', tgt)
  if (edgeType) {
    kv('edge_type', edgeType)
  } else {
    console.log(`  ${chalk.dim('edge_type')}               ${chalk.red('null')} (no canonical pair registered)`)
    if (response.anchor_hint) console.log(`\n  ${chalk.dim('anchor_hint:')} ${JSON.stringify(response.anchor_hint)}`)
    if (response.adjacent_edges) console.log(`  ${chalk.dim('adjacent_edges:')} ${JSON.stringify(response.adjacent_edges)}`)
  }
}

// --- regions / region / region-for ---

function cmdRegions(opts: { json?: boolean }): void {
  const regions = UPG_REGIONS.map((r) => ({
    id: r.id,
    label: r.label,
    order: r.order,
    anchor_type: r.anchor.type,
    entity_count: r.entities.length,
    intra_edge_count: r.intra_edges.length,
    boundary_edge_count: r.boundary_edges.length,
    coverage_keys: getCoverageKeysForRegion(r.id),
    business_areas: getBusinessAreasForRegion(r.id),
  }))
  if (opts.json) { printJson({ count: UPG_REGION_COUNT, regions, area_taxonomy: UPG_AREA_TAXONOMY }); return }
  printHeader('Regions')
  const widths = [28, 30, 6, 8]
  console.log(chalk.dim(tableRow(['id', 'label', 'order', 'entities'], widths)))
  for (const r of regions) {
    console.log(tableRow([
      chalk.white(r.id),
      chalk.dim(r.label),
      chalk.dim(String(r.order)),
      chalk.dim(String(r.entity_count)),
    ], widths))
  }
  console.log(chalk.dim(`\n  ${UPG_REGION_COUNT} region(s)`))
}

function cmdRegion(id: string, opts: { json?: boolean }): void {
  if (!id) die(usageError('Usage: upg spec region <id>'))
  const safe = sanitizeForTerminal(id)
  const region: UPGRegion | undefined = UPG_REGION_MAP[id]
  if (!region) die(runtimeError(`Unknown region id: ${safe}`))
  const result = {
    ...region,
    coverage_keys: getCoverageKeysForRegion(id),
    business_areas: getBusinessAreasForRegion(id),
  }
  if (opts.json) { printJson(result); return }
  printHeader(`Region: ${safe}`)
  kv('id', region.id)
  kv('label', region.label)
  kv('order', region.order)
  kv('shape', region.shape)
  kv('mental_model', region.mental_model)
  kv('anchor_type', region.anchor.type)
  kv('entity_count', region.entities.length)
  kv('intra_edge_count', region.intra_edges.length)
  kv('boundary_edge_count', region.boundary_edges.length)
  kv('domains', region.composes_atomic_domains)
  kv('coverage_keys', getCoverageKeysForRegion(id))
  kv('business_areas', getBusinessAreasForRegion(id))
}

function cmdRegionFor(entityType: string, opts: { json?: boolean }): void {
  if (!entityType) die(usageError('Usage: upg spec region-for <entity_type>'))
  const safe = sanitizeForTerminal(entityType)
  const region = getRegionForEntityType(entityType)
  if (!region) die(runtimeError(`No region contains entity_type: ${safe}`))
  if (opts.json) { printJson(region); return }
  printHeader(`Region for: ${safe}`)
  kv('region_id', region.id)
  kv('label', region.label)
  kv('anchor_type', region.anchor.type)
}

// --- domains / domain / rings / ring ---

function cmdDomains(opts: { json?: boolean; all?: boolean }): void {
  if (opts.all) {
    const guideIds = new Set(UPG_DOMAIN_GUIDES.map((g) => g.domain_id))
    const domains = UPG_DOMAINS.map((d) => ({
      domain_id: d.id,
      label: d.label,
      description: d.description,
      types: d.types,
      has_guide: guideIds.has(d.id),
    }))
    if (opts.json) { printJson({ count: domains.length, domains }); return }
    printHeader('All Domains')
    const widths = [26, 30, 9]
    console.log(chalk.dim(tableRow(['domain_id', 'label', 'has_guide'], widths)))
    for (const d of domains) {
      console.log(tableRow([chalk.white(d.domain_id), chalk.dim(d.label), chalk.dim(d.has_guide ? 'yes' : '')], widths))
    }
    console.log(chalk.dim(`\n  ${domains.length} domain(s)`))
    return
  }
  const domains = UPG_DOMAIN_GUIDES.map((g) => ({
    domain_id: g.domain_id,
    anchor_entity: g.anchor_entity,
    creation_sequence: g.creation_sequence,
  }))
  if (opts.json) { printJson({ count: domains.length, domains }); return }
  printHeader('Domains (with usage guides)')
  const widths = [26, 20]
  console.log(chalk.dim(tableRow(['domain_id', 'anchor_entity'], widths)))
  for (const d of domains) {
    console.log(tableRow([chalk.white(d.domain_id), chalk.dim(d.anchor_entity)], widths))
  }
  console.log(chalk.dim(`\n  ${domains.length} domain(s) with guides`))
}

function cmdDomain(domainId: string, opts: { json?: boolean }): void {
  if (!domainId) die(usageError('Usage: upg spec domain <domain_id>'))
  const safe = sanitizeForTerminal(domainId)
  const guide = UPG_DOMAIN_GUIDES.find((g) => g.domain_id === domainId)
  if (!guide) die(runtimeError(`Unknown domain_id: ${safe}`))
  if (opts.json) { printJson(guide); return }
  printHeader(`Domain: ${safe}`)
  kv('domain_id', guide.domain_id)
  kv('anchor_entity', guide.anchor_entity)
  kv('creation_sequence', guide.creation_sequence)
  if (guide.patterns?.length) {
    console.log(`\n  ${chalk.dim('patterns:')} ${guide.patterns.length}`)
  }
  if (guide.required_bridges?.length) {
    console.log(`  ${chalk.dim('required_bridges:')} ${guide.required_bridges.length}`)
  }
  if (guide.anti_patterns?.length) {
    console.log(`  ${chalk.dim('anti_patterns:')} ${guide.anti_patterns.length}`)
  }
}

function cmdRings(opts: { json?: boolean }): void {
  if (opts.json) { printJson({ rings: UPG_DOMAIN_RINGS, total: UPG_DOMAIN_RINGS.length }); return }
  printHeader('Domain Rings')
  const widths = [14, 40]
  console.log(chalk.dim(tableRow(['id', 'domain_ids'], widths)))
  for (const r of UPG_DOMAIN_RINGS) {
    const domainList = r.domain_ids.slice(0, 4).join(', ')
    console.log(tableRow([chalk.white(r.id), chalk.dim(domainList)], widths))
  }
  console.log(chalk.dim(`\n  ${UPG_DOMAIN_RINGS.length} ring(s)`))
}

function cmdRing(id: string, opts: { json?: boolean }): void {
  if (!id) die(usageError('Usage: upg spec ring <id>'))
  const safe = sanitizeForTerminal(id)
  const ring = UPG_DOMAIN_RINGS.find((r) => r.id === id)
  if (!ring) die(runtimeError(`Domain ring not found: ${safe}`))
  if (opts.json) { printJson(ring); return }
  printHeader(`Ring: ${safe}`)
  kv('id', ring.id)
  kv('label', ring.label)
  kv('description', ring.description)
  kv('domain_ids', ring.domain_ids)
}

// --- lenses / lens ---

function cmdLenses(opts: { json?: boolean }): void {
  const lenses = UPG_LENSES.map((l) => ({
    id: l.id,
    name: l.name,
    description: l.description,
    icon: l.icon,
    audience: l.audience,
    perspective: l.perspective,
    framework_id: l.framework_id,
    playbook_id: l.playbook_id,
    visible_domain_count: l.visible_domains.length,
    intelligence_prompt_count: l.intelligence_prompts.length,
  }))
  if (opts.json) { printJson({ count: UPG_LENSES.length, lenses }); return }
  printHeader('Lenses')
  const widths = [20, 28, 14]
  console.log(chalk.dim(tableRow(['id', 'name', 'audience'], widths)))
  for (const l of lenses) {
    console.log(tableRow([chalk.white(l.id), chalk.dim(l.name), chalk.dim(l.audience ?? '')], widths))
  }
  console.log(chalk.dim(`\n  ${UPG_LENSES.length} lens(es)`))
}

function cmdLens(id: string, opts: { json?: boolean }): void {
  if (!id) die(usageError('Usage: upg spec lens <id>'))
  const safe = sanitizeForTerminal(id)
  const lens = getLens(id)
  if (!lens) die(runtimeError(`Unknown lens id: ${safe}`))
  const visibleTypes = getVisibleTypes(lens)
  const result = { ...lens, visible_types: visibleTypes }
  if (opts.json) { printJson(result); return }
  printHeader(`Lens: ${safe}`)
  kv('id', lens.id)
  kv('name', lens.name)
  kv('description', lens.description)
  kv('audience', lens.audience)
  kv('perspective', lens.perspective)
  kv('framework_id', lens.framework_id)
  kv('playbook_id', lens.playbook_id)
  kv('visible_domains', lens.visible_domains)
  kv('visible_types_count', visibleTypes.length)
}

// --- frameworks / framework / framework-categories / framework-patterns ---

function cmdFrameworks(opts: { json?: boolean; category?: string }): void {
  let pool = [...UPG_FRAMEWORKS]
  if (opts.category) pool = pool.filter((f) => f.category === opts.category)
  const frameworks = pool.map((f) => ({
    id: f.id,
    name: f.name,
    category: f.category,
    description: f.description,
    tags: f.tags,
    approach_ids: f.approach_ids,
    structure_pattern: f.structure?.pattern,
  }))
  if (opts.json) { printJson({ total: pool.length, count: pool.length, frameworks }); return }
  printHeader('Frameworks')
  const widths = [28, 28, 20]
  console.log(chalk.dim(tableRow(['id', 'name', 'category'], widths)))
  for (const f of frameworks) {
    console.log(tableRow([chalk.white(f.id), chalk.dim(f.name), chalk.dim(f.category)], widths))
  }
  console.log(chalk.dim(`\n  ${pool.length} framework(s)`))
}

function cmdFramework(id: string, opts: { json?: boolean }): void {
  if (!id) die(usageError('Usage: upg spec framework <id>'))
  const safe = sanitizeForTerminal(id)
  const fw = UPG_FRAMEWORKS.find((f) => f.id === id)
  if (!fw) die(runtimeError(`Unknown framework id: "${safe}". See list_frameworks for valid ids.`))
  if (opts.json) { printJson(fw); return }
  printHeader(`Framework: ${safe}`)
  kv('id', fw.id)
  kv('name', fw.name)
  kv('category', fw.category)
  kv('description', fw.description)
  kv('tags', fw.tags)
  kv('approach_ids', fw.approach_ids)
  kv('structure_pattern', fw.structure?.pattern)
}

function cmdFrameworkCategories(opts: { json?: boolean }): void {
  if (opts.json) { printJson({ categories: UPG_FRAMEWORK_CATEGORIES, total: UPG_FRAMEWORK_CATEGORIES.length }); return }
  printHeader('Framework Categories')
  for (const c of UPG_FRAMEWORK_CATEGORIES) console.log(`  ${chalk.white(c)}`)
  console.log(chalk.dim(`\n  ${UPG_FRAMEWORK_CATEGORIES.length} categories`))
}

function cmdFrameworkPatterns(opts: { json?: boolean }): void {
  if (opts.json) { printJson({ patterns: UPG_STRUCTURE_PATTERNS, total: UPG_STRUCTURE_PATTERNS.length }); return }
  printHeader('Framework Structure Patterns')
  for (const p of UPG_STRUCTURE_PATTERNS) console.log(`  ${chalk.white(p)}`)
  console.log(chalk.dim(`\n  ${UPG_STRUCTURE_PATTERNS.length} patterns`))
}

// --- playbooks / playbook / approaches / approach ---

function cmdPlaybooks(opts: { json?: boolean; region?: string }): void {
  const allPlaybooks = [...UPG_PLAYBOOKS]
  const playbooks = opts.region ? allPlaybooks.filter((p) => p.region === opts.region) : allPlaybooks
  if (opts.json) { printJson({ count: playbooks.length, playbooks }); return }
  printHeader('Playbooks')
  const widths = [32, 28, 10]
  console.log(chalk.dim(tableRow(['id', 'name', 'region'], widths)))
  for (const p of playbooks) {
    console.log(tableRow([chalk.white(p.id), chalk.dim(p.name), chalk.dim(p.region)], widths))
  }
  console.log(chalk.dim(`\n  ${playbooks.length} playbook(s)`))
}

function cmdPlaybook(id: string, opts: { json?: boolean }): void {
  if (!id) die(usageError('Usage: upg spec playbook <id>'))
  const safe = sanitizeForTerminal(id)
  const playbook = UPG_PLAYBOOKS.find((p) => p.id === id)
  if (!playbook) die(runtimeError(`Unknown playbook id: ${safe}`))
  if (opts.json) { printJson(playbook); return }
  printHeader(`Playbook: ${safe}`)
  kv('id', playbook.id)
  kv('name', playbook.name)
  kv('version', playbook.version)
  kv('region', playbook.region)
  kv('is_canonical', playbook.is_canonical ?? false)
  kv('target_anchor_entity', playbook.target_anchor_entity ?? null)
  kv('steps', playbook.creation_sequence.length)
}

function cmdApproaches(opts: { json?: boolean }): void {
  if (opts.json) { printJson({ count: UPG_APPROACHES.length, approaches: UPG_APPROACHES }); return }
  printHeader('Approaches')
  const widths = [14, 28, 44]
  console.log(chalk.dim(tableRow(['id', 'label', 'question_answered'], widths)))
  for (const a of UPG_APPROACHES) {
    const q = 'question_answered' in a ? String(a.question_answered) : ''
    console.log(tableRow([chalk.white(a.id), chalk.dim(a.label), chalk.dim(q.slice(0, 42))], widths))
  }
  console.log(chalk.dim(`\n  ${UPG_APPROACHES.length} approach(es)`))
}

function cmdApproach(id: string, opts: { json?: boolean }): void {
  if (!id) die(usageError('Usage: upg spec approach <id>'))
  const safe = sanitizeForTerminal(id)
  const approach = UPG_APPROACHES_BY_ID[id]
  if (!approach) die(runtimeError(`Unknown approach id: ${safe}. Valid ids: plan, inspect, prioritise, trace, reflect.`))
  if (opts.json) { printJson(approach); return }
  printHeader(`Approach: ${safe}`)
  kv('id', approach.id)
  kv('label', approach.label)
  if ('description' in approach) kv('description', approach.description)
  if ('question_answered' in approach) kv('question_answered', approach.question_answered)
  if ('signature_hint' in approach) kv('signature_hint', approach.signature_hint)
}

// --- lifecycles / lifecycle / status-values ---

function cmdLifecycles(opts: { json?: boolean; type?: string }): void {
  let pool = [...UPG_LIFECYCLES]
  if (opts.type) pool = pool.filter((l) => l.entity_type === opts.type)
  const result = {
    total: pool.length,
    lifecycles: pool,
    free_types: Array.from(UPG_LIFECYCLE_FREE_TYPES).sort(),
    planned_types: Array.from(UPG_LIFECYCLE_PLANNED_TYPES).sort(),
  }
  if (opts.json) { printJson(result); return }
  printHeader('Lifecycles')
  const widths = [28, 20, 8]
  console.log(chalk.dim(tableRow(['entity_type', 'initial_phase', 'phases'], widths)))
  for (const l of pool) {
    console.log(tableRow([
      chalk.white(l.entity_type),
      chalk.dim(l.initial_phase),
      chalk.dim(String(l.phases.length)),
    ], widths))
  }
  console.log(chalk.dim(`\n  ${pool.length} lifecycle(s) - ${result.free_types.length} free types`))
}

function cmdLifecycle(entityType: string, opts: { json?: boolean }): void {
  if (!entityType) die(usageError('Usage: upg spec lifecycle <entity_type>'))
  const safe = sanitizeForTerminal(entityType)
  const lifecycle = UPG_LIFECYCLES.find((l) => l.entity_type === entityType)
  if (!lifecycle) {
    if (UPG_LIFECYCLE_FREE_TYPES.has(entityType)) {
      die(runtimeError(`No lifecycle for ${safe}: lifecycle-free (static type, no phase progression)`))
    }
    if (UPG_LIFECYCLE_PLANNED_TYPES.has(entityType)) {
      die(runtimeError(`No lifecycle for ${safe}: lifecycle planned but not yet authored in this spec version`))
    }
    die(runtimeError(`No lifecycle defined for entity type: ${safe}`))
  }
  if (opts.json) { printJson(lifecycle); return }
  printHeader(`Lifecycle: ${safe}`)
  kv('entity_type', lifecycle.entity_type)
  kv('initial_phase', lifecycle.initial_phase)
  kv('terminal_phases', lifecycle.terminal_phases)
  console.log(`\n  ${chalk.dim('phases:')}`)
  for (const p of lifecycle.phases) {
    const terminal = lifecycle.terminal_phases.includes(p.id) ? chalk.dim(' (terminal)') : ''
    console.log(`    ${chalk.white(p.id)}  ${chalk.dim(p.label)}${terminal}`)
  }
}

function cmdStatusValues(entityType: string, opts: { json?: boolean }): void {
  if (!entityType) die(usageError('Usage: upg spec status-values <entity_type>'))
  const safe = sanitizeForTerminal(entityType)
  const lifecycle = UPG_LIFECYCLES.find((l) => l.entity_type === entityType)
  if (!lifecycle) {
    const free = UPG_LIFECYCLE_FREE_TYPES.has(entityType)
    const planned = UPG_LIFECYCLE_PLANNED_TYPES.has(entityType)
    const note = free
      ? `${safe} is lifecycle-free: status is not state-machine-validated.`
      : planned
        ? `${safe} has a lifecycle planned but not yet authored.`
        : `No lifecycle defined for entity type: ${safe}.`
    if (opts.json) { printJson({ entity_type: entityType, lifecycle_free: free, values: [], note }); return }
    console.log(upgHeader(`Status values: ${safe}`))
    console.log(`  ${chalk.dim(note)}`)
    return
  }
  const terminal = new Set(lifecycle.terminal_phases)
  const values = lifecycle.phases.map((p) => ({
    status: p.id,
    label: p.label,
    terminal: terminal.has(p.id),
  }))
  if (opts.json) {
    printJson({
      entity_type: entityType,
      lifecycle_free: false,
      initial_status: lifecycle.initial_phase,
      terminal_statuses: lifecycle.terminal_phases,
      values,
    })
    return
  }
  printHeader(`Status values: ${safe}`)
  kv('initial_status', lifecycle.initial_phase)
  kv('terminal_statuses', lifecycle.terminal_phases)
  console.log(`\n  ${chalk.dim('values:')}`)
  for (const v of values) {
    const t = v.terminal ? chalk.dim(' (terminal)') : ''
    console.log(`    ${chalk.white(v.status)}  ${chalk.dim(v.label)}${t}`)
  }
}

// --- scales / scale ---

function cmdScales(opts: { json?: boolean }): void {
  const scales = Object.values(UPG_SCALES)
  if (opts.json) { printJson({ scales, total: scales.length }); return }
  printHeader('Assessment Scales')
  const widths = [20, 40]
  console.log(chalk.dim(tableRow(['id', 'description'], widths)))
  for (const s of scales) {
    console.log(tableRow([chalk.white(s.id), chalk.dim(s.description.slice(0, 38))], widths))
  }
  console.log(chalk.dim(`\n  ${scales.length} scale(s)`))
}

function cmdScale(id: string, opts: { json?: boolean }): void {
  if (!id) die(usageError('Usage: upg spec scale <id>'))
  const safe = sanitizeForTerminal(id)
  const scale = UPG_SCALES[id]
  if (!scale) die(runtimeError(`Scale not found: ${safe}`))
  if (opts.json) { printJson(scale); return }
  printHeader(`Scale: ${safe}`)
  kv('id', scale.id)
  kv('label', scale.label)
  kv('description', scale.description)
  kv('min', scale.min)
  kv('max', scale.max)
  console.log(`\n  ${chalk.dim('points:')}`)
  for (const p of scale.points) {
    console.log(`    ${chalk.white(String(p.value))}  ${chalk.dim(p.label)}`)
  }
}

// --- anti-patterns / anti-pattern ---

function cmdAntiPatterns(opts: { json?: boolean; severity?: string }): void {
  let pool = [...UPG_ANTI_PATTERNS]
  if (opts.severity) pool = pool.filter((p) => p.severity === opts.severity)
  if (opts.json) { printJson({ total: pool.length, count: pool.length, anti_patterns: pool }); return }
  printHeader('Anti-Patterns')
  const widths = [44, 8, 30]
  console.log(chalk.dim(tableRow(['id', 'severity', 'name'], widths)))
  for (const p of pool) {
    const name = 'name' in p ? String(p.name) : ''
    console.log(tableRow([chalk.white(p.id), chalk.dim(p.severity), chalk.dim(name)], widths))
  }
  console.log(chalk.dim(`\n  ${pool.length} anti-pattern(s)`))
}

function cmdAntiPattern(id: string, opts: { json?: boolean }): void {
  if (!id) die(usageError('Usage: upg spec anti-pattern <id>'))
  const safe = sanitizeForTerminal(id)
  const pattern = UPG_ANTI_PATTERNS.find((p) => p.id === id)
  if (!pattern) die(runtimeError(`Unknown anti-pattern id: ${safe}`))
  if (opts.json) { printJson(pattern); return }
  printHeader(`Anti-Pattern: ${safe}`)
  kv('id', pattern.id)
  kv('name', pattern.name)
  kv('severity', pattern.severity)
  kv('stages', pattern.stages)
  kv('why_it_matters', pattern.why_it_matters)
  kv('remediation', pattern.remediation)
  if (pattern.since) kv('since', pattern.since)
}

// --- benchmarks ---

function cmdBenchmarks(opts: { json?: boolean; kind?: string; stage?: string; domain?: string }): void {
  const kind = opts.kind
  if (!kind) die(usageError('Usage: upg spec benchmarks --kind <count|relationship|ratio|domain_activation>'))
  const typeToDomainMap = UPG_ENTITY_TO_DOMAIN as Record<string, string>

  if (kind === 'count') {
    let pool = [...UPG_COUNT_BENCHMARKS]
    if (opts.domain) pool = pool.filter((b) => b.domain === opts.domain)
    if (opts.stage) pool = pool.filter((b) => (b as unknown as Record<string, unknown>)[opts.stage!] !== null)
    if (opts.json) { printJson({ kind, total: UPG_COUNT_BENCHMARKS.length, count: pool.length, benchmarks: pool }); return }
    printHeader('Benchmarks: count')
    for (const b of pool) console.log(`  ${chalk.white(b.type)}  ${chalk.dim(b.domain)}`)
    return
  }
  if (kind === 'relationship') {
    let pool = [...UPG_RELATIONSHIP_BENCHMARKS]
    if (opts.stage) pool = pool.filter((b) => b.stages.includes(opts.stage as never))
    if (opts.domain) pool = pool.filter((b) => typeToDomainMap[b.parent_type] === opts.domain || typeToDomainMap[b.child_type] === opts.domain)
    if (opts.json) { printJson({ kind, total: UPG_RELATIONSHIP_BENCHMARKS.length, count: pool.length, benchmarks: pool }); return }
    printHeader('Benchmarks: relationship')
    for (const b of pool) console.log(`  ${chalk.white(b.parent_type)} -> ${chalk.dim(b.child_type)}`)
    return
  }
  if (kind === 'ratio') {
    let pool = [...UPG_RATIO_BENCHMARKS]
    if (opts.stage) pool = pool.filter((b) => b.stages.includes(opts.stage as never))
    if (opts.json) { printJson({ kind, total: UPG_RATIO_BENCHMARKS.length, count: pool.length, benchmarks: pool }); return }
    printHeader('Benchmarks: ratio')
    for (const b of pool) console.log(`  ${chalk.dim(String(b.numerator_type))} / ${chalk.dim(String(b.denominator_type))}`)
    return
  }
  if (kind === 'domain_activation') {
    let pool = [...UPG_DOMAIN_ACTIVATION]
    if (opts.domain) pool = pool.filter((b) => b.domain_id === opts.domain)
    if (opts.stage) pool = pool.filter((b) => b.expected_from === opts.stage || b.expected_mature === opts.stage)
    if (opts.json) { printJson({ kind, total: UPG_DOMAIN_ACTIVATION.length, count: pool.length, benchmarks: pool }); return }
    printHeader('Benchmarks: domain_activation')
    const widths = [26, 14, 14]
    console.log(chalk.dim(tableRow(['domain_id', 'expected_from', 'expected_mature'], widths)))
    for (const b of pool) {
      console.log(tableRow([chalk.white(b.domain_id), chalk.dim(b.expected_from), chalk.dim(b.expected_mature)], widths))
    }
    return
  }
  die(usageError(`Unknown kind: ${kind}. Expected: count, relationship, ratio, domain_activation.`))
}

// --- stages ---

function cmdStages(opts: { json?: boolean }): void {
  if (opts.json) { printJson({ count: UPG_PRODUCT_STAGES.length, stages: UPG_PRODUCT_STAGES }); return }
  printHeader('Product Stages')
  for (const s of UPG_PRODUCT_STAGES) console.log(`  ${chalk.white(s)}`)
  console.log(chalk.dim(`\n  ${UPG_PRODUCT_STAGES.length} stage(s)`))
}

// --- migrations ---

function cmdMigrations(opts: { json?: boolean }): void {
  const typeMigrations: Array<{ from: string; to: string; since: string }> = []
  for (const [since, entries] of Object.entries(UPG_MIGRATIONS)) {
    for (const m of entries) typeMigrations.push({ from: m.from, to: m.to, since })
  }
  const edgeMigrations: Array<{ kind: string; from: string; to?: string; since: string }> = []
  for (const [since, entries] of Object.entries(UPG_EDGE_MIGRATIONS)) {
    for (const m of entries) {
      edgeMigrations.push({ kind: m.kind, from: m.from, ...(m.kind === 'rename' ? { to: m.to } : {}), since })
    }
  }
  const splitMigrations: Array<Record<string, unknown>> = []
  for (const [since, entries] of Object.entries(UPG_SPLIT_MIGRATIONS)) {
    for (const m of entries) splitMigrations.push({ ...m, since })
  }
  if (opts.json) {
    printJson({
      type_migrations: { total: typeMigrations.length, migrations: typeMigrations },
      edge_migrations: { total: edgeMigrations.length, migrations: edgeMigrations },
      split_migrations: { total: splitMigrations.length, splits: splitMigrations },
    })
    return
  }
  printHeader('Migrations')
  console.log(chalk.bold(`\n  Type migrations (${typeMigrations.length})`))
  for (const m of typeMigrations.slice(0, 20)) {
    console.log(`  ${chalk.white(m.from)} -> ${chalk.dim(m.to)}  ${chalk.dim(m.since)}`)
  }
  if (typeMigrations.length > 20) console.log(chalk.dim(`  ... and ${typeMigrations.length - 20} more`))
  console.log(chalk.bold(`\n  Edge migrations (${edgeMigrations.length})`))
  for (const m of edgeMigrations.slice(0, 20)) {
    const to = m.to ? ` -> ${m.to}` : ' (dropped)'
    console.log(`  ${chalk.white(m.from)}${chalk.dim(to)}  ${chalk.dim(m.since)}`)
  }
  if (edgeMigrations.length > 20) console.log(chalk.dim(`  ... and ${edgeMigrations.length - 20} more`))
  console.log(chalk.bold(`\n  Split migrations (${splitMigrations.length})`))
  for (const m of splitMigrations) {
    const from = String(m.from ?? '')
    const into = Array.isArray(m.into) ? (m.into as string[]).join(' + ') : ''
    console.log(`  ${chalk.white(from)} -> ${chalk.dim(into)}  ${chalk.dim(String(m.since ?? ''))}`)
  }
}

// --- version ---

function cmdVersion(opts: { json?: boolean }): void {
  const result = {
    upg_version: UPG_VERSION,
    markdown_format_version: MARKDOWN_FORMAT_VERSION,
    entity_count: UPG_ENTITY_COUNT,
    edge_count: UPG_EDGE_COUNT,
    domain_count: UPG_DOMAIN_COUNT,
    region_count: UPG_REGION_COUNT,
    anti_patterns: {
      total: UPG_ANTI_PATTERNS.length,
      versioned: UPG_ANTI_PATTERNS.filter((p) => p.since).map((p) => ({
        id: p.id,
        severity: p.severity,
        since: p.since,
      })),
    },
  }
  if (opts.json) { printJson(result); return }
  printHeader('Spec Version')
  kv('upg_version', UPG_VERSION)
  kv('markdown_format_version', MARKDOWN_FORMAT_VERSION)
  kv('entity_count', UPG_ENTITY_COUNT)
  kv('edge_count', UPG_EDGE_COUNT)
  kv('domain_count', UPG_DOMAIN_COUNT)
  kv('region_count', UPG_REGION_COUNT)
  kv('anti_patterns_total', UPG_ANTI_PATTERNS.length)
}

// --- schema ---

function cmdSchema(entityType: string, opts: { json?: boolean }): void {
  if (!entityType) die(usageError('Usage: upg spec schema <type>'))
  const safe = sanitizeForTerminal(entityType)
  const meta = UPG_ENTITY_META_BY_NAME.get(entityType)
  if (!meta) die(runtimeError(`Unknown entity type: ${safe}`))

  const domainId = typeToDomain(entityType)
  const validChildren = getValidChildren(entityType)
  const lifecycle = UPG_LIFECYCLES.find((l) => l.entity_type === entityType)
  const edgesOut: Array<{ type: string; target_type: string; classification: string }> = []
  const edgesIn: Array<{ type: string; source_type: string; classification: string }> = []
  for (const [type, def] of Object.entries(UPG_EDGE_CATALOG) as Array<[string, UPGEdgeDefinition]>) {
    if (def.source_type === entityType) edgesOut.push({ type, target_type: def.target_type, classification: def.classification })
    if (def.target_type === entityType) edgesIn.push({ type, source_type: def.source_type, classification: def.classification })
  }

  const result = {
    type: entityType,
    domain: domainId,
    maturity: meta.maturity,
    valid_children: validChildren,
    phases: lifecycle ? lifecycle.phases.map((p) => p.id) : undefined,
    initial_phase: lifecycle?.initial_phase,
    terminal_phases: lifecycle?.terminal_phases,
    edges_out: edgesOut,
    edges_in: edgesIn,
  }
  if (opts.json) { printJson(result); return }
  printHeader(`Schema: ${safe}`)
  kv('type', entityType)
  kv('domain', domainId)
  kv('maturity', meta.maturity)
  kv('valid_children', validChildren)
  if (lifecycle) {
    kv('initial_phase', lifecycle.initial_phase)
    kv('terminal_phases', lifecycle.terminal_phases)
    kv('phases', lifecycle.phases.map((p) => p.id))
  }
  console.log(`\n  ${chalk.dim(`edges_out (${edgesOut.length}):`)}`)
  for (const e of edgesOut.slice(0, 10)) {
    console.log(`    ${chalk.white(e.type)} -> ${chalk.dim(e.target_type)}`)
  }
  if (edgesOut.length > 10) console.log(chalk.dim(`    ... and ${edgesOut.length - 10} more`))
  console.log(`\n  ${chalk.dim(`edges_in (${edgesIn.length}):`)}`)
  for (const e of edgesIn.slice(0, 10)) {
    console.log(`    ${chalk.dim(e.source_type)} -> ${chalk.white(e.type)}`)
  }
  if (edgesIn.length > 10) console.log(chalk.dim(`    ... and ${edgesIn.length - 10} more`))
}

// ── Command tree ──────────────────────────────────────────────────────────────

export const specCommand = new Command('spec')
  .description('Browse the UPG spec catalogue: entity types, edges, regions, frameworks, lifecycles, and more.')

specCommand
  .command('types')
  .description('List all entity types.')
  .option('--json', 'Machine-readable JSON output')
  .action((opts) => { try { cmdTypes(opts) } catch (err) { die(err) } })

specCommand
  .command('type <name>')
  .description('Get metadata for one entity type.')
  .option('--json', 'Machine-readable JSON output')
  .action((name: string, opts) => { try { cmdType(name, opts) } catch (err) { die(err) } })

specCommand
  .command('children <type>')
  .description('List valid child types for a parent entity type.')
  .option('--json', 'Machine-readable JSON output')
  .action((type: string, opts) => { try { cmdChildren(type, opts) } catch (err) { die(err) } })

specCommand
  .command('edges')
  .description('List all edge types from the spec catalogue.')
  .option('--json', 'Machine-readable JSON output')
  .option('--source <type>', 'Filter by source entity type')
  .option('--target <type>', 'Filter by target entity type')
  .action((opts) => { try { cmdEdges(opts) } catch (err) { die(err) } })

specCommand
  .command('edge <type>')
  .description('Get details for one edge type.')
  .option('--json', 'Machine-readable JSON output')
  .action((type: string, opts) => { try { cmdEdge(type, opts) } catch (err) { die(err) } })

specCommand
  .command('cross-edges')
  .description('List portfolio cross-edge types.')
  .option('--json', 'Machine-readable JSON output')
  .action((opts) => { try { cmdCrossEdges(opts) } catch (err) { die(err) } })

specCommand
  .command('resolve-edge <src> <tgt>')
  .description('Resolve the canonical edge type for a source -> target entity pair.')
  .option('--json', 'Machine-readable JSON output')
  .action((src: string, tgt: string, opts) => { try { cmdResolveEdge(src, tgt, opts) } catch (err) { die(err) } })

specCommand
  .command('regions')
  .description('List all UPG regions.')
  .option('--json', 'Machine-readable JSON output')
  .action((opts) => { try { cmdRegions(opts) } catch (err) { die(err) } })

specCommand
  .command('region <id>')
  .description('Get the full record for one region.')
  .option('--json', 'Machine-readable JSON output')
  .action((id: string, opts) => { try { cmdRegion(id, opts) } catch (err) { die(err) } })

specCommand
  .command('region-for <type>')
  .description('Get the region that contains a given entity type.')
  .option('--json', 'Machine-readable JSON output')
  .action((type: string, opts) => { try { cmdRegionFor(type, opts) } catch (err) { die(err) } })

specCommand
  .command('domains')
  .description('List domains (default: those with usage guides).')
  .option('--json', 'Machine-readable JSON output')
  .option('--all', 'Include all atomic domains, not just those with guides')
  .action((opts) => { try { cmdDomains(opts) } catch (err) { die(err) } })

specCommand
  .command('domain <id>')
  .description('Get the usage guide for one domain.')
  .option('--json', 'Machine-readable JSON output')
  .action((id: string, opts) => { try { cmdDomain(id, opts) } catch (err) { die(err) } })

specCommand
  .command('rings')
  .description('List domain rings.')
  .option('--json', 'Machine-readable JSON output')
  .action((opts) => { try { cmdRings(opts) } catch (err) { die(err) } })

specCommand
  .command('ring <id>')
  .description('Get one domain ring by id.')
  .option('--json', 'Machine-readable JSON output')
  .action((id: string, opts) => { try { cmdRing(id, opts) } catch (err) { die(err) } })

specCommand
  .command('lenses')
  .description('List all lenses.')
  .option('--json', 'Machine-readable JSON output')
  .action((opts) => { try { cmdLenses(opts) } catch (err) { die(err) } })

specCommand
  .command('lens <id>')
  .description('Get the full record for one lens, including visible types.')
  .option('--json', 'Machine-readable JSON output')
  .action((id: string, opts) => { try { cmdLens(id, opts) } catch (err) { die(err) } })

specCommand
  .command('frameworks')
  .description('List frameworks (paginated summary).')
  .option('--json', 'Machine-readable JSON output')
  .option('--category <category>', 'Filter by framework category')
  .action((opts) => { try { cmdFrameworks(opts) } catch (err) { die(err) } })

specCommand
  .command('framework <id>')
  .description('Get the full record for one framework.')
  .option('--json', 'Machine-readable JSON output')
  .action((id: string, opts) => { try { cmdFramework(id, opts) } catch (err) { die(err) } })

specCommand
  .command('framework-categories')
  .description('List valid framework category values.')
  .option('--json', 'Machine-readable JSON output')
  .action((opts) => { try { cmdFrameworkCategories(opts) } catch (err) { die(err) } })

specCommand
  .command('framework-patterns')
  .description('List valid framework structure pattern values.')
  .option('--json', 'Machine-readable JSON output')
  .action((opts) => { try { cmdFrameworkPatterns(opts) } catch (err) { die(err) } })

specCommand
  .command('playbooks')
  .description('List canonical UPG playbooks.')
  .option('--json', 'Machine-readable JSON output')
  .option('--region <region>', 'Filter by region id')
  .action((opts) => { try { cmdPlaybooks(opts) } catch (err) { die(err) } })

specCommand
  .command('playbook <id>')
  .description('Get one playbook by id.')
  .option('--json', 'Machine-readable JSON output')
  .action((id: string, opts) => { try { cmdPlaybook(id, opts) } catch (err) { die(err) } })

specCommand
  .command('approaches')
  .description('List the five canonical UPG approaches.')
  .option('--json', 'Machine-readable JSON output')
  .action((opts) => { try { cmdApproaches(opts) } catch (err) { die(err) } })

specCommand
  .command('approach <id>')
  .description('Get one approach by id (plan, inspect, prioritise, trace, reflect).')
  .option('--json', 'Machine-readable JSON output')
  .action((id: string, opts) => { try { cmdApproach(id, opts) } catch (err) { die(err) } })

specCommand
  .command('lifecycles')
  .description('List lifecycle definitions.')
  .option('--json', 'Machine-readable JSON output')
  .option('--type <type>', 'Filter by entity type')
  .action((opts) => { try { cmdLifecycles(opts) } catch (err) { die(err) } })

specCommand
  .command('lifecycle <type>')
  .description('Get lifecycle phases for one entity type.')
  .option('--json', 'Machine-readable JSON output')
  .action((type: string, opts) => { try { cmdLifecycle(type, opts) } catch (err) { die(err) } })

specCommand
  .command('status-values <type>')
  .description('List valid status values a node of this type can hold.')
  .option('--json', 'Machine-readable JSON output')
  .action((type: string, opts) => { try { cmdStatusValues(type, opts) } catch (err) { die(err) } })

specCommand
  .command('scales')
  .description('List spec-defined assessment scales.')
  .option('--json', 'Machine-readable JSON output')
  .action((opts) => { try { cmdScales(opts) } catch (err) { die(err) } })

specCommand
  .command('scale <id>')
  .description('Get one assessment scale by id.')
  .option('--json', 'Machine-readable JSON output')
  .action((id: string, opts) => { try { cmdScale(id, opts) } catch (err) { die(err) } })

specCommand
  .command('anti-patterns')
  .description('List curated anti-patterns.')
  .option('--json', 'Machine-readable JSON output')
  .option('--severity <severity>', 'Filter by severity (high, medium, low)')
  .action((opts) => { try { cmdAntiPatterns(opts) } catch (err) { die(err) } })

specCommand
  .command('anti-pattern <id>')
  .description('Get one anti-pattern by id.')
  .option('--json', 'Machine-readable JSON output')
  .action((id: string, opts) => { try { cmdAntiPattern(id, opts) } catch (err) { die(err) } })

specCommand
  .command('benchmarks')
  .description('List spec benchmarks. Requires --kind (count, relationship, ratio, domain_activation).')
  .option('--json', 'Machine-readable JSON output')
  .requiredOption('--kind <kind>', 'Benchmark catalog: count, relationship, ratio, domain_activation')
  .option('--stage <stage>', 'Filter by product stage')
  .option('--domain <domain>', 'Filter by atomic domain id')
  .action((opts) => { try { cmdBenchmarks(opts) } catch (err) { die(err) } })

specCommand
  .command('stages')
  .description('List the canonical product stages (concept through sunset).')
  .option('--json', 'Machine-readable JSON output')
  .action((opts) => { try { cmdStages(opts) } catch (err) { die(err) } })

specCommand
  .command('migrations')
  .description('List all type, edge, and split migrations.')
  .option('--json', 'Machine-readable JSON output')
  .action((opts) => { try { cmdMigrations(opts) } catch (err) { die(err) } })

specCommand
  .command('version')
  .description('Get spec version, format version, and entity/edge counts.')
  .option('--json', 'Machine-readable JSON output')
  .action((opts) => { try { cmdVersion(opts) } catch (err) { die(err) } })

specCommand
  .command('schema <type>')
  .description('Get entity schema: valid children, lifecycle phases, edges out and in.')
  .option('--json', 'Machine-readable JSON output')
  .action((type: string, opts) => { try { cmdSchema(type, opts) } catch (err) { die(err) } })

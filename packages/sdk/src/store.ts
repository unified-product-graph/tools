import * as fs from 'node:fs/promises'
import * as path from 'node:path'
import { createHash, randomUUID } from 'node:crypto'
import lockfile from 'proper-lockfile'
import type { FSWatcher } from 'chokidar'
import {
  validateUPGDocument,
  type UPGDocument,
  type UPGBaseNode,
  type UPGEdge,
  type UPGIntegrity,
  type UPGValidationError,
  type UPGPortfolioDocument,
  type UPGCrossEdge,
  type UPGRegistry,
  UPG_CROSS_EDGE_TYPES,
} from '@unified-product-graph/core'
import { UPG_TYPES, rotateSlug, migrateEdge, migrateNodeProperties, UPG_VERSION, type UPGPropertyMigrationChange } from '@unified-product-graph/core'
import { serializeCanonical, normalizeDocument } from '@unified-product-graph/core'
import { coerceProductStage } from '@unified-product-graph/core'
import type { UPGEdgeType, UPGEntityType, UPGCrossEdgeType } from '@unified-product-graph/core'
import {
  classifyDanglingEdges,
  renderDanglingReport,
  type DanglingEdgeReport,
  type DanglingEdgeClass,
} from './lib/dangling-edges.js'
import {
  computeSchemaDriftSummary,
  renderDriftSummary,
  type SchemaDriftSummary,
} from './lib/schema-drift.js'

export interface QuarantinedEntity {
  id: string
  type: string
  title: string
  reason: string
}

export interface IntegrityReport {
  /** Whether the file was modified outside the MCP server */
  tampered: boolean
  /** Entities that failed schema validation after external modification */
  quarantined: QuarantinedEntity[]
  /** Edges removed because they reference quarantined or missing nodes */
  orphanedEdges: number
  /**
   *: content-validity errors found at LOAD time on a structurally
   * sound document (valid JSON + a present `$upg` envelope) that nonetheless
   * fails one or more spec content checks (e.g. an unknown node type from a
   * stricter spec, a dangling edge endpoint, an invalid enum value).
   *
   * The load path is PERMISSIVE about these: it warns to stderr and loads the
   * graph anyway so reads, and the delete/update that could repair the file,
   * still work. The errors are recorded here for the operator/agent to act on.
   * The WRITE/flush path stays STRICT, so no new invalid state is persisted.
   * Empty array = the document was content-valid at load.
   */
  contentValidationErrors: UPGValidationError[]
}

export interface ChangeEntry {
  action: 'create' | 'update' | 'delete'
  entity: 'node' | 'edge'
  id: string
  type: string
  title?: string
  timestamp: string
}

export interface MergeResult {
  merged: boolean
  nodesAdded: number
  edgesAdded: number
  nodesFromDisk: number
  edgesFromDisk: number
  conflicts: Array<{ nodeId: string; field: string; ours: unknown; theirs: unknown }>
}

export class UPGFileStore {
  private doc!: UPGDocument
  private filePath!: string
  private dirty = false
  private saveTimer: ReturnType<typeof setTimeout> | null = null
  private watcher: FSWatcher | null = null
  /** Identity of the tool writing through this store, stamped on every flush. */
  private writer?: { tool: string; tool_version?: string }

  // Indexes for O(1) lookups
  private nodeMap = new Map<string, UPGBaseNode>()
  private edgeMap = new Map<string, UPGEdge>()
  private edgesByNode = new Map<string, Set<string>>() // nodeId → Set<edgeId>

  // Session change log
  private changeLog: ChangeEntry[] = []

  // Content hash for cache-aware responses
  private contentHash = ''

  // ── Concurrent write protection ─────────────────────────────────────────
  // Baseline = the raw file hash at the time we loaded or last saved.
  // If disk hash != baseline when we try to save, another process modified the file.
  private baselineFileHash = ''
  // Snapshot of node/edge IDs at baseline, used for three-way merge
  private baselineNodeIds = new Set<string>()
  private baselineEdgeIds = new Set<string>()
  // Last merge result (available to the server for reporting)
  private lastMergeResult: MergeResult | null = null

  // ── Integrity protection ───────────────────────────────────────────────
  // Last integrity check result (available to the server for reporting)
  private lastIntegrityReport: IntegrityReport | null = null
  // Set of known UPG entity types for schema validation
  private knownTypes = new Set(UPG_TYPES)
  // ── Dangling-edge tracking ───────────────────────────────────
  private lastDanglingReport: DanglingEdgeReport | null = null
  private lastDriftSummary: SchemaDriftSummary | null = null

  // ── Load / Save ──────────────────────────────────────────────────────────

  /** Hash raw file bytes, used for baseline comparison (NOT the same as contentHash) */
  private hashRawContent(raw: string): string {
    return createHash('sha256').update(raw).digest('hex').slice(0, 32)
  }

  /**
   *: deterministic advisory-lock path, keyed on the RESOLVED `.upg`
   * path so every process that writes the same file contends for the same
   * lock. proper-lockfile creates a `<lockfilePath>` directory as the lock
   * token (atomic mkdir), independent of the data file existing, which is why
   * we set an explicit path + `realpath: false`: `save()` re-reads disk and
   * the data file may have been deleted out from under us mid-flight.
   */
  private lockFilePathFor(filePath: string): string {
    return filePath + '.lock'
  }

  /**
   *: acquire the advisory file lock around the read-modify-write +
   * atomic-rename window in `save()`. Without this, two concurrent writers
   * each load the same baseline, each append a node, and the second `rename`
   * clobbers the first writer's append (the lost-update bug verified via
   * `for i in $(seq 1 12); do upg create ... & done; wait` → 11/12 persisted).
   *
   * Returns a `release()` thunk the caller MUST invoke in a `finally`. Retries
   * with exponential backoff so a writer that finds the lock held SERIALIZES
   * behind the holder instead of failing or losing its update. `stale` lets a
   * crashed holder's lock be reclaimed so a dead process can't wedge writes.
   */
  private async acquireWriteLock(): Promise<() => Promise<void>> {
    return lockfile.lock(this.filePath, {
      lockfilePath: this.lockFilePathFor(this.filePath),
      realpath: false,
      stale: 15_000,
      // 10 retries, exponential backoff (~10ms..~1s), tens of writers serialize
      // cleanly in practice. minTimeout/maxTimeout bound the per-attempt wait.
      retries: { retries: 10, factor: 2, minTimeout: 10, maxTimeout: 1_000, randomize: true },
    })
  }

  /** Compute integrity checksum over nodes + edges content (deterministic) */
  private computeIntegrityChecksum(): string {
    // Sort nodes and edges by ID for deterministic hash regardless of order
    const sortedNodes = [...this.doc.nodes].sort((a, b) => a.id.localeCompare(b.id))
    const sortedEdges = [...this.doc.edges].sort((a, b) => a.id.localeCompare(b.id))
    const content = JSON.stringify({ nodes: sortedNodes, edges: sortedEdges })
    return createHash('sha256').update(content).digest('hex').slice(0, 32)
  }

  /** Stamp the document with current integrity checksum */
  private stampIntegrity(): void {
    this.doc._integrity = {
      checksum: this.computeIntegrityChecksum(),
      verified_at: new Date().toISOString(),
      verified_by: 'upg-mcp-local',
    }
  }

  /** Verify integrity and quarantine invalid entities if file was modified externally */
  private verifyIntegrity(): IntegrityReport {
    const report: IntegrityReport = { tampered: false, quarantined: [], orphanedEdges: 0, contentValidationErrors: [] }

    // Check if integrity stamp exists
    if (!this.doc._integrity) {
      // First time: no stamp yet. Stamp it now, no quarantine needed.
      this.stampIntegrity()
      return report
    }

    // Verify checksum
    const currentChecksum = this.computeIntegrityChecksum()
    if (currentChecksum === this.doc._integrity.checksum) {
      // File was not modified externally; all good
      return report
    }

    // File was modified outside the MCP server
    report.tampered = true

    // Run entity-level validation: check each node against known types
    const validNodeIds = new Set<string>()
    const quarantinedIds = new Set<string>()

    this.doc.nodes = this.doc.nodes.filter((node) => {
      // Must have id, type, title
      if (!node.id || !node.type || !node.title) {
        report.quarantined.push({
          id: node.id || 'unknown',
          type: node.type || 'unknown',
          title: node.title || 'untitled',
          reason: 'Missing required field (id, type, or title)',
        })
        quarantinedIds.add(node.id || 'unknown')
        return false
      }

      // Type must be known
      if (!this.knownTypes.has(node.type) && node.type !== 'product' && node.type !== 'document') {
        report.quarantined.push({
          id: node.id,
          type: node.type,
          title: node.title,
          reason: `Unknown entity type: "${node.type}"`,
        })
        quarantinedIds.add(node.id)
        return false
      }

      validNodeIds.add(node.id)
      return true
    })

    // Remove edges referencing quarantined or missing nodes
    const beforeEdgeCount = this.doc.edges.length
    this.doc.edges = this.doc.edges.filter((edge) => {
      if (!edge.id || !edge.source || !edge.target || !edge.type) return false
      return validNodeIds.has(edge.source) && validNodeIds.has(edge.target)
    })
    report.orphanedEdges = beforeEdgeCount - this.doc.edges.length

    // Re-stamp with clean checksum after quarantine
    if (report.quarantined.length > 0 || report.orphanedEdges > 0) {
      this.stampIntegrity()
      this.dirty = true
    } else {
      // Tampered but all entities valid; re-stamp to accept the changes
      this.stampIntegrity()
      this.dirty = true
    }

    return report
  }

  getIntegrityReport(): IntegrityReport | null {
    return this.lastIntegrityReport
  }

  /** Snapshot current node/edge IDs as baseline for three-way merge */
  private snapshotBaseline(): void {
    this.baselineNodeIds = new Set(this.doc.nodes.map((n) => n.id))
    this.baselineEdgeIds = new Set(this.doc.edges.map((e) => e.id))
  }

  getLastMergeResult(): MergeResult | null {
    return this.lastMergeResult
  }

  /**
   *: split validator errors into the ones that mean "this isn't a UPG
   * file at all" (structural / envelope) versus "this IS a UPG file but some
   * content is spec-invalid" (content-validity).
   *
   * normalizeDocument() has already lifted the on-disk `$upg` envelope into the
   * flat in-memory shape, so the validator reports envelope problems against
   * the flat root paths below. A bare hand-authored `{ product, nodes, edges }`
   * with no `$upg` block lands here as missing `$.upg_version` / `$.exported_at`
   * / `$.source` (the envelope-derived fields), which is exactly what we treat
   * as a HARD structural failure. Anything indexed into a node or edge
   * (`$.nodes[i]...`, `$.edges[i]...`) is content-validity and must NOT brick a
   * load: a stricter spec landing an unknown enum on one node should surface as
   * a warning, not lock the operator out of the delete/update that repairs it.
   */
  private classifyValidationErrors(errors: UPGValidationError[]): {
    structural: UPGValidationError[]
    content: UPGValidationError[]
  } {
    // Envelope / document-root paths. These are the fields the canonical `$upg`
    // block supplies; their absence means the file is not a UPG document.
    const STRUCTURAL_ROOT_PATHS = new Set<string>([
      '$',
      '$.upg_version',
      '$.exported_at',
      '$.source',
      '$.source.tool',
      '$.product',
      '$.product.id',
      '$.product.title',
      '$.nodes', // not-an-array (the container is malformed, not a node)
      '$.edges', // not-an-array (the container is malformed, not an edge)
    ])
    const structural: UPGValidationError[] = []
    const content: UPGValidationError[] = []
    for (const e of errors) {
      if (STRUCTURAL_ROOT_PATHS.has(e.path)) structural.push(e)
      else content.push(e)
    }
    return { structural, content }
  }

  /**
   *(a): pre-`normalizeDocument` array-shape guard.
   *
   * `normalizeDocument` runs `(raw.nodes ?? []).map(...)` / reads `raw.edges`
   * BEFORE the validator gets to run, so a `.upg` whose `nodes` or `edges` is
   * present but not an Array (a string, a number, an object) throws a raw
   * `(intermediate value).map is not a function` TypeError that leaks to the
   * user as an opaque exit-1 crash with no actionable message. The `?? []`
   * coalesce only catches null/undefined, never a wrong-typed value.
   *
   * A malformed CONTAINER is a HARD structural problem — there is no graph to
   * load — so we throw the SAME "Invalid UPG document" error shape the
   * structural-failure branch of `load()` already produces, with the SAME
   * message the validator uses for `$.nodes` / `$.edges`
   * ("... is required and must be an array"). This is intentionally NOT the
   * permissive path: per-node / per-edge content issues are handled downstream
   * and still load-with-warning. `null`/`undefined` (or absent) are left to the
   * normaliser's `?? []` and the validator's own required-field check, so this
   * guard fires ONLY on a present-but-wrong-typed container.
   */
  private assertArrayShaped(json: unknown): void {
    if (json === null || typeof json !== 'object' || Array.isArray(json)) {
      // Not an object at all (e.g. a bare JSON array/string/number). Let the
      // normaliser/validator surface this the way they already do; the array
      // container is not the relevant failure here.
      return
    }
    const obj = json as Record<string, unknown>
    const offenders: UPGValidationError[] = []
    for (const key of ['nodes', 'edges'] as const) {
      const value = obj[key]
      // null / undefined are NOT structural here: the normaliser's `?? []`
      // tolerates them and the validator reports the proper required-field
      // error. We only reject a PRESENT, non-array container.
      if (value !== undefined && value !== null && !Array.isArray(value)) {
        offenders.push({
          path: `$.${key}`,
          message: `${key} is required and must be an array`,
        })
      }
    }
    if (offenders.length > 0) {
      const msgs = offenders.map((e) => `  ${e.path}: ${e.message}`).join('\n')
      throw new Error(`Invalid UPG document:\n${msgs}`)
    }
  }

  async load(filePath: string): Promise<void> {
    return this.loadInternal(filePath, { watch: true })
  }

  /**
   * Read-only load: parse + normalise + validate + index a `.upg` file WITHOUT
   * starting a file watcher or taking any lock. The portfolio read layer
   * (`portfolio_query` / `portfolio_digest`) uses this to pull non-active
   * products into transient stores, read them through the same getters as the
   * active store, then discard — no watcher leak, no effect on the active
   * product. Never call `save()` / `flush()` on a read-only-loaded store.
   */
  async loadReadOnly(filePath: string): Promise<void> {
    return this.loadInternal(filePath, { watch: false })
  }

  private async loadInternal(filePath: string, opts: { watch: boolean }): Promise<void> {
    this.filePath = path.resolve(filePath)
    const raw = await fs.readFile(this.filePath, 'utf-8')
    //(b): strip a single leading UTF-8 BOM (U+FEFF) before parsing.
    // Editors (Notepad, some PowerShell redirects) prepend a BOM that survives a
    // `utf-8` read as a leading `﻿`; `JSON.parse` then rejects an otherwise
    // valid `.upg` with "Unexpected token" → the user saw "Not a valid .upg
    // file". The identical bytes load once the BOM is removed. We strip ONLY a
    // single leading BOM and touch nothing else.
    const rawNoBom = raw.charCodeAt(0) === 0xfeff ? raw.slice(1) : raw

    // JSON.parse throwing here is a HARD failure on purpose: a non-JSON file is
    // not a UPG document. We let it propagate (the caller's `catch` already
    // surfaces it the same way it did before).
    const json = JSON.parse(rawNoBom)

    //(a): array-shape guard BEFORE normalizeDocument. The shared
    // normaliser does `(raw.nodes ?? []).map(...)` / `(raw.edges ?? [])`, so a
    // `.upg` whose `nodes`/`edges` is present but NOT an array (a string, an
    // object) throws a raw `(...).map is not a function` TypeError that leaks to
    // the user as an opaque crash. A non-array container is a HARD structural
    // problem (the same class the validator flags as `$.nodes`/`$.edges`
    // "is required and must be an array"), so we throw the project's standard
    // "Invalid UPG document" error here, before any `.map`. Wave-1 permissive
    // load is unchanged: this only catches the malformed CONTAINER; per-node /
    // per-edge content issues still load-with-warning downstream.
    this.assertArrayShaped(json)

    // normalizeDocument accepts BOTH the canonical `$upg` envelope and the
    // legacy flat envelope, returning the flat in-memory shape (and repairing
    // double-encoded properties/tags drift). This is the one read path.
    const parsed = normalizeDocument(json)

    const result = validateUPGDocument(parsed)
    let contentValidationErrors: UPGValidationError[] = []
    if (!result.valid) {
      const { structural, content } = this.classifyValidationErrors(result.errors)

      // ── HARD failure: structural / missing-envelope. Still throw. ──────────
      // This is the "not a UPG file at all" path: missing `$upg` envelope, a
      // malformed root, or `nodes`/`edges` that aren't arrays. Bricking the
      // read is correct here; there is nothing to load and nothing to repair.
      if (structural.length > 0) {
        const msgs = structural
          .map((e) => `  ${e.path}: ${e.message}`)
          .join('\n')
        // (S-12): the validator reports the envelope-internal path (e.g.
        // `$.exported_at`), but in the on-disk canonical envelope that field
        // lives at `$upg.provenance.exported_at`. A hand-authored `{ product,
        // nodes, edges }` is missing the whole `$upg` block. Point there.
        const missingEnvelope = structural.some((e) => /exported_at|provenance|\$upg|format_version/.test(`${e.path} ${e.message}`))
        const hint = missingEnvelope
          ? `\n\nThe \`$upg\` provenance envelope is required (real field path: ` +
            `\`$upg.provenance.exported_at\`). Don't hand-author a bare ` +
            `{ product, nodes, edges } file — scaffold via the CLI (\`upg init\`) ` +
            `or clone an existing \`.upg\` file's \`$upg\` block.`
          : ''
        throw new Error(`Invalid UPG document:\n${msgs}${hint}`)
      }

      // ── PERMISSIVE: content-validity only. Load anyway, warn, record. ──────
      //: mirrors the product.stage soft-coercion below — we warn to
      // stderr and load the graph so reads and the delete/update that repairs
      // the file keep working. The errors are recorded on the integrity report
      // (see verifyIntegrity) for the operator/agent. Strict validation stays
      // on the WRITE/flush path, so writers never persist NEW invalid state;
      // only the LOAD boundary is permissive. This is what lets Spock's
      // stricter property/enum checks surface as warnings, not new bricks.
      contentValidationErrors = content
      const msgs = content
        .map((e) => `  ${e.path}: ${e.message}`)
        .join('\n')
      process.stderr.write(
        `[upg-load] ${content.length} content-validity ` +
          `${content.length === 1 ? 'issue' : 'issues'} in an otherwise well-formed UPG document. ` +
          `Loaded anyway (reads and repair stay available); writes remain strict so no new ` +
          `invalid state is persisted. Run \`upg verify\` / \`validate_graph\` for the full report, ` +
          `then update/delete the offending entities to repair.\n${msgs}\n` +
          `File: ${this.filePath}\n`,
      )
    }

    this.doc = parsed as UPGDocument

    // Soft-coerce non-canonical product.stage values in-memory so
    // existing graphs (e.g. ones with `stage: "idea"` or `"discovery"`)
    // keep loading. Strict validation happens on the WRITE path
    // (`create_product` / future `update_product`); reads stay permissive.
    // The on-disk file is NOT mutated here; the canonical value is used
    // only for in-memory consumers (digest, lifecycle benchmarks, copy
    // surfaces). To persist the migration, run `migrate_properties` /
    // operator equivalent. Mirrors the v0.2.13 properties.stage → status
    // lift but applied at the load boundary so production graphs work
    // without forcing an explicit migration sweep.
    if (this.doc.product?.stage !== undefined) {
      const coercion = coerceProductStage(this.doc.product.stage)
      if (coercion.wasCoerced && coercion.canonical) {
        process.stderr.write(
          `[product-stage] Product stage ${JSON.stringify(coercion.originalValue)} is not a canonical UPGProductStage. ` +
            `Coerced in-memory to ${JSON.stringify(coercion.canonical)}. ` +
            `Run \`migrate_properties\` (or update the file) to persist the canonical value. ` +
            `File: ${this.filePath}\n`,
        )
        // Mutate the in-memory shape only; leaves the on-disk JSON
        // unchanged so the original value survives until explicit migration.
        this.doc = {
          ...this.doc,
          product: { ...this.doc.product, stage: coercion.canonical },
        }
      } else if (coercion.wasUnknown) {
        process.stderr.write(
          `[product-stage] Product stage ${JSON.stringify(coercion.originalValue)} is not a canonical UPGProductStage and has no documented coercion target. ` +
            `Treating as missing in lifecycle calculations. ` +
            `Set a canonical value via \`update_node\` to clear this warning. ` +
            `File: ${this.filePath}\n`,
        )
      }
    }

    // Verify integrity: detect external modifications and quarantine invalid entities
    this.lastIntegrityReport = this.verifyIntegrity()
    //: surface the LOAD-time content-validity errors on the same report
    // so consumers (CLI `verify`, MCP integrity surface, client.verify()) see a
    // permissively-loaded-but-invalid graph as NOT-ok without the load throwing.
    if (contentValidationErrors.length > 0) {
      this.lastIntegrityReport.contentValidationErrors = contentValidationErrors
    }

    this.rebuildIndexes()
    this.computeHash()
    this.baselineFileHash = this.hashRawContent(raw)
    this.snapshotBaseline()

    // Classify any dangling edges and surface a structured report on
    // stderr instead of the bare "n dangling edges" line. We do NOT auto-drop
    // the agent or operator runs `repair_dangling_edges` for that.
    this.lastDanglingReport = classifyDanglingEdges(
      this.doc.edges,
      new Set(this.doc.nodes.map((n) => n.id)),
    )
    const rendered = renderDanglingReport(this.lastDanglingReport, this.filePath, { quietWhenClean: true })
    if (rendered) process.stderr.write(rendered + '\n')

    // Schema-drift summary on load. Counts only; full per-node
    // breakdown lives in `validate_graph`. Silent when zero drift.
    this.lastDriftSummary = computeSchemaDriftSummary(this.doc)
    const driftRendered = renderDriftSummary(this.lastDriftSummary, this.filePath, { quietWhenClean: true })
    if (driftRendered) process.stderr.write(driftRendered + '\n')

    if (opts.watch) {
      await this.startWatching()
    }
  }

  /**
   * Snapshot of the dangling-edge classification computed at load time.
   * Returns null until `load()` has run.
   */
  getDanglingReport(): DanglingEdgeReport | null {
    return this.lastDanglingReport
  }

  /**
   * Snapshot of the schema-drift summary computed at load time.
   * Counts only; full per-node breakdown is `validate_graph`.
   * Returns null until `load()` has run.
   */
  getDriftSummary(): SchemaDriftSummary | null {
    return this.lastDriftSummary
  }

  /**
   * Drop edges matching the given dangling classes from the document. Used by
   * the `repair_dangling_edges` tool with `dry_run: false`. Caller is
   * responsible for choosing classes; this method does not protect
   * `expected` cross-product edges by default; pass an empty array to no-op.
   */
  dropDanglingEdges(classes: ReadonlyArray<DanglingEdgeClass>): { dropped: number; remaining: DanglingEdgeReport } {
    if (classes.length === 0) {
      return { dropped: 0, remaining: this.lastDanglingReport ?? { total: 0, by_class: { expected: 0, suspect: 0, corrupt: 0 }, edges: [] } }
    }
    const report = classifyDanglingEdges(
      this.doc.edges,
      new Set(this.doc.nodes.map((n) => n.id)),
    )
    const targetClasses = new Set(classes)
    const dropIds = new Set(
      report.edges.filter((e) => targetClasses.has(e.class)).map((e) => e.id),
    )
    if (dropIds.size === 0) {
      return { dropped: 0, remaining: report }
    }

    this.doc.edges = this.doc.edges.filter((e) => !dropIds.has(e.id))
    this.rebuildIndexes()
    this.dirty = true
    this.computeHash()

    this.lastDanglingReport = classifyDanglingEdges(
      this.doc.edges,
      new Set(this.doc.nodes.map((n) => n.id)),
    )
    return { dropped: dropIds.size, remaining: this.lastDanglingReport }
  }

  async save(): Promise<void> {
    if (!this.dirty) return

    // ──: serialize the WHOLE read-modify-write window ──────────────
    // The lost-update race lives between the disk re-read (Layer 1) and the
    // atomic rename: two writers each read the same baseline, each merge in
    // their own change, then the second rename clobbers the first writer's
    // append. Holding the advisory lock across the entire critical section
    // means a second writer either (a) waits until we release, then re-reads
    // OUR just-written file as its disk baseline and three-way-merges its
    // change on top, or (b) reclaims a stale lock from a crashed holder. Either
    // way every writer's update is preserved. The lock is keyed on the resolved
    // `.upg` path, so cross-process writers (separate `upg create` invocations)
    // contend for the same token.
    const release = await this.acquireWriteLock()
    try {
      // Re-check dirty inside the lock: a queued writer that was waiting may
      // have had its work folded in by a watcher-driven merge while it blocked.
      if (!this.dirty) return
      await this.saveLocked()
    } finally {
      await release().catch(() => {})
    }
  }

  /**
   * The actual read-modify-write + atomic rename. MUST run under the advisory
   * lock held by `save()`; never call directly. Split out so the lock
   * acquire/release lives in one place and the existing merge/conflict logic is
   * unchanged inside the critical section.
   */
  private async saveLocked(): Promise<void> {
    // ── Layer 1: Read-before-write dirty check ────────────────────────────
    // Re-read the file from disk and check if another process modified it
    // since we last loaded or saved.
    let diskRaw: string
    try {
      diskRaw = await fs.readFile(this.filePath, 'utf-8')
    } catch {
      // File doesn't exist (deleted externally?); safe to write
      diskRaw = ''
    }

    const diskHash = diskRaw ? this.hashRawContent(diskRaw) : ''

    if (diskHash && diskHash !== this.baselineFileHash) {
      // ── Layer 2: Another process modified the file; attempt merge ───────
      this.lastMergeResult = await this.mergeWithDisk(diskRaw)

      if (this.lastMergeResult.conflicts.length > 0) {
        // True conflicts: same node modified differently by both sessions.
        // Refuse to write. The agent must handle this.
        const conflictDesc = this.lastMergeResult.conflicts
          .map((c) => `  Node ${c.nodeId}: field "${c.field}": ours: ${JSON.stringify(c.ours)}, theirs: ${JSON.stringify(c.theirs)}`)
          .join('\n')
        throw new Error(
          `CONFLICT: The .upg file was modified by another session.\n` +
          `  Nodes added by other session: ${this.lastMergeResult.nodesFromDisk}\n` +
          `  Edges added by other session: ${this.lastMergeResult.edgesFromDisk}\n` +
          `  Conflicts (same node modified differently):\n${conflictDesc}\n\n` +
          `Auto-merge failed. Run the save again after resolving conflicts, or reload the file.`
        )
      }

      // No conflicts; merge succeeded. Rebuild indexes for the merged doc.
      this.rebuildIndexes()
    }

    // ── Write to disk ─────────────────────────────────────────────────────
    this.doc.exported_at = new Date().toISOString()
    // Stamp the LAST writer's identity ( / M7). Each entry point
    // (CLI, MCP server) declares who it is via setWriter(); without that we
    // keep the prior behaviour of defaulting only a missing tool. This is why a
    // file written by the CLI then by the MCP server now correctly reads
    // tool/tool_version of whoever wrote it last, instead of freezing the first.
    if (this.writer) {
      this.doc.source = {
        ...this.doc.source,
        tool: this.writer.tool,
        ...(this.writer.tool_version !== undefined
          ? { tool_version: this.writer.tool_version }
          : {}),
      }
    } else if (!this.doc.source.tool) {
      this.doc.source.tool = 'upg-mcp-local'
    }

    // Stamp integrity checksum before serializing (in-memory tamper baseline).
    this.stampIntegrity()

    // Canonical serialisation: one shared serialiser, so the file is
    // byte-identical regardless of which tool wrote it. Uses the doc's
    // exported_at + source set just above. Always ends with a trailing newline.
    const output = serializeCanonical(this.doc)
    const tmpPath = this.filePath + '.tmp'

    // Atomic write + rename. The watcher recognises this as our own write by
    // comparing the file hash to baselineFileHash (set below), so no timing
    // flag is needed. The baseline is updated synchronously after the rename
    // and before the watcher's async 'change' callback can run, so the watcher
    // always sees the up-to-date baseline.
    await fs.writeFile(tmpPath, output, 'utf-8')
    await fs.rename(tmpPath, this.filePath)
    this.dirty = false
    this.computeHash()
    this.baselineFileHash = this.hashRawContent(output)
    this.snapshotBaseline()
  }

  // ── Three-Way Merge ───────────────────────────────────────────────────────
  //
  // Three states:
  //   baseline = what was on disk when we loaded (or last saved)
  //   disk     = what's on disk now (another session wrote this)
  //   ours     = our in-memory state
  //
  // Strategy:
  //   - Nodes/edges in disk but not in baseline → added by other session → keep
  //   - Nodes/edges in ours but not in baseline → added by this session → keep
  //   - Nodes/edges in baseline but not in disk → deleted by other session → accept deletion
  //   - Nodes/edges in baseline but not in ours → deleted by this session → accept deletion
  //   - Nodes in both disk and ours with different content → CONFLICT
  //
  private async mergeWithDisk(diskRaw: string): Promise<MergeResult> {
    let diskDoc: UPGDocument
    try {
      const parsed = normalizeDocument(JSON.parse(diskRaw))
      if (!validateUPGDocument(parsed).valid) {
        // Disk has invalid JSON; can't merge, our version wins
        return { merged: true, nodesAdded: 0, edgesAdded: 0, nodesFromDisk: 0, edgesFromDisk: 0, conflicts: [] }
      }
      diskDoc = parsed as UPGDocument
    } catch {
      return { merged: true, nodesAdded: 0, edgesAdded: 0, nodesFromDisk: 0, edgesFromDisk: 0, conflicts: [] }
    }

    const diskNodeMap = new Map(diskDoc.nodes.map((n) => [n.id, n]))
    const diskEdgeMap = new Map(diskDoc.edges.map((e) => [e.id, e]))
    const ourNodeMap = this.nodeMap
    const ourEdgeMap = this.edgeMap

    const conflicts: MergeResult['conflicts'] = []
    let nodesFromDisk = 0
    let edgesFromDisk = 0

    // Find nodes added by the other session (in disk, not in baseline)
    for (const [id, diskNode] of diskNodeMap) {
      if (!this.baselineNodeIds.has(id)) {
        // New node from disk; add to our doc if we don't already have it
        if (!ourNodeMap.has(id)) {
          this.doc.nodes.push(diskNode)
          nodesFromDisk++
        }
      } else if (ourNodeMap.has(id)) {
        // Node exists in all three states; check for conflicting modifications
        const ourNode = ourNodeMap.get(id)!
        // Only flag conflict if BOTH sessions modified it (neither matches baseline)
        // We compare title and status as the most likely conflict fields
        const ourModified = ourNode.title !== diskNode.title || ourNode.status !== diskNode.status
        if (ourModified) {
          // Check if disk version is different from ours
          if (ourNode.title !== diskNode.title) {
            conflicts.push({ nodeId: id, field: 'title', ours: ourNode.title, theirs: diskNode.title })
          }
          if (ourNode.status !== diskNode.status) {
            conflicts.push({ nodeId: id, field: 'status', ours: ourNode.status, theirs: diskNode.status })
          }
        }
      }
    }

    // Find edges added by the other session
    for (const [id, diskEdge] of diskEdgeMap) {
      if (!this.baselineEdgeIds.has(id)) {
        if (!ourEdgeMap.has(id)) {
          // Verify both endpoints exist in our merged node set before adding
          const sourceExists = ourNodeMap.has(diskEdge.source) || diskNodeMap.has(diskEdge.source)
          const targetExists = ourNodeMap.has(diskEdge.target) || diskNodeMap.has(diskEdge.target)
          if (sourceExists && targetExists) {
            this.doc.edges.push(diskEdge)
            edgesFromDisk++
          }
        }
      }
    }

    // Accept deletions by the other session:
    // Nodes in our baseline that are NOT on disk → other session deleted them
    for (const id of this.baselineNodeIds) {
      if (!diskNodeMap.has(id) && ourNodeMap.has(id)) {
        // Only accept deletion if WE didn't modify the node
        const ourNode = ourNodeMap.get(id)!
        // Simple heuristic: if we have changes logged for this node, keep ours
        const weModified = this.changeLog.some(
          (c) => c.id === id && c.entity === 'node' && c.action === 'update',
        )
        if (!weModified) {
          this.doc.nodes = this.doc.nodes.filter((n) => n.id !== id)
          // Also remove edges connected to this node
          this.doc.edges = this.doc.edges.filter(
            (e) => e.source !== id && e.target !== id,
          )
        }
      }
    }

    return {
      merged: conflicts.length === 0,
      nodesAdded: nodesFromDisk,
      edgesAdded: edgesFromDisk,
      nodesFromDisk,
      edgesFromDisk,
      conflicts,
    }
  }

  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    await this.save()
  }

  /**
   * Mark the store as dirty so the next `flush()` or `save()` writes to disk.
   * Use this when an external caller mutates the document object directly (e.g.
   * the cross-edge migration which modifies `doc.edges` in-place via
   * `UPGPortfolioStore.migrateCrossEdgesFromDoc`).
   */
  markDirty(): void {
    this.dirty = true
  }

  private scheduleSave(): void {
    this.dirty = true
    if (this.saveTimer) clearTimeout(this.saveTimer)
    // Fire-and-forget debounced save: own its errors. On failure the store
    // stays dirty (save() only clears dirty after a successful write), so the
    // next mutation/flush retries; swallowing here keeps a transient FS error
    // (e.g. the dir was removed under us) from becoming an unhandled rejection.
    this.saveTimer = setTimeout(() => void this.save().catch(() => {}), 300)
  }

  // ── File Watching ────────────────────────────────────────────────────────

  private async startWatching(): Promise<void> {
    if (this.watcher) return
    // Lazy-load chokidar so the pure `@unified-product-graph/sdk/logic`
    // entry never pulls file-watching into consumers that don't read files
    // (e.g. the Postgres-backed cloud server).
    const { watch } = await import('chokidar')
    this.watcher = watch(this.filePath, {
      persistent: false,
      awaitWriteFinish: { stabilityThreshold: 200, pollInterval: 50 },
    })
    this.watcher.on('change', async () => {
      try {
        const raw = await fs.readFile(this.filePath, 'utf-8')
        // Ignore our OWN writes. A timing flag is unreliable here: chokidar's
        // awaitWriteFinish delays the change event past any fixed self-write
        // window, so the event for our own save arrives looking external. Instead
        // compare the file to what we last wrote/loaded (baselineFileHash): if it
        // matches, this is not an external change. Timing-independent.
        if (this.hashRawContent(raw) === this.baselineFileHash) return
        const parsed = JSON.parse(raw)
        if (!validateUPGDocument(parsed).valid) return

        if (this.dirty) {
          // We have unsaved changes AND the file changed externally.
          // Attempt to merge instead of silently discarding our work.
          const result = await this.mergeWithDisk(raw)
          this.lastMergeResult = result
          if (result.conflicts.length === 0 && (result.nodesFromDisk > 0 || result.edgesFromDisk > 0)) {
            // Merge succeeded; rebuild indexes, keep our dirty flag so we save the merged state
            this.rebuildIndexes()
            this.computeHash()
            this.baselineFileHash = this.hashRawContent(raw)
            // Don't clear dirty; we still need to save our changes + the merged entities
          }
          // If conflicts, keep our state as-is; the next save() will detect and report
        } else {
          // No unsaved changes; safe to reload from disk
          this.doc = parsed as UPGDocument
          this.rebuildIndexes()
          this.computeHash()
          this.baselineFileHash = this.hashRawContent(raw)
          this.snapshotBaseline()
          this.dirty = false
        }
      } catch {
        // External write produced invalid JSON; ignore, keep current state
      }
    })
  }

  stopWatching(): void {
    this.watcher?.close()
    this.watcher = null
  }

  // ── Index Management ─────────────────────────────────────────────────────

  private rebuildIndexes(): void {
    this.nodeMap.clear()
    this.edgeMap.clear()
    this.edgesByNode.clear()

    for (const node of this.doc.nodes) {
      this.nodeMap.set(node.id, node)
    }
    for (const edge of this.doc.edges) {
      this.edgeMap.set(edge.id, edge)
      this.indexEdgeForNode(edge)
    }
  }

  private indexEdgeForNode(edge: UPGEdge): void {
    for (const nodeId of [edge.source, edge.target]) {
      let set = this.edgesByNode.get(nodeId)
      if (!set) {
        set = new Set()
        this.edgesByNode.set(nodeId, set)
      }
      set.add(edge.id)
    }
  }

  private unindexEdgeForNode(edge: UPGEdge): void {
    this.edgesByNode.get(edge.source)?.delete(edge.id)
    this.edgesByNode.get(edge.target)?.delete(edge.id)
  }

  // ── Hash ─────────────────────────────────────────────────────────────────

  private computeHash(): void {
    const content = JSON.stringify({
      nodes: this.doc.nodes.length,
      edges: this.doc.edges.length,
      nodeIds: this.doc.nodes.map((n) => n.id).sort(),
      edgeIds: this.doc.edges.map((e) => e.id).sort(),
      lastMod: this.doc.exported_at,
    })
    this.contentHash = createHash('sha256').update(content).digest('hex').slice(0, 16)
  }

  getContentHash(): string {
    return this.contentHash
  }

  // ── Reads ────────────────────────────────────────────────────────────────

  getFilePath(): string {
    return this.filePath
  }

  getDocument(): UPGDocument {
    return this.doc
  }

  getProduct() {
    return this.doc.product
  }

  /**
   * The graph's workspace member kind (spec #44/#45): `product` (default),
   * `org_rollup` (company umbrella), or `watched` (monitored intelligence
   * graph). Read from the in-memory doc, where `normalizeDocument` lifts
   * `$upg.member_kind` to a top-level field (absent = product).
   */
  getMemberKind(): 'product' | 'org_rollup' | 'watched' {
    const k = (this.doc as { member_kind?: string }).member_kind
    return k === 'org_rollup' || k === 'watched' ? k : 'product'
  }

  /**
   * Set the workspace member kind and mark dirty; the canonical serializer
   * stamps `$upg.member_kind` and reseals `$upg.integrity` on flush. Setting
   * `product` clears the field (the absent default), so a watched / org_rollup
   * graph can be re-kinded back to a product. No-op (and not dirtied) when the
   * value is unchanged. (spec #44, UPG 0.10.1)
   */
  setMemberKind(kind: 'product' | 'org_rollup' | 'watched'): void {
    const doc = this.doc as { member_kind?: string }
    const current = doc.member_kind === 'org_rollup' || doc.member_kind === 'watched' ? doc.member_kind : 'product'
    if (current === kind) return
    if (kind === 'product') delete doc.member_kind
    else doc.member_kind = kind
    this.markDirty()
  }

  /**
   * Declare the tool writing through this store ( / M7). Its `tool` and
   * `tool_version` are stamped into `source` (provenance) on every flush, so the
   * file records its LAST writer. Call once after construction/load from each
   * entry point (CLI: `upg-cli` + its version; MCP: `upg-mcp-server` + its
   * version). When unset, the prior behaviour (default a missing tool only) is
   * preserved.
   */
  setWriter(tool: string, tool_version?: string): void {
    this.writer = { tool, tool_version }
  }

  getNode(id: string): UPGBaseNode | undefined {
    return this.nodeMap.get(id)
  }

  getEdge(id: string): UPGEdge | undefined {
    return this.edgeMap.get(id)
  }

  getAllNodes(): UPGBaseNode[] {
    return this.doc.nodes
  }

  getAllEdges(): UPGEdge[] {
    return this.doc.edges
  }

  getEdgesForNode(nodeId: string): UPGEdge[] {
    const edgeIds = this.edgesByNode.get(nodeId)
    if (!edgeIds) return []
    return [...edgeIds]
      .map((id) => this.edgeMap.get(id)!)
      .filter(Boolean)
  }

  // ── Change Log ──────────────────────────────────────────────────────────

  private logChange(
    action: ChangeEntry['action'],
    entity: ChangeEntry['entity'],
    id: string,
    type: string,
    title?: string,
  ): void {
    this.changeLog.push({
      action,
      entity,
      id,
      type,
      title,
      timestamp: new Date().toISOString(),
    })
  }

  getChanges(since?: string): ChangeEntry[] {
    if (!since) return [...this.changeLog]
    return this.changeLog.filter((c) => c.timestamp >= since)
  }

  // ── Writes ───────────────────────────────────────────────────────────────

  addNode(node: UPGBaseNode): void {
    this.doc.nodes.push(node)
    this.nodeMap.set(node.id, node)
    this.logChange('create', 'node', node.id, node.type, node.title)
    this.scheduleSave()
  }

  updateNode(id: string, patch: Partial<UPGBaseNode>): UPGBaseNode {
    const node = this.nodeMap.get(id)
    if (!node) throw new Error(`Node not found: ${id}`)

    // Shallow merge top-level fields
    if (patch.type !== undefined) node.type = patch.type as UPGEntityType
    if (patch.title !== undefined) node.title = patch.title
    if (patch.description !== undefined) node.description = patch.description
    if (patch.tags !== undefined) node.tags = patch.tags
    if (patch.status !== undefined) node.status = patch.status

    // Slug change → rotate the old slug into aliases[]. Aliases
    // patched directly by the caller win; they replace the field outright.
    if (patch.slug !== undefined && patch.slug !== node.slug) {
      rotateSlug(node, patch.slug)
    }
    if (patch.aliases !== undefined) node.aliases = patch.aliases

    // Deep merge properties
    if (patch.properties) {
      node.properties = { ...(node.properties ?? {}), ...patch.properties }
    }

    this.logChange('update', 'node', node.id, node.type, node.title)
    this.scheduleSave()
    return node
  }

  /**
   * Remove one or more property keys from a node.
   *
   * `update_node` deep-MERGES `properties`, so writing `{ key: null }` stores a
   * literal `null` rather than removing the key — a trap, given writes are
   * permissive about unknown keys. This is the matching permissive-UNSET: it
   * deletes the named keys outright. Unknown keys are ignored (idempotent).
   * Returns the keys that were actually deleted.
   */
  unsetNodeProperties(id: string, keys: string[]): { node: UPGBaseNode; removed: string[] } {
    const node = this.nodeMap.get(id)
    if (!node) throw new Error(`Node not found: ${id}`)
    const removed: string[] = []
    if (node.properties) {
      for (const key of keys) {
        if (Object.prototype.hasOwnProperty.call(node.properties, key)) {
          delete node.properties[key]
          removed.push(key)
        }
      }
    }
    if (removed.length > 0) {
      this.logChange('update', 'node', node.id, node.type, node.title)
      this.scheduleSave()
    }
    return { node, removed }
  }

  removeNode(id: string): { node: UPGBaseNode; removedEdgeIds: string[] } {
    const node = this.nodeMap.get(id)
    if (!node) throw new Error(`Node not found: ${id}`)

    // Copy edge IDs before mutation; unindexEdgeForNode modifies the source Set
    const edgeIds = new Set(this.edgesByNode.get(id) ?? [])
    const removedEdgeIds: string[] = []
    for (const edgeId of edgeIds) {
      const edge = this.edgeMap.get(edgeId)
      if (edge) {
        this.unindexEdgeForNode(edge)
        this.edgeMap.delete(edgeId)
        removedEdgeIds.push(edgeId)
      }
    }
    this.doc.edges = this.doc.edges.filter((e) => !edgeIds.has(e.id))
    this.edgesByNode.delete(id)

    // Remove the node
    this.doc.nodes = this.doc.nodes.filter((n) => n.id !== id)
    this.nodeMap.delete(id)

    this.logChange('delete', 'node', node.id, node.type, node.title)
    for (const eid of removedEdgeIds) {
      this.logChange('delete', 'edge', eid, 'cascade', undefined)
    }
    this.scheduleSave()
    return { node, removedEdgeIds }
  }

  /**
   * Add an edge to the graph.
   *
   *: idempotent on the `(source, target, type)` triple. `upg connect P J`
   * run three times used to append three identical `persona_pursues_job` edges;
   * the same duplicate showed up on the MCP `create_edge` / `batch_create_edges`
   * surface. Adding the dedup here, at the single store-level chokepoint every
   * edge-create flows through, fixes BOTH surfaces at once. When an edge with the
   * same source, target, and type already exists, we return the EXISTING edge
   * unchanged (no append, no second `create` change-log entry, no extra save)
   * instead of throwing — connect stays a safe, repeatable no-op.
   *
   * The returned edge is always the canonical one (existing on a dedup hit, the
   * freshly-added one otherwise). Callers that mint a fresh id up-front (e.g.
   * `createEdge`) MUST use this return value so the id they report back is the
   * one that actually lives in the graph, not the discarded fresh id.
   *
   * Dedup is deliberately scoped to the VALIDATED path (`skipValidation` false).
   * `skipValidation: true` is the internal restore/rollback channel — it re-adds
   * a specific edge object by its exact id after a `removeEdge`, and must remain
   * a faithful, un-deduped restore of that exact edge.
   */
  addEdge(edge: UPGEdge, skipValidation = false): UPGEdge {
    if (!skipValidation) {
      if (!this.nodeMap.has(edge.source))
        throw new Error(`Source node not found: ${edge.source}`)
      if (!this.nodeMap.has(edge.target))
        throw new Error(`Target node not found: ${edge.target}`)

      //: collapse an identical (source, target, type) re-create onto the
      // existing edge. Returns it truthfully so callers' reported id is real.
      const existing = this.findEdgeByTriple(edge.source, edge.target, edge.type)
      if (existing) return existing
    }

    this.doc.edges.push(edge)
    this.edgeMap.set(edge.id, edge)
    this.indexEdgeForNode(edge)
    this.logChange('create', 'edge', edge.id, edge.type, undefined)
    this.scheduleSave()
    return edge
  }

  /**
   *: find an existing edge with the given (source, target, type) triple,
   * or undefined. Uses the `edgesByNode` index off the source node so the scan is
   * bounded by that node's degree, not the whole edge list.
   */
  private findEdgeByTriple(
    source: string,
    target: string,
    type: string,
  ): UPGEdge | undefined {
    const edgeIds = this.edgesByNode.get(source)
    if (!edgeIds) return undefined
    for (const id of edgeIds) {
      const e = this.edgeMap.get(id)
      if (e && e.source === source && e.target === target && e.type === type) return e
    }
    return undefined
  }

  removeEdge(id: string): UPGEdge {
    const edge = this.edgeMap.get(id)
    if (!edge) throw new Error(`Edge not found: ${id}`)

    this.unindexEdgeForNode(edge)
    this.edgeMap.delete(id)
    this.doc.edges = this.doc.edges.filter((e) => e.id !== id)

    this.logChange('delete', 'edge', edge.id, edge.type, undefined)
    this.scheduleSave()
    return edge
  }

  /**
   * Set (or merge) properties on an existing edge — the persistence path for a
   * framework exercise's per-entity result on its `includes` edge. The gate
   * (only `carries_properties` edge types may hold a payload) is enforced by the
   * `createEdge` / `scoreEntity` callers; this is the low-level mutation.
   *
   * With `merge: true` (default) the patch is shallow-merged over existing
   * properties; a key whose value is `null`/`undefined` is removed. When the
   * resulting object is empty the `properties` field is dropped entirely (keeps
   * the canonical form clean). The edge object is shared between `edgeMap` and
   * `doc.edges`, so the mutation lands in both.
   */
  setEdgeProperties(
    id: string,
    properties: Record<string, unknown>,
    opts: { merge?: boolean } = {},
  ): UPGEdge {
    const edge = this.edgeMap.get(id)
    if (!edge) throw new Error(`Edge not found: ${id}`)
    const merge = opts.merge ?? true
    const next: Record<string, unknown> = merge ? { ...(edge.properties ?? {}) } : {}
    for (const [k, v] of Object.entries(properties)) {
      if (v === null || v === undefined) delete next[k]
      else next[k] = v
    }
    if (Object.keys(next).length > 0) edge.properties = next
    else delete edge.properties
    this.logChange('update', 'edge', edge.id, edge.type, undefined)
    this.scheduleSave()
    return edge
  }

  migrateType(
    fromType: string,
    toType: string,
    defaults?: Record<string, unknown>,
  ): {
    migratedNodes: number
    edgeRenames: Array<{ id: string; from: string; to: string; flipped: boolean }>
    edgeDrops: Array<{ id: string; from: string }>
  } {
    let migratedNodes = 0

    // Migrate nodes first; endpoint guards in UPG_EDGE_MIGRATIONS check
    // post-migration node types per the runtime migration contract.
    for (const node of this.doc.nodes) {
      if (node.type === fromType) {
        node.type = toType as UPGEntityType
        // Merge defaults; existing values take precedence
        if (defaults && Object.keys(defaults).length > 0) {
          node.properties = { ...defaults, ...(node.properties ?? {}) }
        }
        migratedNodes++
      }
    }

    // Edge migration: catalog-aware via UPG_EDGE_MIGRATIONS,
    // replacing the legacy substring substitution. Renames retarget edges,
    // drops remove them, flips swap source/target. Edges whose type has no
    // corresponding rule are left alone; caller can detect unmapped legacy
    // keys by comparing edge types against UPG_EDGE_CATALOG keys post-call.
    const edgeResult = this.applyEdgeMigrations('0.0.0', UPG_VERSION)

    this.scheduleSave()
    return {
      migratedNodes,
      edgeRenames: edgeResult.renamed,
      edgeDrops: edgeResult.dropped,
    }
  }

  /**
   * Exact-match rename of every edge whose `type === from` to `to`. Optionally
   * flips `source`/`target` for each affected edge. The catalog is intentionally
   * NOT consulted here; this is the low-level primitive backing
   * `rename_edge_type`. Catalog awareness lives in the wrappers
   * tracked separately.
   *
   * Returns the IDs of every edge that was actually mutated. The internal
   * `edgesByNode` index is keyed by node id, so a flip does not require
   * re-indexing; both endpoints are already tracked for the same edge id.
   */
  renameEdgeType(
    from: string,
    to: string,
    flip = false,
  ): { renamed: number; ids: string[] } {
    const ids: string[] = []
    for (const edge of this.doc.edges) {
      if (edge.type !== from) continue
      edge.type = to as UPGEdgeType
      if (flip) {
        const oldSource = edge.source
        edge.source = edge.target
        edge.target = oldSource
      }
      this.logChange('update', 'edge', edge.id, edge.type, undefined)
      ids.push(edge.id)
    }
    if (ids.length > 0) this.scheduleSave()
    return { renamed: ids.length, ids }
  }

  /**
   * Apply every applicable rule from `UPG_EDGE_MIGRATIONS` (the v0.2.4
   * canonical edge registry) to the loaded graph.
   * Renames retarget the edge type; flipped renames swap source/target;
   * dropped edges are removed entirely. Endpoint guards in the migration
   * rules check post-migration node types; so callers should run any
   * needed `migrateType` / `applySplit` pass on nodes BEFORE calling this.
   *
   * Wave 3 of the MCP edge-primitives cascade.
   */
  applyEdgeMigrations(
    fromVersion: string,
    toVersion: string,
  ): {
    renamed: Array<{ id: string; from: string; to: string; flipped: boolean }>
    dropped: Array<{ id: string; from: string }>
  } {
    const renamed: Array<{ id: string; from: string; to: string; flipped: boolean }> = []
    const dropped: Array<{ id: string; from: string }> = []
    // Snapshot edge IDs first; drops mutate the underlying array mid-walk.
    const edgeIds = this.doc.edges.map((e) => e.id)
    for (const id of edgeIds) {
      const edge = this.edgeMap.get(id)
      if (!edge) continue
      const sourceNode = this.nodeMap.get(edge.source)
      const targetNode = this.nodeMap.get(edge.target)
      const result = migrateEdge(edge, fromVersion, toVersion, {
        sourceType: sourceNode?.type,
        targetType: targetNode?.type,
      })
      if (result === null) {
        dropped.push({ id, from: edge.type })
        this.removeEdge(id)
        continue
      }
      if (result === edge) continue
      const oldType = edge.type
      const flipped = result.source !== edge.source
      edge.type = result.type as UPGEdgeType
      if (flipped) {
        edge.source = result.source as string
        edge.target = result.target as string
      }
      this.logChange('update', 'edge', edge.id, edge.type, undefined)
      renamed.push({ id: edge.id, from: oldType, to: edge.type, flipped })
    }
    if (renamed.length > 0 || dropped.length > 0) this.scheduleSave()
    return { renamed, dropped }
  }

  applyPropertyMigrations(
    fromVersion: string,
    toVersion: string,
  ): {
    top_level_renames: Array<{ id: string; from: string; to: string; value_changed: boolean }>
    lifted_properties: Array<{ id: string; from_property: string; to: string; value_changed: boolean }>
    dropped_props: Array<{ id: string; key: string }>
    dropped_self_referential: Array<{ id: string; field: string }>
  } {
    const top_level_renames: Array<{ id: string; from: string; to: string; value_changed: boolean }> = []
    const lifted_properties: Array<{ id: string; from_property: string; to: string; value_changed: boolean }> = []
    const dropped_props: Array<{ id: string; key: string }> = []
    const dropped_self_referential: Array<{ id: string; field: string }> = []
    let mutatedAny = false

    for (let i = 0; i < this.doc.nodes.length; i++) {
      const original = this.doc.nodes[i]
      const { node: migrated, changes } = migrateNodeProperties(
        original as unknown as Record<string, unknown> & { id?: string; type: string; properties?: Record<string, unknown> },
        fromVersion,
        toVersion,
      )
      if (changes.length === 0) continue
      for (const change of changes as UPGPropertyMigrationChange[]) {
        switch (change.kind) {
          case 'dropped': dropped_props.push({ id: original.id, key: change.key }); break
          case 'renamed_top_level': top_level_renames.push({ id: original.id, from: change.from, to: change.to, value_changed: change.value_changed }); break
          case 'lifted_to_top_level': lifted_properties.push({ id: original.id, from_property: change.from_property, to: change.to, value_changed: change.value_changed }); break
          case 'self_ref_dropped': dropped_self_referential.push({ id: original.id, field: change.field }); break
        }
      }
      const migratedNode = migrated as unknown as UPGBaseNode
      this.doc.nodes[i] = migratedNode
      this.nodeMap.set(migratedNode.id, migratedNode)
      this.logChange('update', 'node', migratedNode.id, migratedNode.type, undefined)
      mutatedAny = true
    }

    if (mutatedAny) this.scheduleSave()
    return { top_level_renames, lifted_properties, dropped_props, dropped_self_referential }
  }
}

// ─── UPGPortfolioStore ──────────────────────────────────────────────
//
// Manages a single `.portfolio.upg` file that holds the portfolio document,
// the canonical home for cross-product edges. A portfolio document lives
// alongside product `.upg` files in `.upg/` (e.g. `.upg/portfolio.upg`).
//
// Design choice: sibling class rather than extending UPGFileStore.
// Rationale: portfolio documents have fundamentally different structure
// (multiple products + cross_edges vs single-product nodes/edges). Merging
// the two shapes into one class would require extensive conditional logic.
// A dedicated class keeps each concern clean and independently testable.
//
// The store keeps the portfolio doc in memory and flushes on mutation.
// It does NOT watch the file; portfolio files are expected to be written
// only by this server, so watcher overhead is unnecessary.

export interface PortfolioLoadResult {
  /** Number of cross-product edges in the portfolio */
  cross_edge_count: number
  /** Number of products listed in the portfolio */
  product_count: number
  /** Path to the loaded portfolio file */
  file_path: string
}

export interface CrossEdgeMigrationResult {
  /** Cross-edges successfully migrated to portfolio format */
  migrated: Array<{
    id: string
    source: string
    target: string
    type: string
    source_product_id: string
  }>
  /** IDs of edges that could not be migrated (missing product context) */
  skipped: Array<{ id: string; reason: string }>
  /** Whether this was a dry run (no writes performed) */
  dry_run: boolean
}

export class UPGPortfolioStore {
  private doc: UPGPortfolioDocument | null = null
  private filePath: string | null = null
  private dirty = false
  private saveTimer: ReturnType<typeof setTimeout> | null = null

  // ── Load / Save ─────────────────────────────────────────────────────────────

  /**
   * Load an existing portfolio document from disk, or initialise an empty one
   * at the given path if it does not exist.
   *
   * @param filePath Absolute path to the `.portfolio.upg` file.
   * @param orgTitle Organisation title for newly created portfolios.
   */
  async loadOrInit(filePath: string, orgTitle = 'Portfolio'): Promise<PortfolioLoadResult> {
    this.filePath = path.resolve(filePath)

    let raw: string
    try {
      raw = await fs.readFile(this.filePath, 'utf-8')
    } catch (err) {
      if ((err as NodeJS.ErrnoException).code !== 'ENOENT') throw err
      // File does not exist; create a minimal valid portfolio document
      this.doc = this.makeEmptyPortfolio(orgTitle)
      this.dirty = true
      await this.flush()
      return {
        cross_edge_count: 0,
        product_count: 0,
        file_path: this.filePath,
      }
    }

    // normalizeDocument accepts both the canonical `$upg` envelope (kind:
    // "portfolio") and the legacy flat envelope, returning the flat in-memory
    // portfolio shape (with `type: "portfolio"` restored).
    const parsed = normalizeDocument(JSON.parse(raw)) as UPGPortfolioDocument
    if (parsed.type !== 'portfolio') {
      throw new Error(
        `Expected a portfolio document (type: "portfolio") at ${this.filePath}, ` +
        `but found type: "${(parsed as { type?: string }).type ?? 'unknown'}"`,
      )
    }
    this.doc = parsed
    return {
      cross_edge_count: this.doc.cross_edges.length,
      product_count: this.doc.products.length,
      file_path: this.filePath,
    }
  }

  /** Create a minimal valid UPGPortfolioDocument. */
  private makeEmptyPortfolio(orgTitle: string): UPGPortfolioDocument {
    return {
      upg_version: UPG_VERSION,
      type: 'portfolio',
      exported_at: new Date().toISOString(),
      source: { tool: 'upg-mcp-local' },
      organization: {
        id: `org_${createHash('sha256').update(orgTitle).digest('hex').slice(0, 8)}`,
        title: orgTitle,
      },
      product_areas: [],
      portfolios: [],
      products: [],
      cross_edges: [],
    }
  }

  /** Return the resolved portfolio file path, or null if not loaded. */
  getFilePath(): string | null {
    return this.filePath
  }

  /** Return the loaded portfolio document, or null if not loaded. */
  getDocument(): UPGPortfolioDocument | null {
    return this.doc
  }

  /** True when a portfolio document is loaded and ready. */
  isLoaded(): boolean {
    return this.doc !== null && this.filePath !== null
  }

  /** Flush pending writes to disk. No-op if not dirty. */
  async flush(): Promise<void> {
    if (this.saveTimer) {
      clearTimeout(this.saveTimer)
      this.saveTimer = null
    }
    await this.writeToDisk()
  }

  /**
   * Mark the portfolio store as dirty so the next `flush()` writes to disk.
   * Use this when an external caller mutates the document object directly via
   * `getDocument()` rather than going through `addCrossEdge` /
   * `removeCrossEdge`. Mirrors `UPGFileStore.markDirty()`.
   */
  markDirty(): void {
    this.dirty = true
  }

  private scheduleSave(): void {
    this.dirty = true
    if (this.saveTimer) clearTimeout(this.saveTimer)
    // Fire-and-forget debounced save: own its errors so a transient FS failure
    // never becomes an unhandled rejection. Stays dirty on failure → next flush retries.
    this.saveTimer = setTimeout(() => void this.writeToDisk().catch(() => {}), 300)
  }

  private async writeToDisk(): Promise<void> {
    if (!this.dirty || !this.doc || !this.filePath) return
    this.doc.exported_at = new Date().toISOString()
    // Canonical serialisation — handles both single-product and
    // portfolio documents via the shared core serialiser.
    const output = serializeCanonical(this.doc)
    // Per-write UNIQUE tmp path. A shared `${filePath}.tmp` let a debounced
    // save race an explicit flush(): both wrote the same tmp, the first rename
    // consumed it, and the second rename then threw
    // `ENOENT ...portfolio.upg.tmp -> ...portfolio.upg` even though the data had
    // already persisted — a false-negative error that made a naive cross-edge
    // retry duplicate. A random suffix removes the shared-tmp collision; the tmp
    // is cleaned up on any failure so a crashed write leaves no orphan.
    const tmpPath = `${this.filePath}.${randomUUID()}.tmp`
    try {
      await fs.writeFile(tmpPath, output, 'utf-8')
      await fs.rename(tmpPath, this.filePath)
    } catch (err) {
      await fs.rm(tmpPath, { force: true }).catch(() => {})
      throw err
    }
    this.dirty = false
  }

  // ── Cross-edge writes ────────────────────────────────────────────────────────

  /**
   * Add a cross-product edge to the portfolio document. `source` and `target`
   * must be qualified IDs (`{product_id}/{node_id}`), except that the
   * area-anchored edge types (`area_serves_persona` / `area_targets_market_segment`)
   * carry a bare portfolio-tier `product_area` id as their source.
   */
  addCrossEdge(edge: UPGCrossEdge): { status: 'created' | 'updated' | 'unchanged'; edge: UPGCrossEdge } {
    if (!this.doc) throw new Error('Portfolio document not loaded. Call loadOrInit() first.')
    if (!edge.id) throw new Error('Cross-edge must have an id')
    // Area-anchored edges source from a portfolio `product_area` id, not a
    // `{product_id}/{node_id}` pair — so the source qualification check is skipped
    // for them. The target is still qualified (`registry/{node_id}`).
    const areaAnchored = edge.type === 'area_serves_persona' || edge.type === 'area_targets_market_segment'
    if (!areaAnchored && !edge.source.includes('/')) {
      throw new Error(
        `Cross-edge source must be a qualified ID ({product_id}/{node_id}), got: "${edge.source}"`,
      )
    }
    if (!edge.target.includes('/')) {
      throw new Error(
        `Cross-edge target must be a qualified ID ({product_id}/{node_id}), got: "${edge.target}"`,
      )
    }
    if (!(UPG_CROSS_EDGE_TYPES as readonly string[]).includes(edge.type)) {
      throw new Error(
        `Invalid cross-product edge type: "${edge.type}". ` +
        `Valid types: ${UPG_CROSS_EDGE_TYPES.join(', ')}`,
      )
    }
    // (portfolio mirror): collapse an identical (source, target, type)
    // re-create onto the existing edge. A cross-product write that surfaced a
    // false-negative FS error (the shared-tmp rename race, fixed in writeToDisk)
    // but actually persisted would otherwise duplicate on a naive retry; the
    // dedup makes that retry a safe no-op.
    const existing = this.doc.cross_edges.find(
      (e) => e.source === edge.source && e.target === edge.target && e.type === edge.type,
    )
    if (existing) {
      // 0.10.6 (edge-property-upsert brief): an idempotent hit that carries
      // `properties` is an UPSERT, not a no-op — shallow-merge the supplied
      // properties onto the existing edge so the 218-edge confidence backfill
      // reaches edges that already exist. Without properties, it stays a no-op.
      // The existing edge's id is preserved (we never re-id on update).
      if (edge.properties && Object.keys(edge.properties).length > 0) {
        const before = JSON.stringify(existing.properties ?? {})
        existing.properties = { ...(existing.properties ?? {}), ...edge.properties }
        if (JSON.stringify(existing.properties) !== before) {
          this.scheduleSave()
          return { status: 'updated', edge: existing }
        }
      }
      return { status: 'unchanged', edge: existing }
    }
    this.doc.cross_edges.push(edge)
    this.scheduleSave()
    return { status: 'created', edge }
  }

  /**
   * Remove a cross-product edge by ID.
   * @returns The removed edge, or null if not found.
   */
  removeCrossEdge(edgeId: string): UPGCrossEdge | null {
    if (!this.doc) throw new Error('Portfolio document not loaded.')
    const idx = this.doc.cross_edges.findIndex((e) => e.id === edgeId)
    if (idx === -1) return null
    const [removed] = this.doc.cross_edges.splice(idx, 1)
    this.scheduleSave()
    return removed
  }

  /** Return all cross-product edges. */
  getAllCrossEdges(): UPGCrossEdge[] {
    return this.doc?.cross_edges ?? []
  }

  /** Find a cross-product edge by ID. */
  getCrossEdge(id: string): UPGCrossEdge | undefined {
    return this.doc?.cross_edges.find((e) => e.id === id)
  }

  // ── Registry (shared-vocabulary tier) ────────────────────────────────────────
  //
  // Canonical shared entities live in the portfolio document's `registry`
  // section. A canonical entity is a normal UPGBaseNode; product instances link
  // to it via an `instance_of` cross-edge whose target is `registry/{node_id}`.
  // The registry is lazy: it stays undefined until the first canonical node is
  // added, so portfolios without a registry serialise byte-identically.

  /** Return the registry section, or undefined when none exists yet. */
  getRegistry(): UPGRegistry | undefined {
    return this.doc?.registry
  }

  /**
   * Return the registry section, creating an empty one if absent. Marks the
   * document dirty only when it actually creates the section.
   */
  ensureRegistry(): UPGRegistry {
    if (!this.doc) throw new Error('Portfolio document not loaded. Call loadOrInit() first.')
    if (!this.doc.registry) {
      this.doc.registry = { nodes: [] }
      this.scheduleSave()
    }
    return this.doc.registry
  }

  /** All canonical entities in the registry (empty array when none). */
  listRegistryNodes(type?: string): UPGBaseNode[] {
    const nodes = this.doc?.registry?.nodes ?? []
    return type ? nodes.filter((n) => n.type === type) : nodes
  }

  /** Find a canonical entity by its (registry-local) node id. */
  getRegistryNode(id: string): UPGBaseNode | undefined {
    return this.doc?.registry?.nodes.find((n) => n.id === id)
  }

  /**
   * Add a canonical entity to the registry. Throws if a node with the same id
   * already exists (the registry is the authoritative single definition).
   */
  addRegistryNode(node: UPGBaseNode): void {
    if (!node.id) throw new Error('Registry node must have an id')
    const registry = this.ensureRegistry()
    if (registry.nodes.some((n) => n.id === node.id)) {
      throw new Error(`Registry already has a canonical entity with id "${node.id}"`)
    }
    registry.nodes.push(node)
    this.scheduleSave()
  }

  /**
   * Remove a canonical entity from the registry by id.
   * @returns The removed node, or null if not found.
   */
  removeRegistryNode(id: string): UPGBaseNode | null {
    if (!this.doc?.registry) return null
    const idx = this.doc.registry.nodes.findIndex((n) => n.id === id)
    if (idx === -1) return null
    const [removed] = this.doc.registry.nodes.splice(idx, 1)
    this.scheduleSave()
    return removed ?? null
  }

  /**
   * Patch a canonical entity in place (title / description / tags / properties).
   * Properties are shallow-merged so a partial patch (e.g. just `audience_role`)
   * preserves the rest. Does NOT touch any `instance_of` edges that point at this
   * canonical — editing the canonical leaves every instance linked. Returns the
   * updated node, or null if no registry node has that id.
   */
  updateRegistryNode(
    id: string,
    patch: {
      title?: string
      description?: string
      tags?: string[]
      properties?: Record<string, unknown>
    },
  ): UPGBaseNode | null {
    const node = this.doc?.registry?.nodes.find((n) => n.id === id)
    if (!node) return null
    if (patch.title !== undefined) node.title = patch.title
    if (patch.description !== undefined) node.description = patch.description
    if (patch.tags !== undefined) node.tags = patch.tags
    if (patch.properties !== undefined) {
      node.properties = { ...(node.properties ?? {}), ...patch.properties } as UPGBaseNode['properties']
    }
    this.scheduleSave()
    return node
  }

  // ── Registry-internal edges ──────────────────────────────────────────────────
  //
  // Canonical entities can relate to one another (a registry specification
  // governed_by a registry organization, a primitive defined_by a specification).
  // These live in `registry.edges` and never touch product graphs. Like the
  // registry itself, `edges` is lazy: it stays absent until the first internal
  // edge is added, so registries without internal structure serialise
  // byte-identically. Endpoints are bare registry node ids.

  /** All canonical-internal edges in the registry (empty array when none). */
  listRegistryEdges(type?: string): UPGEdge[] {
    const edges = this.doc?.registry?.edges ?? []
    return type ? edges.filter((e) => e.type === type) : edges
  }

  /** Find a registry-internal edge by id. */
  getRegistryEdge(id: string): UPGEdge | undefined {
    return this.doc?.registry?.edges?.find((e) => e.id === id)
  }

  /**
   * Add a canonical-internal edge to the registry. Throws if an edge with the
   * same id already exists. Lazily creates `registry.edges` on first use.
   */
  addRegistryEdge(edge: UPGEdge): void {
    if (!edge.id) throw new Error('Registry edge must have an id')
    const registry = this.ensureRegistry()
    if (!registry.edges) registry.edges = []
    if (registry.edges.some((e) => e.id === edge.id)) {
      throw new Error(`Registry already has an edge with id "${edge.id}"`)
    }
    registry.edges.push(edge)
    this.scheduleSave()
  }

  /**
   * Remove a registry-internal edge from the registry by id.
   * @returns The removed edge, or null if not found.
   */
  removeRegistryEdge(id: string): UPGEdge | null {
    if (!this.doc?.registry?.edges) return null
    const idx = this.doc.registry.edges.findIndex((e) => e.id === id)
    if (idx === -1) return null
    const [removed] = this.doc.registry.edges.splice(idx, 1)
    this.scheduleSave()
    return removed ?? null
  }

  // ── Migration: inline → portfolio ─────────────────────────
  //
  // Scans `sourceDoc` for edges whose type is in UPG_CROSS_EDGE_TYPES, converts
  // them to UPGCrossEdge objects with qualified IDs, and either:
  //   - dry_run: true  → reports what would change without writing anything
  //   - dry_run: false → writes them to this portfolio document AND removes them
  //                       from sourceDoc.edges (sourceDoc must be saved separately)
  //
  // `sourceProductId` is the product ID that owns the sourceDoc. When the target
  // node is NOT in sourceDoc, the caller must supply `targetProductId`; without
  // it, those edges are skipped (reported in `skipped`).

  /**
   * Migrate inline cross-product edges from a product document into this
   * portfolio document.
   *
   * **Does not flush**: caller is responsible for calling `.flush()` after
   * inspecting the result and, for non-dry-run, also saving `sourceDoc`.
   */
  migrateCrossEdgesFromDoc(
    sourceDoc: UPGDocument,
    sourceProductId: string,
    targetProductId: string | null,
    dryRun: boolean,
  ): CrossEdgeMigrationResult {
    if (!this.doc && !dryRun) {
      throw new Error('Portfolio document not loaded. Call loadOrInit() first.')
    }

    const crossEdgeTypeSet = new Set<string>(UPG_CROSS_EDGE_TYPES)
    const sourceNodeIds = new Set(sourceDoc.nodes.map((n) => n.id))

    const migrated: CrossEdgeMigrationResult['migrated'] = []
    const skipped: CrossEdgeMigrationResult['skipped'] = []
    const edgeIdsToRemove: string[] = []

    for (const edge of sourceDoc.edges) {
      if (!crossEdgeTypeSet.has(edge.type)) continue

      // source is always in the sourceDoc (it's a product node there)
      const qualifiedSource = `${sourceProductId}/${edge.source}`

      // target: if in sourceDoc, use same product; else use provided targetProductId
      let qualifiedTarget: string
      if (sourceNodeIds.has(edge.target)) {
        // target is also in the same product; unusual but structurally valid
        qualifiedTarget = `${sourceProductId}/${edge.target}`
      } else if (targetProductId) {
        qualifiedTarget = `${targetProductId}/${edge.target}`
      } else {
        skipped.push({
          id: edge.id,
          reason:
            `Target node "${edge.target}" is not in the source product and no ` +
            `targetProductId was provided; cannot determine qualified target ID`,
        })
        continue
      }

      migrated.push({
        id: edge.id,
        source: qualifiedSource,
        target: qualifiedTarget,
        type: edge.type,
        source_product_id: sourceProductId,
      })
      edgeIdsToRemove.push(edge.id)
    }

    if (!dryRun && migrated.length > 0) {
      if (!this.doc) throw new Error('Portfolio document not loaded.')

      // Write migrated edges to the portfolio
      for (const m of migrated) {
        const crossEdge: UPGCrossEdge = {
          id: m.id,
          source: m.source,
          target: m.target,
          type: m.type as UPGCrossEdgeType,
          source_product_id: sourceProductId,
          ...(m.target.split('/')[0] !== sourceProductId
            ? { target_product_id: m.target.split('/')[0] }
            : {}),
        }
        this.doc.cross_edges.push(crossEdge)
      }
      this.dirty = true

      // Remove migrated edges from the source document in-place
      const removeSet = new Set(edgeIdsToRemove)
      sourceDoc.edges = sourceDoc.edges.filter((e) => !removeSet.has(e.id))
    }

    return { migrated, skipped, dry_run: dryRun }
  }
}

// Re-export types so callers can import from store without going to @unified-product-graph/core
export type { UPGPortfolioDocument, UPGCrossEdge }

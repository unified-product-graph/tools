/**
 * Step 4 — portfolio-write invariants I-1 … I-7 (STORE-LAYER half).
 *
 * Authority: the portfolio-seam-unification charter (internal initiative record) §6. That document is the ruling of record; the
 * invariants below are transcribed from it and each test cites its I-number.
 * Where the wording here and the ruling differ, the ruling wins.
 *
 * WHY THIS FILE EXISTS. The ruling permits local portfolio writes ONLY on the
 * condition that I-1..I-7 land as tests BEFORE the first write ships — not
 * alongside it. §6's ratification bar, verbatim:
 *
 *   > On the evidence of 2026-08-06, invariants held by intention do not hold.
 *
 * And §5's dissent, which this file is the direct answer to:
 *
 *   > If they cannot be enforced by test rather than by intention, my
 *   > recommendation in §9 changes.
 *
 * SPLIT. The invariants divide by the layer they actually constrain. This file
 * carries the STORE-layer half (I-1, I-3, I-4, I-6-primitives, I-7-mechanism) —
 * the contract `@unified-product-graph/sdk` owes any holder. The ADAPTER-layer
 * half (I-2, I-5, I-6-mapping, I-7-writes) lives in
 * `packages/graph-service/src/__tests__/step4-portfolio-write-invariants.test.ts`,
 * because it constrains Entopo's local adapter, not the SDK. The split is
 * deliberate and load-bearing: `upg-sdk` is the published OSS package and is
 * slated for extraction to its own repository, so its suite must not reach into
 * a private sibling package to make its assertions.
 *
 * GAP CONVENTION. Invariants the current tree does NOT yet enforce are recorded
 * with `it.fails(...)` in a separate `[GAP]` describe block, never `it.skip` and
 * never `it.todo`. The choice is deliberate:
 *
 *   - `it.skip`  — silent. The suite reports nothing and the gap rots.
 *   - `it.todo`  — never executes, so it cannot notice when the gap closes. It
 *                  is a comment with a green tick.
 *   - `it.fails` — EXECUTES the assertion, passes while the assertion fails, and
 *                  turns into a HARD FAILURE the moment the gap is closed.
 *
 * `it.fails` is therefore self-retiring: it does not fail CI today, it is
 * visibly reported as an expected-fail, and whoever finally implements the
 * invariant is forced by a red suite to flip the marker to a real `it`. That is
 * the only convention of the three that cannot be forgotten.
 *
 * READ THE GAP BLOCK AS A GATE. Every `[GAP]` entry below is a write path that
 * remains BLOCKED. This lane ships tests and the I-1 guard only — no write paths.
 */
import { describe, it, expect, afterEach } from 'vitest'
import * as fs from 'node:fs'
import * as os from 'node:os'
import * as path from 'node:path'
import { fileURLToPath } from 'node:url'

import { UPGFileStore, UPGPortfolioStore } from '../index.js'
import type { UPGCrossEdge } from '@unified-product-graph/core'

// ── Fixtures ─────────────────────────────────────────────────────────────────
// Fictional product ("Kestrelbox") — no real companies, people, or brands.

const HERE = path.dirname(fileURLToPath(import.meta.url))
const SDK_SRC = path.resolve(HERE, '..')

const cleanupDirs: string[] = []
function tmpDir(tag: string): string {
  const d = fs.mkdtempSync(path.join(os.tmpdir(), `upg-step4-${tag}-`))
  cleanupDirs.push(d)
  return d
}

afterEach(() => {
  while (cleanupDirs.length) {
    const d = cleanupDirs.pop()!
    try {
      fs.rmSync(d, { recursive: true, force: true })
    } catch {
      /* ignore */
    }
  }
})

/**
 * Author a REAL portfolio file by round-tripping the portfolio store itself.
 * Deliberately not a hand-written fixture: a hand-written one could drift from
 * what the serializer actually emits, and then I-1 would be tested against a
 * shape that never occurs on disk.
 */
async function writeRealPortfolio(dir: string): Promise<string> {
  const file = path.join(dir, 'portfolio.upg')
  const store = new UPGPortfolioStore()
  await store.loadOrInit(file, 'Kestrelbox Holdings')
  await store.flush()
  return file
}

/**
 * A cross-edge in the shape `addCrossEdge` actually accepts: qualified
 * `{product_id}/{node_id}` endpoints and a portfolio-shared edge type (a
 * `resident` type is hard-rejected by the 3-state cross-product gate).
 */
const crossEdge = (id: string, target = 'p_marlinway/n_2'): UPGCrossEdge =>
  ({ id, source: 'p_kestrelbox/n_1', target, type: 'depends_on_product' }) as UPGCrossEdge

/** A minimal but valid single-product document, canonical envelope. */
function productDoc() {
  return {
    $upg: {
      format_version: '1.0.0',
      spec_version: '0.8.0',
      product: { id: 'p_kestrelbox', title: 'Kestrelbox' },
      counts: { nodes: 1, edges: 0 },
      provenance: {
        tool: 'vitest',
        tool_version: '0.0.0',
        exported_at: '2026-08-17T00:00:00.000Z',
      },
      integrity: { algorithm: 'sha256-128', body: '00000000000000000000000000000000' },
    },
    product: { id: 'p_kestrelbox', title: 'Kestrelbox' },
    nodes: [{ id: 'n_persona', type: 'persona', title: 'Field Surveyor', slug: 'field-surveyor' }],
    edges: [],
  }
}

function writeProductFile(dir: string): string {
  const file = path.join(dir, 'kestrelbox.upg')
  fs.writeFileSync(file, JSON.stringify(productDoc(), null, 2), 'utf-8')
  return file
}

// ═════════════════════════════════════════════════════════════════════════════
// PINNED — invariants the tree enforces TODAY. These are regression guards.
// ═════════════════════════════════════════════════════════════════════════════

describe('I-1 — one store class per file shape: portfolio.upg is never held by UPGFileStore', () => {
  /**
   * Ruling §6 I-1. The literal 0.25.0 holding, preserved intact.
   *
   * Before this lane, this side of the symmetry failed only INCIDENTALLY — via
   * `validateUPGDocument` reporting "product is required", which is the very
   * papercut 0.25.0 papered over downstream in the MCP layer. §6 I-1 calls that
   * out as a gap and orders the hardening unconditionally (Q-a).
   */

  it('[I-1] UPGFileStore.load() REFUSES a portfolio document', async () => {
    const dir = tmpDir('i1-refuse')
    const file = await writeRealPortfolio(dir)

    const store = new UPGFileStore()
    await expect(store.load(file)).rejects.toThrow(/portfolio/i)
  })

  it('[I-1] the refusal is BY MECHANISM — it names the portfolio and the right store', async () => {
    const dir = tmpDir('i1-mechanism')
    const file = await writeRealPortfolio(dir)

    let message = ''
    try {
      await new UPGFileStore().load(file)
      throw new Error('UNREACHABLE: UPGFileStore accepted a portfolio document')
    } catch (err) {
      message = err instanceof Error ? err.message : String(err)
    }

    // Names the kind of file it actually is...
    expect(message).toMatch(/PORTFOLIO/i)
    // ...and the store that should hold it. This is the half that distinguishes
    // a mechanism from a validation accident: an incidental schema error can
    // say the document is wrong, but it cannot say where the document belongs.
    expect(message).toMatch(/UPGPortfolioStore/)

    // And it is NOT the incidental schema error. If this assertion ever starts
    // failing, the explicit guard has been removed and I-1 has silently
    // regressed to a convention.
    expect(message).not.toMatch(/product is required/i)
  })

  it('[I-1] the refusal fires for the canonical envelope AND the legacy flat shape', async () => {
    const dir = tmpDir('i1-shapes')

    // Legacy flat envelope: `type: "portfolio"`, no `$upg` header.
    const flat = path.join(dir, 'legacy-flat.upg')
    fs.writeFileSync(
      flat,
      JSON.stringify({
        upg_version: '0.8.0',
        type: 'portfolio',
        exported_at: '2026-08-17T00:00:00.000Z',
        source: { tool: 'vitest' },
        organization: { id: 'org_kestrelbox', title: 'Kestrelbox Holdings' },
        product_areas: [],
        portfolios: [],
        products: [],
        cross_edges: [],
      }),
      'utf-8',
    )

    await expect(new UPGFileStore().load(flat)).rejects.toThrow(/UPGPortfolioStore/)

    // Canonical `$upg.kind: "portfolio"` envelope, via the real serializer.
    const canonical = await writeRealPortfolio(dir)
    await expect(new UPGFileStore().load(canonical)).rejects.toThrow(/UPGPortfolioStore/)
  })

  it('[I-1] loadReadOnly() is guarded too — the transient-store path is not a bypass', async () => {
    const dir = tmpDir('i1-readonly')
    const file = await writeRealPortfolio(dir)

    // `loadReadOnly` is how the portfolio read layer pulls non-active products
    // into transient stores. It shares `loadInternal`, so the guard covers it —
    // but that is worth pinning, because a future refactor that gives
    // `loadReadOnly` its own path would reopen exactly the hole I-1 closes.
    await expect(new UPGFileStore().loadReadOnly(file)).rejects.toThrow(/UPGPortfolioStore/)
  })

  it('[I-1, converse] UPGPortfolioStore.loadOrInit() still REFUSES a product document', async () => {
    const dir = tmpDir('i1-converse')
    const file = writeProductFile(dir)

    // The pre-existing half of the symmetry (store.ts, `type !== 'portfolio'`).
    // Pinned here so the pair is tested together and neither can be removed
    // without a red test naming the other.
    await expect(new UPGPortfolioStore().loadOrInit(file)).rejects.toThrow(
      /Expected a portfolio document/i,
    )
  })

  it('[I-1] a genuine single-product document still loads — the guard is not over-broad', async () => {
    const dir = tmpDir('i1-negative')
    const file = writeProductFile(dir)

    const store = new UPGFileStore()
    await store.load(file)
    expect(store.getAllNodes()).toHaveLength(1)
  })
})

describe('I-3 — compare-and-swap is load-bearing and may not be defeated', () => {
  /**
   * Ruling §6 I-3. All writes go through `flush()` → `writeToDisk()` →
   * `writeLocked()`. No path may pre-seed `baselineFileHash`, skip the lock, or
   * write the file directly.
   *
   * This is the machinery. The test PINS it (regression guard) — the
   * mechanism predates this lane; what did not exist was a test tying it to the
   * Step 4 permission.
   */

  it('[I-3] a second store over one file CONFLICTs, and the bytes on disk are untouched', async () => {
    const dir = tmpDir('i3-cas')
    const file = await writeRealPortfolio(dir)

    // Two holders of the same file — the ordinary crew configuration (§3c).
    const a = new UPGPortfolioStore()
    const b = new UPGPortfolioStore()
    await a.loadOrInit(file)
    await b.loadOrInit(file)

    // A writes first and wins.
    a.addCrossEdge(crossEdge('cx_a'))
    await a.flush()

    const afterA = fs.readFileSync(file, 'utf-8')

    // B is now stale. Its write MUST be refused, not merged and not won.
    b.addCrossEdge(crossEdge('cx_b', 'p_ternpoint/n_3'))
    await expect(b.flush()).rejects.toThrow(/CONFLICT/i)

    // The decisive assertion: BYTE-IDENTICAL. A refusal that still mutated the
    // file would be the 2026-08-06 clobber with a louder log line.
    expect(fs.readFileSync(file, 'utf-8')).toBe(afterA)
  })

  it('[I-3] reload() is the in-band recovery — after it, the same write succeeds', async () => {
    const dir = tmpDir('i3-reload')
    const file = await writeRealPortfolio(dir)

    const a = new UPGPortfolioStore()
    const b = new UPGPortfolioStore()
    await a.loadOrInit(file)
    await b.loadOrInit(file)

    a.addCrossEdge(crossEdge('cx_a'))
    await a.flush()

    b.addCrossEdge(crossEdge('cx_b', 'p_ternpoint/n_3'))
    await expect(b.flush()).rejects.toThrow(/CONFLICT/i)

    // Re-read, discard unsaved, redo (store.ts `reload()`). This is what I-5
    // permits AT MOST ONCE from the app.
    await b.reload()
    b.addCrossEdge(crossEdge('cx_b', 'p_ternpoint/n_3'))
    await b.flush()

    const doc = b.getDocument()
    expect(doc).not.toBeNull()
    // A's edge survived — the reload did not clobber the fresher work.
    expect(doc!.cross_edges).toHaveLength(2)
  })

  it('[I-3] the CAS refusal does not depend on WHAT changed — any drift refuses', async () => {
    const dir = tmpDir('i3-drift')
    const file = await writeRealPortfolio(dir)

    const b = new UPGPortfolioStore()
    await b.loadOrInit(file)

    // An out-of-band byte edit by anyone at all — a hand-edit, a sync, another
    // process. The store has no idea what changed and must not guess (§3a,
    // "No merge, by design").
    const raw = JSON.parse(fs.readFileSync(file, 'utf-8'))
    raw.organization.title = 'Edited Out Of Band'
    fs.writeFileSync(file, JSON.stringify(raw, null, 2), 'utf-8')
    const beforeFlush = fs.readFileSync(file, 'utf-8')

    b.addCrossEdge(crossEdge('cx_drift'))
    await expect(b.flush()).rejects.toThrow(/CONFLICT/i)
    expect(fs.readFileSync(file, 'utf-8')).toBe(beforeFlush)
  })
})

describe('I-4 — the serializer owns the hash: no caller computes or writes $upg.integrity', () => {
  /**
   * Ruling §6 I-4, which specifies "a repo guard asserting no reference to
   * `$upg.integrity` / `computeBodyChecksum` outside
   * `packages/upg-spec/src/format/canonical.ts` and
   * `packages/upg-sdk/src/lib/workspace.ts`".
   *
   * Scoped here to the SDK source tree, which is what this package can honestly
   * assert. The app-code half of the same invariant is guarded in the
   * graph-service suite, where the app code actually lives.
   *
   * Why it matters (§2): the checksum is a SIDE-EFFECT of `serializeCanonical`,
   * recomputed unconditionally on every write. Any caller that computes it
   * itself is, by definition, re-stamping a document the serializer did not
   * produce — which is precisely how a corrupted file comes to present as
   * perfectly intact.
   */

  it('[I-4] no SDK source file computes a body checksum', () => {
    const offenders: string[] = []

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') continue
          walk(full)
          continue
        }
        if (!entry.name.endsWith('.ts')) continue

        const text = fs.readFileSync(full, 'utf-8')
        // Strip block and line comments before matching. The rationale comments
        // in store.ts legitimately DISCUSS `$upg.integrity`; discussing it is not
        // computing it, and a guard that cannot tell the difference would punish
        // documentation.
        const code = text
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '')

        if (/computeBodyChecksum\s*\(/.test(code)) {
          offenders.push(path.relative(SDK_SRC, full))
        }
      }
    }
    walk(SDK_SRC)

    expect(offenders).toEqual([])
  })

  it('[I-4] no SDK source file ASSIGNS to an integrity field', () => {
    const offenders: string[] = []

    const walk = (dir: string) => {
      for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
        const full = path.join(dir, entry.name)
        if (entry.isDirectory()) {
          if (entry.name === 'node_modules' || entry.name === 'dist' || entry.name === '__tests__') continue
          walk(full)
          continue
        }
        if (!entry.name.endsWith('.ts')) continue

        const code = fs
          .readFileSync(full, 'utf-8')
          .replace(/\/\*[\s\S]*?\*\//g, '')
          .replace(/^\s*\/\/.*$/gm, '')

        // `x.integrity = ...` / `$upg.integrity = ...` / `["integrity"] = ...`
        // The legacy `_integrity` field is a DIFFERENT hash (§2) stamped once at
        // createProduct and carried through untouched; it is out of scope here.
        if (/(?<!_)\bintegrity\s*=[^=]/.test(code) || /\[['"]integrity['"]\]\s*=[^=]/.test(code)) {
          offenders.push(path.relative(SDK_SRC, full))
        }
      }
    }
    walk(SDK_SRC)

    expect(offenders).toEqual([])
  })
})

describe('I-6 — scoped mutations only: the store exposes named primitives, and they are the write surface', () => {
  /**
   * Ruling §6 I-6. The permitted write surface, verbatim from the ruling:
   *   addCrossEdge · removeCrossEdge · registry node/edge CRUD
   *   (addRegistryNode / updateRegistryNode / removeRegistryNode /
   *    addRegistryEdge / removeRegistryEdge)
   *   · single-field document edits via getDocument() + markDirty()
   *
   * FORBIDDEN: constructing a portfolio document in the app and saving it over
   * the file. That is the shape of BOTH the 2026-08-06 clobber and the rejected
   * product-store save.
   *
   * This half pins that every named primitive actually exists and is callable,
   * so the graph-service mapping test has a fixed vocabulary to map onto. The
   * mapping itself is asserted in the adapter suite.
   */

  it('[I-6] every primitive named in the ruling exists on UPGPortfolioStore', () => {
    const store = new UPGPortfolioStore() as unknown as Record<string, unknown>

    const permitted = [
      'addCrossEdge',
      'removeCrossEdge',
      'addRegistryNode',
      'updateRegistryNode',
      'removeRegistryNode',
      'addRegistryEdge',
      'removeRegistryEdge',
      'getDocument',
      'markDirty',
      'flush',
      'reload',
    ]

    const missing = permitted.filter((name) => typeof store[name] !== 'function')
    expect(missing).toEqual([])
  })

  it('[I-6] the store exposes NO wholesale-replacement primitive', () => {
    const store = new UPGPortfolioStore() as unknown as Record<string, unknown>

    // If any of these ever appear, the app gains a one-call route to exactly the
    // failure mode I-6 forbids, and the adapter-side guard becomes unenforceable.
    const forbidden = ['setDocument', 'replaceDocument', 'loadFromObject', 'setProducts', 'setPortfolios']
    const present = forbidden.filter((name) => typeof store[name] === 'function')
    expect(present).toEqual([])
  })
})

describe('I-7 — loadOrInit must never create a portfolio file as a side effect of a write', () => {
  /**
   * Ruling §6 I-7. The Phase-1 landmine in its write form.
   *
   * The store-layer fact this pins is uncomfortable and deliberate:
   * `loadOrInit()` DOES create a file on ENOENT. That is correct for the UPG
   * tools (it is how a workspace acquires its index) and it is precisely why the
   * app must stat first and bail. Pinning the landmine here means the adapter's
   * stat-first guard has a test-visible REASON, rather than looking like belt
   * and braces someone could tidy away.
   */

  it('[I-7, landmine] loadOrInit() CREATES a portfolio file when none exists', async () => {
    const dir = tmpDir('i7-landmine')
    const file = path.join(dir, 'portfolio.upg')
    expect(fs.existsSync(file)).toBe(false)

    const store = new UPGPortfolioStore()
    await store.loadOrInit(file, 'Kestrelbox Holdings')

    // This is the hazard, pinned. Any caller that reaches loadOrInit without
    // stat-ing first will silently seed an index file into an arbitrary folder.
    expect(fs.existsSync(file)).toBe(true)
  })

  it('[I-7] the created file is a real portfolio, not a product — creation does not confuse the kinds', async () => {
    const dir = tmpDir('i7-kind')
    const file = path.join(dir, 'portfolio.upg')
    await new UPGPortfolioStore().loadOrInit(file, 'Kestrelbox Holdings')

    // Round-trips as a portfolio...
    const reread = new UPGPortfolioStore()
    await reread.loadOrInit(file)
    expect(reread.getDocument()).not.toBeNull()

    // ...and I-1 holds over it. Creation and refusal agree about what this file is.
    await expect(new UPGFileStore().load(file)).rejects.toThrow(/UPGPortfolioStore/)
  })
})

// ═════════════════════════════════════════════════════════════════════════════
// [GAP] — invariants NOT yet enforced. Marked `it.fails`: executed, reported,
// non-failing today, and a HARD FAILURE the moment the gap closes.
//
// WRITE PATHS BLOCKED UNTIL GREEN.
// ═════════════════════════════════════════════════════════════════════════════

describe('[GAP] Step 4 — store-layer invariants not yet enforced (write paths blocked until green)', () => {
  it.fails(
    '[I-3][GAP] no store-layer guard prevents a caller pre-seeding baselineFileHash — write paths blocked until green',
    async () => {
      const dir = tmpDir('gap-i3')
      const file = await writeRealPortfolio(dir)

      const b = new UPGPortfolioStore()
      await b.loadOrInit(file)

      // Someone else freshens the file.
      const a = new UPGPortfolioStore()
      await a.loadOrInit(file)
      a.addCrossEdge(crossEdge('cx_a'))
      await a.flush()

      // I-3 says "no path may pre-seed `baselineFileHash`". `baselineFileHash`
      // is `private` in TypeScript, which is a COMPILE-time constraint only — it
      // is a plain property at runtime and any holder can overwrite it, defeating
      // the compare-and-swap entirely. TypeScript's `private` is not a mechanism
      // against a determined or careless caller; only true JS private fields
      // (`#baselineFileHash`) or a closure would be.
      //
      // This test asserts the defeat is IMPOSSIBLE. It currently fails because
      // the defeat succeeds. When `baselineFileHash` becomes a true private
      // field, the flush below will CONFLICT, this test will pass, and `it.fails`
      // will turn red — flip it to `it` at that point.
      ;(b as unknown as Record<string, unknown>).baselineFileHash = (
        a as unknown as Record<string, unknown>
      ).baselineFileHash

      b.addCrossEdge(crossEdge('cx_b', 'p_ternpoint/n_3'))
      await expect(b.flush()).rejects.toThrow(/CONFLICT/i)
    },
  )

  it.fails(
    '[I-7][GAP] UPGPortfolioStore has no load-only (never-create) entry point — write paths blocked until green',
    async () => {
      const dir = tmpDir('gap-i7')
      const store = new UPGPortfolioStore() as unknown as Record<string, unknown>

      // I-7 requires that a write against a folder with no `portfolio.upg`
      // refuses and creates NO file. Today the app enforces this by stat-ing
      // before calling `loadOrInit` — a discipline at the CALL SITE, which is
      // exactly the class of protection the ruling says does not hold (§6
      // ratification bar). The store offers no `load()` that refuses to create.
      //
      // When a never-create entry point lands, this passes and the marker flips.
      expect(typeof store.load).toBe('function')

      const file = path.join(dir, 'portfolio.upg')
      await (store.load as (p: string) => Promise<unknown>)(file)
      expect(fs.existsSync(file)).toBe(false)
    },
  )
})

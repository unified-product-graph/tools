/**
 * Renders .upg.md as plain CommonMark by resolving refs to titles.
 * Output is a normal markdown file, suitable for sharing anywhere.
 */

/** Lookup function: given 'type:id' or 'type:id@product', returns the entity title or null */
export type TitleResolver = (key: string) => string | null | Promise<string | null>

/** The resolved canonical type/id/product for a ref key */
export interface RefResolution {
  type: string
  id: string
  product?: string
}

/**
 * Resolver function used by updateRefs.
 * Given a key ('type:id' or 'type:id@product'), returns the new canonical
 * type/id/product, or null to leave the ref unchanged.
 */
export type RefResolver = (key: string) => RefResolution | null | Promise<RefResolution | null>

export interface ExportOptions {
  /** Resolve entity references to their titles. If not provided, uses the id as fallback. */
  resolveTitle?: TitleResolver

  /** Whether to include frontmatter as a markdown header block (default: false) */
  includeFrontmatter?: boolean

  /**
   * Resolve ref keys to their current canonical type/id/product.
   * Called as a pre-processing step before title resolution and markdown export.
   * If provided, all [[type:id]] refs are rewritten to their resolved form.
   */
  resolveRef?: RefResolver
}

// ─── Async replace helper ─────────────────────────────────────────────────────

/** Async version of String.replace with regex */
async function replaceAsync(
  str: string,
  regex: RegExp,
  replacer: (...args: string[]) => Promise<string>,
): Promise<string> {
  const matches: Array<{ match: RegExpExecArray; replacement: string }> = []
  const pattern = new RegExp(regex.source, regex.flags)
  let m: RegExpExecArray | null

  while ((m = pattern.exec(str)) !== null) {
    const replacement = await replacer(...m)
    matches.push({ match: m, replacement })
  }

  // Apply replacements from end to start so indices stay valid
  let result = str
  for (let i = matches.length - 1; i >= 0; i--) {
    const { match, replacement } = matches[i]
    result = result.slice(0, match.index) + replacement + result.slice(match.index + match[0].length)
  }

  return result
}

// ─── Ref key helper ───────────────────────────────────────────────────────────

/** Build a ref key from type, id, and optional product */
function refKey(type: string, id: string, product?: string): string {
  return product ? `${type}:${id}@${product}` : `${type}:${id}`
}

/** Build the ref string segment (type:id or type:id@product) */
function refSegment(type: string, id: string, product?: string): string {
  return product ? `${type}:${id}@${product}` : `${type}:${id}`
}

// ─── updateRefs ───────────────────────────────────────────────────────────────

/**
 * Rewrite all entity ref keys in a .upg.md source string using a resolver.
 *
 * Processes both standalone entity refs ([[type:id@product]]) and entity refs
 * embedded inside edge refs ({{type:id@product → type:id@product|verb}}).
 *
 * If the resolver returns null for a key, the original ref text is preserved.
 *
 * @param source - Raw .upg.md content
 * @param resolveRef - Function mapping a key to its new canonical form
 * @returns The source with all resolvable ref keys rewritten
 */
export async function updateRefs(source: string, resolveRef: RefResolver): Promise<string> {
  // Process edge refs first (they contain entity refs inside them that we don't want
  // to double-process when we subsequently handle standalone entity refs)
  let result = await replaceAsync(
    source,
    /\{\{(\+?)([\w]+):([\w-]+)(?:@([\w-]+))?\s*(?:→|->)\s*([\w]+):([\w-]+)(?:@([\w-]+))?\|([\w_]+)\}\}/g,
    async (match, _creation, srcType, srcId, srcProduct, tgtType, tgtId, tgtProduct, verb) => {
      const srcKey = refKey(srcType, srcId, srcProduct || undefined)
      const tgtKey = refKey(tgtType, tgtId, tgtProduct || undefined)

      const [srcResolved, tgtResolved] = await Promise.all([
        resolveRef(srcKey),
        resolveRef(tgtKey),
      ])

      const finalSrc = srcResolved
        ? refSegment(srcResolved.type, srcResolved.id, srcResolved.product)
        : refSegment(srcType, srcId, srcProduct || undefined)

      const finalTgt = tgtResolved
        ? refSegment(tgtResolved.type, tgtResolved.id, tgtResolved.product)
        : refSegment(tgtType, tgtId, tgtProduct || undefined)

      // Preserve the original arrow style
      const arrow = match.includes('→') ? '→' : '->'
      return `{{${finalSrc} ${arrow} ${finalTgt}|${verb}}}`
    },
  )

  // Now process standalone entity refs (including those with modifiers and display text)
  result = await replaceAsync(
    result,
    /\[\[(\+?)([\w]+):([\w-]+)(?:@([\w-]+))?(?:\|([^\]]*))?\]\]/g,
    async (_match, creationFlag, type, id, product, modifiers) => {
      const key = refKey(type, id, product || undefined)
      const resolved = await resolveRef(key)

      const newSegment = resolved
        ? refSegment(resolved.type, resolved.id, resolved.product)
        : refSegment(type, id, product || undefined)

      const prefix = creationFlag === '+' ? '+' : ''
      const suffix = modifiers ? `|${modifiers}` : ''
      return `[[${prefix}${newSegment}${suffix}]]`
    },
  )

  return result
}

// ─── toPlainMarkdown ──────────────────────────────────────────────────────────

/**
 * Convert a .upg.md file to plain markdown.
 *
 * - [[type:id]] → entity title (or id if unresolvable)
 * - [[type:id|"display text"]] → display text
 * - [[type:id|prop:val]] → entity title
 * - [[+type:id|...]] → title (creation prefix stripped)
 * - [[type:id@product]] → resolved cross-product entity title
 * - {{source → target|verb}} → "source title verb target title"
 *
 * If `resolveRef` is provided, ref keys are rewritten before title resolution.
 *
 * @param source - The complete .upg.md file content
 * @param options - Resolver and formatting options
 * @returns Plain markdown string
 */
export async function toPlainMarkdown(
  source: string,
  options: ExportOptions = {},
): Promise<string> {
  const { resolveTitle, resolveRef, includeFrontmatter = false } = options

  // Pre-process: rewrite ref keys via resolveRef if provided
  let output = resolveRef ? await updateRefs(source, resolveRef) : source

  // Strip frontmatter
  const fmMatch = output.match(/^---\n[\s\S]*?\n---\n/)
  if (fmMatch) {
    if (includeFrontmatter) {
      // Convert frontmatter to a markdown header block
      const fm = fmMatch[0]
        .replace(/^---\n/, '')
        .replace(/\n---\n$/, '')
      const lines = fm.split('\n').filter(l => l.trim())
      const header = lines.map(l => `> ${l}`).join('\n')
      output = header + '\n\n' + output.slice(fmMatch[0].length)
    } else {
      output = output.slice(fmMatch[0].length)
    }
  }

  // Resolve entity references
  // Process display-text refs first (they have quotes)
  output = await replaceAsync(
    output,
    /\[\[\+?([\w]+):([\w-]+)(?:@[\w-]+)?\|([^\]]*"[^"]+")[^\]]*\]\]/g,
    async (_match, _type, id, modifiers) => {
      const dtMatch = modifiers.match(/"([^"]+)"/)
      if (dtMatch) return dtMatch[1]
      return id
    },
  )

  // Then process remaining entity refs (no display text)
  output = await replaceAsync(
    output,
    /\[\[\+?([\w]+):([\w-]+)(?:@([\w-]+))?(?:\|[^\]]*)?\]\]/g,
    async (_match, type, id, product) => {
      if (resolveTitle) {
        const key = refKey(type, id, product || undefined)
        const title = await resolveTitle(key)
        if (title) return title
      }
      // Fallback: humanise the id
      return id.replace(/-/g, ' ').replace(/\b\w/g, c => c.toUpperCase())
    },
  )

  // Resolve edge references
  output = await replaceAsync(
    output,
    /\{\{([\w]+):([\w-]+)(?:@([\w-]+))?\s*(?:→|->)\s*([\w]+):([\w-]+)(?:@([\w-]+))?\|([\w_]+)\}\}/g,
    async (_match, srcType, srcId, srcProduct, tgtType, tgtId, tgtProduct, verb) => {
      const srcTitleKey = refKey(srcType, srcId, srcProduct || undefined)
      const tgtTitleKey = refKey(tgtType, tgtId, tgtProduct || undefined)
      const srcTitle = resolveTitle
        ? (await resolveTitle(srcTitleKey)) ?? srcId
        : srcId
      const tgtTitle = resolveTitle
        ? (await resolveTitle(tgtTitleKey)) ?? tgtId
        : tgtId
      const humanVerb = verb.replace(/_/g, ' ')
      return `${srcTitle} ${humanVerb} ${tgtTitle}`
    },
  )

  return output.trim() + '\n'
}

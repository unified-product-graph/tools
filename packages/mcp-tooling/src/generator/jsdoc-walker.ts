/**
 * JSDoc walker. Extracts tool metadata from `<package>/src/tools/*.ts`
 * via the TypeScript Compiler API.
 *
 * For each top-level `export const X: ToolHandler<...> = ...` it pulls:
 *   - handler symbol (`getProductContext`).
 *   - source-relative `file:line`.
 *   - description (prose before any `@`-tag).
 *   - standard tags: `@returns`, `@throws`, `@example`, `@see`,
 *     `@since`, `@deprecated`.
 *   - custom tags: `@warning`, `@atomicity`.
 */

import * as ts from 'typescript'
import { readFileSync } from 'node:fs'
import { basename } from 'node:path'

export interface JSDocBlock {
  /** The exported handler symbol, e.g. `getProductContext`. */
  symbol: string
  /** File:line anchor for diagnostics, relative to the package root. */
  source: string
  /** The free-form prose before any `@`-tag. May be multi-paragraph. */
  description: string
  /** `@returns` body (single tag). */
  returns?: string
  /** All `@throws` bodies, in source order. */
  throws: string[]
  /** All `@example` bodies, in source order. Code blocks preserved verbatim. */
  examples: string[]
  /** `@atomicity` body. One of `atomic`, `atomic-with-rollback`,
   *  `non-atomic`, `atomic (read-only)`, or any other free-form value.
   *  Required for write tools. See the audit gate in `./audit.ts`. */
  atomicity?: string
  /** All `@warning` bodies. Non-error surfaces (alias trails,
   *  suggestion lists, lifecycle hints). Custom tag, parsed manually. */
  warnings: string[]
  /** All `@see` bodies. Cross-refs to related tools or spec sections. */
  see: string[]
  /** `@since` body. Version introduced. */
  since?: string
  /** `@deprecated` body. Sunset version plus replacement guidance. */
  deprecated?: string
}

export interface WalkerError {
  source: string
  symbol?: string
  message: string
}

export interface WalkerResult {
  blocks: JSDocBlock[]
  errors: WalkerError[]
}

/**
 * Parse a single handler source file and return every exported
 * handler's JSDoc block. Errors are collected (parse-only failures)
 * rather than thrown, so callers decide how strict to be.
 *
 * `handlerTypeName` defaults to `ToolHandler` (matches the canonical
 * `ToolHandler<TContext>` from `@unified-product-graph/mcp-tooling`).
 * Servers that use a different alias pass it explicitly.
 */
export function walkHandlerFile(
  filePath: string,
  packageRoot: string,
  handlerTypeName: string = 'ToolHandler',
): WalkerResult {
  const source = readFileSync(filePath, 'utf-8')
  const sf = ts.createSourceFile(filePath, source, ts.ScriptTarget.ES2022, true)
  const relPath = filePath.startsWith(packageRoot)
    ? filePath.slice(packageRoot.length + 1)
    : basename(filePath)

  const blocks: JSDocBlock[] = []
  const errors: WalkerError[] = []

  for (const stmt of sf.statements) {
    // export const X: ToolHandler = (...) => ...
    if (ts.isVariableStatement(stmt) && hasExportModifier(stmt)) {
      for (const decl of stmt.declarationList.declarations) {
        if (!ts.isIdentifier(decl.name)) continue
        if (!isHandlerType(decl.type, handlerTypeName)) continue

        const block = readJSDoc(stmt, decl.name.text, relPath, sf)
        if (block) blocks.push(block)
        else errors.push({
          source: locOf(decl.name, sf, relPath),
          symbol: decl.name.text,
          message: 'No JSDoc block found on handler declaration',
        })
      }
    }

    // export async function X(...). Kept as a possibility for future style.
    if (ts.isFunctionDeclaration(stmt) && hasExportModifier(stmt) && stmt.name) {
      const block = readJSDoc(stmt, stmt.name.text, relPath, sf)
      if (block) blocks.push(block)
    }
  }

  return { blocks, errors }
}

// ── Internals ──────────────────────────────────────────────────────────────

function hasExportModifier(node: ts.Node): boolean {
  const mods = ts.canHaveModifiers(node) ? ts.getModifiers(node) : undefined
  return !!mods?.some((m) => m.kind === ts.SyntaxKind.ExportKeyword)
}

function isHandlerType(typeNode: ts.TypeNode | undefined, handlerTypeName: string): boolean {
  if (!typeNode) return false
  if (ts.isTypeReferenceNode(typeNode) && ts.isIdentifier(typeNode.typeName)) {
    return typeNode.typeName.text === handlerTypeName
  }
  return false
}

function locOf(node: ts.Node, sf: ts.SourceFile, relPath: string): string {
  const { line } = sf.getLineAndCharacterOfPosition(node.getStart(sf))
  return `${relPath}:${line + 1}`
}

function readJSDoc(
  hostNode: ts.Node,
  symbol: string,
  relPath: string,
  sf: ts.SourceFile,
): JSDocBlock | null {
  const jsDocs = ts.getJSDocCommentsAndTags(hostNode).filter(ts.isJSDoc)
  if (jsDocs.length === 0) return null
  const doc = jsDocs[jsDocs.length - 1]

  const description = readDescription(doc)

  const block: JSDocBlock = {
    symbol,
    source: locOf(hostNode, sf, relPath),
    description,
    throws: [],
    examples: [],
    warnings: [],
    see: [],
  }

  if (!doc.tags) return block

  for (const tag of doc.tags) {
    const name = tag.tagName.text
    const body = tagBody(tag)

    switch (name) {
      case 'returns':
      case 'return':
        block.returns = body
        break
      case 'throws':
      case 'exception':
        block.throws.push(body)
        break
      case 'example':
        block.examples.push(body)
        break
      case 'see':
        block.see.push(body)
        break
      case 'since':
        block.since = body
        break
      case 'deprecated':
        block.deprecated = body
        break
      case 'atomicity':
        block.atomicity = body
        break
      case 'warning':
        block.warnings.push(body)
        break
      // Other tags (e.g. @param) are ignored. The inputSchema in the
      // registry is the authoritative arg contract.
    }
  }

  return block
}

function readDescription(doc: ts.JSDoc): string {
  const raw = ts.getTextOfJSDocComment(doc.comment) ?? ''
  return normaliseWhitespace(raw)
}

function tagBody(tag: ts.JSDocTag): string {
  const commentText = ts.getTextOfJSDocComment(tag.comment) ?? ''

  if (ts.isJSDocThrowsTag(tag) && tag.typeExpression) {
    const typeText = tag.typeExpression.getText().replace(/^\{|\}$/g, '')
    return normaliseWhitespace(`{${typeText}} ${commentText}`)
  }

  if (ts.isJSDocSeeTag(tag) && tag.name) {
    const nameText = entityNameText(tag.name.name)
    const trailing = commentText.replace(/[\s*]/g, '')
    return trailing.length > 0
      ? normaliseWhitespace(`${nameText} ${commentText}`)
      : nameText
  }

  return normaliseWhitespace(commentText)
}

function entityNameText(name: ts.EntityName | ts.JSDocMemberName): string {
  if (ts.isIdentifier(name)) return name.text
  if (ts.isQualifiedName(name)) {
    return `${entityNameText(name.left)}.${name.right.text}`
  }
  return `${entityNameText(name.left)}#${name.right.text}`
}

function normaliseWhitespace(s: string): string {
  return s
    .split('\n')
    .map((l) => l.replace(/^\s*\*\s?/, ''))
    .join('\n')
    .trim()
}

/**
 * Output formatters: colored, styled terminal output.
 */

import chalk from 'chalk'
import type { UPGBaseNode } from '@unified-product-graph/core'
import { sanitizeForTerminal } from './sanitize.js'

// ── Entity type colors ─────────────────────────────────────────────────────

const TYPE_COLORS: Record<string, (s: string) => string> = {
  product: chalk.bold.white,
  persona: chalk.cyan,
  // Legacy keys (`jtbd`, `pain_point`) kept as aliases so graphs predating
  // the rename still colour correctly before auto-migration runs.
  job: chalk.blue,
  jtbd: chalk.blue,
  need: chalk.red,
  pain_point: chalk.red,
  desired_outcome: chalk.green,
  opportunity: chalk.yellow,
  solution: chalk.magenta,
  hypothesis: chalk.yellowBright,
  experiment: chalk.magentaBright,
  learning: chalk.greenBright,
  feature: chalk.blueBright,
  epic: chalk.blue,
  user_story: chalk.dim,
  competitor: chalk.redBright,
  outcome: chalk.green,
  metric: chalk.cyan,
  objective: chalk.yellow,
  key_result: chalk.yellowBright,
}

function colorType(type: string): string {
  // Look up the colour by the RAW type (so legacy aliases still match), but
  // render the SANITISED text so a hostile `type` can't inject control bytes.
  const colorFn = TYPE_COLORS[type] ?? chalk.gray
  return colorFn(sanitizeForTerminal(type))
}

/** UPG logo. Shown on `upg` with no args or `upg --version`. */
export function upgLogo(version: string): string {
  const s = chalk.dim('·')
  const m = chalk.white('•')
  const c = chalk.bold.white('●')
  return [
    '',
    `   ${m}  ${s}  ${m}`,
    `   ${s}  ${c}  ${s}`,
    `   ${m}  ${s}  ${m}`,
    '',
    `   ${chalk.bold.white('Unified Product Graph')}  ${chalk.dim(`v${version}`)}`,
    '',
  ].join('\n')
}

/** Brand color: blueprint blue. */
export const brand = chalk.blueBright

/** UPG branding header. Shown on every command. */
export function upgHeader(subtitle?: string): string {
  const mark = brand('⬡')
  const name = chalk.bold.white(' UPG')
  const sub = subtitle ? chalk.dim(` · ${subtitle}`) : ''
  return `\n  ${mark}${name}${sub}\n`
}

/** Format a node as a compact one-liner with color */
export function formatNode(node: UPGBaseNode, indent = ''): string {
  // Sanitise every node-supplied value before it reaches the terminal:
  // title, and the status which is rendered inline too. `colorType` sanitises
  // the type itself.
  const status = node.status ? chalk.dim(` [${sanitizeForTerminal(node.status)}]`) : ''
  return `${indent}${colorType(node.type)}  ${chalk.white(`"${sanitizeForTerminal(node.title)}"`)}${status}`
}

/** Format an entity count table */
export function formatCountTable(counts: Record<string, number>): string {
  const sorted = Object.entries(counts).sort((a, b) => b[1] - a[1])
  const maxType = Math.max(...sorted.map(([t]) => t.length), 4)
  const lines = sorted.map(([type, count]) =>
    `  ${colorType(type).padEnd(maxType + 10)}  ${chalk.bold(String(count).padStart(4))}`
  )
  return lines.join('\n')
}

/**
 * Render a Unicode tree with colors.
 *
 * DAG-honest: a UPG graph is a DAG, so a node can be reached by several paths.
 * Each node's subtree is rendered EXACTLY ONCE (under its first occurrence in
 * traversal order); every later occurrence renders as a dimmed reference
 * (`↗ shown above`) with no children. This is the fix for the duplicate
 * explosion (a shared subtree re-rendered in full under each parent), and it
 * makes cycles terminate for free (the second visit is a reference, not a
 * recursion). Mirrors the server `assembleTree` shared-node model.
 */
export function renderTree(
  roots: UPGBaseNode[],
  childrenOf: (id: string) => UPGBaseNode[],
  maxDepth = 10
): string {
  const lines: string[] = []
  const seen = new Set<string>()

  function walk(node: UPGBaseNode, prefix: string, isLast: boolean, depth: number) {
    const connector = depth === 0 ? '' : isLast ? '└── ' : '├── '
    const status = node.status ? chalk.dim(` [${sanitizeForTerminal(node.status)}]`) : ''
    const shared = seen.has(node.id)
    const marker = shared ? chalk.dim(' ↗ shown above') : ''
    lines.push(`${chalk.dim(prefix + connector)}${colorType(node.type)}  ${chalk.white(`"${sanitizeForTerminal(node.title)}"`)}${status}${marker}`)

    if (shared) return // referenced once already; do not re-expand its subtree
    seen.add(node.id)
    if (depth >= maxDepth) return
    const children = childrenOf(node.id)
    const childPrefix = depth === 0 ? '' : prefix + (isLast ? '    ' : chalk.dim('│   '))
    children.forEach((child, i) => {
      walk(child, childPrefix, i === children.length - 1, depth + 1)
    })
  }

  roots.forEach((root, i) => walk(root, '', i === roots.length - 1, 0))
  return lines.join('\n')
}

/** The minimal nested shape `renderAssembledTree` consumes (an `assembleTree` TreeNode). */
export interface RenderableTreeNode {
  type: string
  title: string
  status?: string
  shared?: boolean
  children: RenderableTreeNode[]
}

/**
 * Render an already-assembled nested forest (the output of `assembleTree`, used
 * by `tree --pattern`). The structure is pre-deduped: a `shared` node carries the
 * `↗ shown above` marker and no children, so this walk does not need its own
 * visited set. Styling matches `renderTree`.
 */
export function renderAssembledTree(roots: RenderableTreeNode[]): string {
  const lines: string[] = []

  function walk(node: RenderableTreeNode, prefix: string, isLast: boolean, depth: number) {
    const connector = depth === 0 ? '' : isLast ? '└── ' : '├── '
    const status = node.status ? chalk.dim(` [${sanitizeForTerminal(node.status)}]`) : ''
    const marker = node.shared ? chalk.dim(' ↗ shown above') : ''
    lines.push(`${chalk.dim(prefix + connector)}${colorType(node.type)}  ${chalk.white(`"${sanitizeForTerminal(node.title)}"`)}${status}${marker}`)
    if (node.shared || node.children.length === 0) return
    const childPrefix = depth === 0 ? '' : prefix + (isLast ? '    ' : chalk.dim('│   '))
    node.children.forEach((child, i) => {
      walk(child, childPrefix, i === node.children.length - 1, depth + 1)
    })
  }

  roots.forEach((root, i) => walk(root, '', i === roots.length - 1, 0))
  return lines.join('\n')
}

/** Score bar with color: ●●●●●○○○○○ */
export function scoreBar(score: number, max = 100, width = 10): string {
  const filled = Math.round((score / max) * width)
  const color = score >= 70 ? chalk.green : score >= 40 ? chalk.yellow : chalk.red
  return color('●'.repeat(filled)) + chalk.dim('○'.repeat(width - filled))
}

/** Color-code a score */
export function scoreColor(score: number): string {
  if (score >= 70) return chalk.bold.green(String(score))
  if (score >= 40) return chalk.bold.yellow(String(score))
  return chalk.bold.red(String(score))
}

/** Success message */
export function success(msg: string): string {
  return chalk.green('✓') + ' ' + msg
}

/** Error message */
export function fail(msg: string): string {
  return chalk.red('✗') + ' ' + msg
}

/** Dim label */
export function label(msg: string): string {
  return chalk.dim(msg)
}

/** Bold heading */
export function heading(msg: string): string {
  return chalk.bold(msg)
}

/**
 * Help-drift guard.
 *
 * The CLI renders `--help` from a hand-maintained `helpTopics` table
 * (lib/help.ts), NOT from each command's own Commander `.option()` definitions.
 * That divorce is a silent drift surface: adding a flag to a command leaves its
 * `--help` text stale, and nothing catches it. (This is exactly how `tree
 * --pattern` shipped without help text.)
 *
 * This test closes the gap structurally. It iterates the SAME registry cli.ts
 * builds the program from (ALL_COMMANDS) and asserts, for every command:
 *   (a) it has a helpTopics entry, and
 *   (b) every long flag it actually declares is documented in that entry, and
 *   (c) if it dispatches subcommands, each subcommand name is mentioned.
 *
 * So a new command (or a new option) cannot escape help coverage: this guard
 * fails until the help block is updated.
 */

import { describe, it, expect } from 'vitest'
import type { Command } from 'commander'
import { UPG_TREE_PATTERNS } from '@unified-product-graph/core'
import { ALL_COMMANDS } from '../lib/command-registry.js'
import { helpTopics } from '../lib/help.js'

/** Does `text` mention `flag` as a whole token (not a prefix of a longer flag)? */
function mentionsFlag(text: string, flag: string): boolean {
  const escaped = flag.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  // Boundary before: start, whitespace, comma, slash, or open-paren.
  // Boundary after: not a word char or hyphen, so `--from` does not match
  // inside `--from-id`.
  return new RegExp(`(^|[\\s,(/])${escaped}(?![\\w-])`).test(text)
}

/** The long flags a command actually declares on itself (not its subcommands). */
function declaredLongFlags(cmd: Command): string[] {
  return cmd.options
    .map((o) => o.long)
    .filter((l): l is string => Boolean(l))
}

describe('help is in sync with command definitions (drift guard)', () => {
  for (const cmd of ALL_COMMANDS) {
    const name = cmd.name()

    it(`\`${name}\` has a help topic`, () => {
      expect(
        helpTopics[name],
        `command "${name}" is registered in ALL_COMMANDS but has no helpTopics entry in lib/help.ts. ` +
          `Add one so \`upg ${name} --help\` shows structured help.`,
      ).toBeDefined()
    })

    it(`\`${name}\` documents every option it declares`, () => {
      const entry = helpTopics[name]
      if (!entry) return // covered by the topic-existence test above
      const documented = entry.options.map((o) => o.flag).join('  ')
      const declared = declaredLongFlags(cmd)
      const missing = declared.filter((long) => !mentionsFlag(documented, long))
      expect(
        missing,
        `command "${name}" declares ${missing.join(', ')} but lib/help.ts does not document ${
          missing.length === 1 ? 'it' : 'them'
        }. ` + `Add to helpTopics["${name}"].options.`,
      ).toEqual([])
    })

    if (cmd.commands.length > 0) {
      it(`\`${name}\` mentions each of its subcommands`, () => {
        const entry = helpTopics[name]
        if (!entry) return
        const blob = [
          entry.usage,
          entry.summary,
          ...entry.examples.map((e) => e.cmd + ' ' + (e.comment ?? '')),
        ].join('  ')
        const subs = cmd.commands.map((c) => c.name())
        const missing = subs.filter((s) => !blob.includes(s))
        expect(
          missing,
          `command "${name}" has subcommands ${missing.join(', ')} not mentioned anywhere in its help block. ` +
            `Reference them in helpTopics["${name}"].usage / summary / examples.`,
        ).toEqual([])
      })
    }
  }

  it('every helpTopics entry maps to a registered command (no orphan topics)', () => {
    const registered = new Set(ALL_COMMANDS.map((c) => c.name()))
    const orphans = Object.keys(helpTopics).filter((k) => !registered.has(k))
    expect(
      orphans,
      `helpTopics has entries with no matching command: ${orphans.join(', ')}. ` +
        `Remove them or register the command.`,
    ).toEqual([])
  })

  // `tree --pattern` help spells out the valid pattern ids as prose. Like the
  // server tool descriptions, that list is hand-maintained and drifts when a
  // pattern is added to the catalogue. Pin it to UPG_TREE_PATTERNS so a
  // forgotten id fails here instead of shipping stale `upg tree --help`.
  it('tree --pattern help lists every catalogue pattern id', () => {
    const tree = helpTopics['tree']
    expect(tree, 'no helpTopics entry for tree').toBeDefined()
    const patternOpt = tree.options.find((o) => o.flag.startsWith('--pattern'))
    expect(patternOpt, 'tree has no --pattern option documented').toBeDefined()
    const missing = UPG_TREE_PATTERNS.map((p) => p.id).filter((id) => !patternOpt!.desc.includes(id))
    expect(missing, `tree --pattern help omits pattern id(s): ${missing.join(', ')}`).toEqual([])
  })
})

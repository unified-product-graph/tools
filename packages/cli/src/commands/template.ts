/**
 * Template command group: browse the curated starter templates.
 *
 * Read-only over @unified-product-graph/templates (via the SDK access layer).
 * The same data powers the /upg-new-from-template skill and the site gallery,
 * so the CLI, MCP, and site never diverge.
 *
 * Subcommands:
 *   list [industry]   - list template summaries (list_templates), --stage filter
 *   show <id>         - full template payload: entities, typed edges, prompts (get_template)
 */
import { Command } from 'commander'
import { listTemplates, getTemplate } from '@unified-product-graph/sdk'
import { die, usageError } from '../lib/errors.js'
import { upgHeader, label } from '../lib/formatter.js'
import { sanitizeForTerminal } from '../lib/sanitize.js'
import chalk from 'chalk'

const clean = (s: string): string => sanitizeForTerminal(s)

// ── list ─────────────────────────────────────────────────────────────────────

const listCmd = new Command('list')
  .description('List the curated starter templates.')
  .argument('[industry]', 'Filter by industry (saas, marketplace, mobile, oss, agency)')
  .option('--stage <stage>', 'Filter by stage (concept, validation, growth, mature)')
  .option('--json', 'Machine-readable JSON output')
  .action((industry: string | undefined, opts: { stage?: string; json?: boolean }) => {
    try {
      const rows = listTemplates({ industry, stage: opts.stage })
      if (opts.json) {
        process.stdout.write(JSON.stringify(rows, null, 2) + '\n')
        return
      }
      console.log(upgHeader('Templates'))
      if (rows.length === 0) {
        console.log(chalk.dim('  No templates match that filter.'))
        console.log()
        return
      }
      let lastIndustry = ''
      for (const t of rows) {
        const ind = t.industries[0] ?? ''
        if (ind !== lastIndustry) {
          console.log()
          console.log(label(`  ${clean(ind)}`))
          lastIndustry = ind
        }
        const stageStr = t.stages.length === 1 ? t.stages[0] : `${t.stages[0]} → ${t.stages[t.stages.length - 1]}`
        console.log(`    ${chalk.white(clean(t.id))}  ${chalk.dim(`[${clean(stageStr)}]`)}`)
        console.log(`      ${chalk.dim(clean(t.name))}`)
        console.log(`      ${chalk.dim(`${t.entity_count} entities: ${t.entity_types.map(clean).join(', ')}`)}`)
      }
      console.log()
      console.log(chalk.dim('  Run `upg template show <id>` for the full pattern.'))
      console.log()
    } catch (err) {
      die(err)
    }
  })

// ── show ─────────────────────────────────────────────────────────────────────

const showCmd = new Command('show')
  .description('Show a template in full: entities, typed edges, and prompts.')
  .argument('<id>', 'Template id (e.g. saas-business-model)')
  .option('--json', 'Machine-readable JSON output')
  .action((id: string, opts: { json?: boolean }) => {
    try {
      const tpl = getTemplate(id)
      if (!tpl) {
        throw usageError(`Unknown template: ${id}. Run \`upg template list\` to see the options.`)
      }
      if (opts.json) {
        process.stdout.write(JSON.stringify(tpl, null, 2) + '\n')
        return
      }
      console.log(upgHeader(`Template - ${clean(tpl.name)}`))
      console.log(`  ${chalk.dim(clean(tpl.description))}`)
      console.log()
      console.log(label('  industries: ') + chalk.white(tpl.industries.map(clean).join(', ')))
      console.log(label('  stages:     ') + chalk.white(tpl.stages.map(clean).join(', ')))
      console.log()
      console.log(label(`  Entities (${tpl.entities.length})`))
      tpl.entities.forEach((e, i) => {
        console.log(`    ${chalk.dim(`${i}.`)} ${chalk.white(clean(e.type))}  ${chalk.dim(clean(e.title_template))}`)
      })
      const edges = tpl.edges ?? []
      console.log()
      console.log(label(`  Connections (${edges.length})`))
      for (const ed of edges) {
        const s = tpl.entities[ed.source_index]?.type ?? '?'
        const t = tpl.entities[ed.target_index]?.type ?? '?'
        console.log(`    ${chalk.dim(`${s} → ${t}`)}  ${chalk.white(clean(ed.type))}`)
      }
      const prompts = Object.entries(tpl.prompts ?? {})
      if (prompts.length > 0) {
        console.log()
        console.log(label(`  Prompts (${prompts.length})`))
        for (const [key, q] of prompts) {
          console.log(`    ${chalk.white(`{{${clean(key)}}}`)}  ${chalk.dim(clean(q))}`)
        }
      }
      console.log()
      console.log(chalk.dim('  Run `/upg-new-from-template` in Claude Code to instantiate this with your details.'))
      console.log()
    } catch (err) {
      die(err)
    }
  })

// ── parent command ────────────────────────────────────────────────────────────

export const templateCommand = new Command('template')
  .description('Browse the curated starter templates (list, show).')
  .addCommand(listCmd)
  .addCommand(showCmd)
  .action(() => {
    console.log(upgHeader('Templates'))
    console.log('  Subcommands:')
    console.log()
    console.log('    list [industry]   List the curated starter templates (--stage to filter)')
    console.log('    show <id>         Show a template in full: entities, typed edges, prompts')
    console.log()
    console.log(chalk.dim('  The same templates power /upg-new-from-template and the site gallery.'))
    console.log()
  })

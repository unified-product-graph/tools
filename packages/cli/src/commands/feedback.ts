/**
 * `upg feedback` — CREW-INTERNAL triage client (hidden command).
 *
 * A thin authenticated HTTP client over the admin API on unifiedproductgraph.org
 * (GET /api/feedback list + get, PATCH /api/feedback/:id). The laptop holds only
 * the token; the server owns the DB creds.
 *
 * DELIBERATELY HIDDEN: this command is NOT in ALL_COMMANDS, NOT in the CLI help
 * catalogue (lib/help.ts helpTopics), NOT in the top-level `upg --help` menu,
 * and NOT in the public site CLI reference. It is registered directly on the
 * program with Commander's `{ hidden: true }` so consumers never see it. Do not
 * add it to any of those surfaces — it is for maintainers only.
 *
 * Env:
 *   UPG_FEEDBACK_ADMIN_TOKEN   required — the admin bearer token
 *   UPG_FEEDBACK_API_URL       optional — base URL (default https://unifiedproductgraph.org)
 */

import { Command } from 'commander'
import chalk from 'chalk'

const DEFAULT_BASE = 'https://unifiedproductgraph.org'

function baseUrl(): string {
  return (process.env.UPG_FEEDBACK_API_URL || DEFAULT_BASE).replace(/\/$/, '')
}

function requireToken(): string {
  const token = process.env.UPG_FEEDBACK_ADMIN_TOKEN
  if (!token) {
    console.error(
      chalk.red('UPG_FEEDBACK_ADMIN_TOKEN is not set.') +
        ' This is a crew-internal command; export the admin token first.',
    )
    process.exit(1)
  }
  return token
}

async function api(
  method: 'GET' | 'PATCH',
  path: string,
  body?: unknown,
): Promise<unknown> {
  const token = requireToken()
  let res: Response
  try {
    res = await fetch(`${baseUrl()}${path}`, {
      method,
      headers: {
        authorization: `Bearer ${token}`,
        ...(body ? { 'content-type': 'application/json' } : {}),
      },
      ...(body ? { body: JSON.stringify(body) } : {}),
    })
  } catch (err) {
    console.error(chalk.red(`Network error reaching ${baseUrl()}: ${(err as Error).message}`))
    process.exit(1)
  }

  if (res.status === 404) {
    // The admin surface answers 404 to unauthorized callers to stay invisible.
    console.error(
      chalk.red('404 from the triage API.') +
        ' Either the admin token is wrong, or the item id does not exist.',
    )
    process.exit(1)
  }
  const text = await res.text()
  let json: unknown = null
  try {
    json = text ? JSON.parse(text) : null
  } catch {
    /* non-JSON body */
  }
  if (!res.ok) {
    const msg = (json as { error?: string })?.error ?? text ?? `HTTP ${res.status}`
    console.error(chalk.red(`Request failed (${res.status}): ${msg}`))
    process.exit(1)
  }
  return json
}

const STATUS_COLOR: Record<string, (s: string) => string> = {
  new: chalk.blueBright,
  triaged: chalk.yellow,
  accepted: chalk.green,
  in_progress: chalk.magenta,
  shipped: chalk.greenBright,
  declined: chalk.gray,
  duplicate: chalk.gray,
}

interface FeedbackRow {
  id: string
  type: string
  title: string
  description?: string | null
  status: string
  priority?: string | null
  assignee?: string | null
  internal_notes?: string | null
  resolution?: string | null
  linked_issue?: string | null
  client?: string | null
  details?: Record<string, unknown> | null
  context?: Record<string, unknown> | null
  created_at?: string
  resolved_at?: string | null
}

function fmtStatus(status: string): string {
  return (STATUS_COLOR[status] ?? chalk.white)(status)
}

function printRow(r: FeedbackRow): void {
  const pri = r.priority ? chalk.dim(`[${r.priority}] `) : ''
  const issue = r.linked_issue ? chalk.cyan(` (${r.linked_issue})`) : ''
  console.log(
    `  ${chalk.dim(r.id.slice(0, 8))}  ${fmtStatus(r.status).padEnd(20)} ${pri}${chalk.bold(
      r.type,
    )}  ${r.title}${issue}`,
  )
}

// ── list ─────────────────────────────────────────────────────────────────────
const listCmd = new Command('list')
  .description('List feedback (newest first). Filters: --status --type --priority --since --limit.')
  .option('--status <status>', 'new | triaged | accepted | in_progress | shipped | declined | duplicate')
  .option('--type <type>', 'bug | feature_request | observation | general')
  .option('--priority <priority>', 'p0 | p1 | p2 | p3')
  .option('--since <iso>', 'Only items created on/after this ISO date')
  .option('--limit <n>', 'Max rows (default 50, max 200)')
  .option('--json', 'Machine-readable JSON output')
  .action(async (opts: {
    status?: string
    type?: string
    priority?: string
    since?: string
    limit?: string
    json?: boolean
  }) => {
    const qs = new URLSearchParams()
    if (opts.status) qs.set('status', opts.status)
    if (opts.type) qs.set('type', opts.type)
    if (opts.priority) qs.set('priority', opts.priority)
    if (opts.since) qs.set('since', opts.since)
    if (opts.limit) qs.set('limit', opts.limit)
    const q = qs.toString()
    const data = (await api('GET', `/api/feedback${q ? `?${q}` : ''}`)) as {
      count: number
      feedback: FeedbackRow[]
    }
    if (opts.json) {
      console.log(JSON.stringify(data, null, 2))
      return
    }
    if (!data.feedback?.length) {
      console.log(chalk.dim('  No feedback matches.'))
      return
    }
    console.log(chalk.bold(`\n  ${data.count} item${data.count === 1 ? '' : 's'}\n`))
    for (const r of data.feedback) printRow(r)
    console.log()
  })

// ── show ─────────────────────────────────────────────────────────────────────
const showCmd = new Command('show')
  .description('Show one feedback item in full (details + context).')
  .argument('<id>', 'Feedback id')
  .option('--json', 'Machine-readable JSON output')
  .action(async (id: string, opts: { json?: boolean }) => {
    const data = (await api('GET', `/api/feedback?id=${encodeURIComponent(id)}`)) as {
      feedback: FeedbackRow
    }
    const r = data.feedback
    if (opts.json) {
      console.log(JSON.stringify(r, null, 2))
      return
    }
    console.log()
    console.log(`  ${chalk.bold(r.title)}`)
    console.log(`  ${chalk.dim(r.id)}`)
    console.log()
    console.log(`  ${chalk.dim('type')}      ${r.type}`)
    console.log(`  ${chalk.dim('status')}    ${fmtStatus(r.status)}`)
    if (r.priority) console.log(`  ${chalk.dim('priority')}  ${r.priority}`)
    if (r.assignee) console.log(`  ${chalk.dim('assignee')}  ${r.assignee}`)
    if (r.linked_issue) console.log(`  ${chalk.dim('issue')}     ${chalk.cyan(r.linked_issue)}`)
    if (r.client) console.log(`  ${chalk.dim('client')}    ${r.client}`)
    if (r.created_at) console.log(`  ${chalk.dim('created')}   ${r.created_at}`)
    if (r.description) {
      console.log(`\n  ${chalk.dim('description')}\n    ${r.description.replace(/\n/g, '\n    ')}`)
    }
    if (r.details && Object.keys(r.details).length) {
      console.log(`\n  ${chalk.dim('details')}`)
      for (const [k, v] of Object.entries(r.details)) console.log(`    ${chalk.dim(k)}: ${String(v)}`)
    }
    if (r.internal_notes) console.log(`\n  ${chalk.dim('notes')}\n    ${r.internal_notes}`)
    if (r.resolution) console.log(`\n  ${chalk.dim('resolution')}\n    ${r.resolution}`)
    console.log()
  })

// ── set ──────────────────────────────────────────────────────────────────────
const setCmd = new Command('set')
  .description('Update a feedback item: --status --priority --assignee --notes --resolution --issue.')
  .argument('<id>', 'Feedback id')
  .option('--status <status>', 'new | triaged | accepted | in_progress | shipped | declined | duplicate')
  .option('--priority <priority>', 'p0 | p1 | p2 | p3')
  .option('--assignee <who>', 'Crew officer')
  .option('--notes <text>', 'Internal triage notes')
  .option('--resolution <text>', 'How it was closed')
  .option('--issue <ref>', 'Linked Linear/GitHub issue (e.g.)')
  .option('--json', 'Machine-readable JSON output')
  .action(async (id: string, opts: {
    status?: string
    priority?: string
    assignee?: string
    notes?: string
    resolution?: string
    issue?: string
    json?: boolean
  }) => {
    const patch: Record<string, unknown> = {}
    if (opts.status !== undefined) patch.status = opts.status
    if (opts.priority !== undefined) patch.priority = opts.priority
    if (opts.assignee !== undefined) patch.assignee = opts.assignee
    if (opts.notes !== undefined) patch.internal_notes = opts.notes
    if (opts.resolution !== undefined) patch.resolution = opts.resolution
    if (opts.issue !== undefined) patch.linked_issue = opts.issue

    if (Object.keys(patch).length === 0) {
      console.error(
        chalk.red('Nothing to set.') +
          ' Pass at least one of --status, --priority, --assignee, --notes, --resolution, --issue.',
      )
      process.exit(1)
    }

    const data = (await api('PATCH', `/api/feedback/${encodeURIComponent(id)}`, patch)) as {
      feedback: FeedbackRow
    }
    if (opts.json) {
      console.log(JSON.stringify(data.feedback, null, 2))
      return
    }
    console.log(chalk.green('  Updated.'))
    printRow(data.feedback)
  })

/**
 * The hidden crew command. Registered on the program via
 * `program.addCommand(feedbackCommand, { hidden: true })` in cli.ts.
 */
export const feedbackCommand = new Command('feedback')
  .description('[crew] Triage the UPG feedback queue (admin-gated).')
  .addCommand(listCmd)
  .addCommand(showCmd)
  .addCommand(setCmd)

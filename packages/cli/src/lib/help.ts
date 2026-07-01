/**
 * Structured per-command help (CLI-FEEDBACK #1 / design-spec S2).
 *
 * Each entry has a synopsis, a flag table, 2-3 runnable examples, and a
 * "See also" line. `interceptHelp` in cli.ts renders these BEFORE any command
 * action runs, so `upg <cmd> --help` is always safe and informative.
 *
 * Keyed by the command's registered name so the help interceptor and the
 * help-safety regression test can resolve any command to its block.
 */

export interface HelpOption {
  flag: string
  desc: string
}

export interface HelpExample {
  cmd: string
  comment?: string
}

export interface HelpEntry {
  usage: string
  summary: string
  options: HelpOption[]
  examples: HelpExample[]
  seeAlso?: string
}

const FILE_OPT: HelpOption = { flag: '--file <path>', desc: 'Target a specific .upg file (else UPG_FILE, else discovered)' }
const JSON_OPT: HelpOption = { flag: '--json', desc: 'Machine-readable JSON output' }

export const helpTopics: Record<string, HelpEntry> = {
  // ── Tier-1 "ceiling" verbs ──────────────────────────────────────
  use: {
    usage: 'upg use [lens] [options]',
    summary: 'Set the sticky operating lens (scopes vocabulary). No arg shows the current lens. Session-local.',
    options: [
      FILE_OPT, JSON_OPT,
      { flag: '--clear', desc: 'Reset to the full (unfiltered) lens' },
    ],
    examples: [
      { cmd: 'upg use ux_design', comment: 'speak the UX/design vocabulary' },
      { cmd: 'upg use', comment: 'show current lens + available' },
      { cmd: 'upg use --clear' },
    ],
    seeAlso: 'upg here, upg ls',
  },
  here: {
    usage: 'upg here [options]',
    summary: 'Show where the cursor stands (the current node) and the active lens. Session-local.',
    options: [
      FILE_OPT, JSON_OPT,
      { flag: '--clear', desc: 'Reset the cursor to root (nowhere)' },
    ],
    examples: [
      { cmd: 'upg here' },
      { cmd: 'upg here --json' },
    ],
    seeAlso: 'upg at, upg ls, upg find',
  },
  at: {
    usage: 'upg at <node> [options]',
    summary: 'Move the cursor to a node, resolved by id or title. Session-local.',
    options: [FILE_OPT, JSON_OPT],
    examples: [
      { cmd: 'upg at "Busy Parent"', comment: 'resolve by title' },
      { cmd: 'upg at n_abc123' },
    ],
    seeAlso: 'upg here, upg find, upg ls',
  },
  ls: {
    usage: 'upg ls [options]',
    summary: "List the cursor's neighbours grouped by relationship (as verbs), plus a \"next here\" hint.",
    options: [
      FILE_OPT, JSON_OPT,
      { flag: '--at <id>', desc: "List a node's neighbours statelessly (ignores the cursor)" },
    ],
    examples: [
      { cmd: 'upg ls', comment: 'neighbours of the cursor' },
      { cmd: 'upg ls --at n_abc --json' },
    ],
    seeAlso: 'upg here, upg new',
  },
  find: {
    usage: 'upg find <query> [options]',
    summary: 'Fuzzy search. On a TTY, pick a result to move the cursor there; on a pipe, list only.',
    options: [
      FILE_OPT, JSON_OPT,
      { flag: '--type <type>', desc: 'Filter results by entity type' },
      { flag: '--no-pick', desc: 'List only; never move the cursor' },
    ],
    examples: [
      { cmd: 'upg find "busy parent"', comment: 'land the cursor on a match' },
      { cmd: 'upg find login --json' },
    ],
    seeAlso: 'upg at, upg search',
  },
  new: {
    usage: 'upg new <type> <title> [options]',
    summary: 'Create a node and auto-link it to the cursor (edge type + direction inferred). No --parent needed.',
    options: [
      FILE_OPT, JSON_OPT,
      { flag: '--at <id>', desc: 'Link to this node instead of the cursor (stateless)' },
      { flag: '--as <verb|n>', desc: 'Pick the relationship on an ambiguous pair' },
      { flag: '--status <status>', desc: 'Lifecycle status' },
    ],
    examples: [
      { cmd: 'upg new need "Decide dinner in <2 min"', comment: 'created + linked to the cursor' },
      { cmd: 'upg new feature "Planner" --at n_persona --json' },
      { cmd: 'upg new persona -- "--draft"', comment: 'use -- so a flag-like title is a title, not a flag' },
    ],
    seeAlso: 'upg link, upg create',
  },
  link: {
    usage: 'upg link <a> <b> [options]',
    summary: 'Connect two nodes; edge type + direction inferred and auto-flipped to canonical. Prompts only on ambiguity.',
    options: [
      FILE_OPT, JSON_OPT,
      { flag: '--as <verb|n>', desc: 'Pick the relationship on an ambiguous pair' },
    ],
    examples: [
      { cmd: 'upg link "Busy Parent" "Plan dinner"', comment: 'infers persona_pursues_job' },
      { cmd: 'upg link n_metric1 n_metric2 --as drives' },
    ],
    seeAlso: 'upg new, upg connect',
  },
  check: {
    usage: 'upg check [options]',
    summary: 'One ranked verdict: structure validity + health + gaps + anti-pattern lint. Exit 2 on violations (structure invalid OR any high-severity anti-pattern). Use --structure-only to gate on spec-conformance alone.',
    options: [
      FILE_OPT, JSON_OPT,
      { flag: '--ci', desc: 'CI mode: JSON output, strict exit contract' },
      { flag: '--structure-only', desc: 'Gate the exit code on structural validity alone; anti-patterns are reported but do not fail the run' },
    ],
    examples: [
      { cmd: 'upg check' },
      { cmd: 'upg check --ci', comment: 'pipeline gate' },
      { cmd: 'upg check --structure-only --ci', comment: 'spec-conformance gate (ignores health)' },
    ],
    seeAlso: 'upg fix, upg verify, upg health',
  },
  fix: {
    usage: 'upg fix [options]',
    summary: 'Address the top finding from check. Auto-remediable fixes run with confirmation; guided fixes print the step (never fabricated).',
    options: [
      FILE_OPT, JSON_OPT,
      { flag: '--yes, -y', desc: 'Skip confirmation (required for non-interactive auto-fixes)' },
    ],
    examples: [
      { cmd: 'upg fix', comment: 'show / run the top remediation' },
      { cmd: 'upg fix --yes --json' },
    ],
    seeAlso: 'upg check',
  },
  health: {
    usage: 'upg health [options]',
    summary: 'Score the graph 0-100 with a domain/chain dashboard. Gate CI with --min-score (exit 2 if below).',
    options: [
      FILE_OPT, JSON_OPT,
      { flag: '--min-score <n>', desc: 'Exit 2 if the score is below this threshold' },
      { flag: '--format <fmt>', desc: 'text | badge. Defaults to text' },
      { flag: '--watch', desc: 'Live dashboard; re-renders on file change' },
    ],
    examples: [
      { cmd: 'upg health', comment: 'human dashboard' },
      { cmd: 'upg health --json | jq .score', comment: 'just the score' },
      { cmd: 'upg health --min-score 70', comment: 'CI gate' },
    ],
    seeAlso: 'upg verify, upg gaps',
  },
  verify: {
    usage: 'upg verify [options]',
    summary: 'Structural validation. Exits 2 on violations (great for CI gates), 0 when clean.',
    options: [
      FILE_OPT, JSON_OPT,
      { flag: '--no-orphans', desc: 'Fail when orphan entities exist' },
      { flag: '--no-broken-chains', desc: 'Fail when any chain is incomplete' },
      { flag: '--no-content-depth', desc: 'Skip property-type, enum, and self-loop checks' },
      { flag: '--max-orphan-rate <n>', desc: 'Maximum orphan rate, 0.0-1.0' },
      { flag: '--require-domains <list>', desc: 'Comma-separated domains that must hold entities' },
    ],
    examples: [
      { cmd: 'upg verify', comment: 'fail on dangling edges / broken chains' },
      { cmd: 'upg verify --max-orphan-rate 0.1' },
      { cmd: 'upg verify --json' },
    ],
    seeAlso: 'upg health, upg fmt --check',
  },
  diff: {
    usage: 'upg diff [options]',
    summary: 'Compare the working .upg against a git ref. Designed for PR reviews.',
    options: [
      FILE_OPT, JSON_OPT,
      { flag: '--since <ref>', desc: 'Git ref to compare against. Defaults to HEAD~1' },
      { flag: '--summary', desc: 'One line per change' },
      { flag: '--stat', desc: 'Counts only, like git diff --stat' },
    ],
    examples: [
      { cmd: 'upg diff', comment: 'vs HEAD~1' },
      { cmd: 'upg diff --since main' },
      { cmd: 'upg diff --json' },
    ],
    seeAlso: 'upg verify',
  },
  list: {
    usage: 'upg list [options]',
    summary: 'Query entities from the graph by type, status, parent, or orphan state.',
    options: [
      FILE_OPT, JSON_OPT,
      { flag: '--type <type>', desc: 'Filter by entity type' },
      { flag: '--status <status>', desc: 'Filter by status' },
      { flag: '--orphans', desc: 'Restrict to disconnected entities' },
      { flag: '--parent <id>', desc: 'Restrict to children of a node' },
      { flag: '--count', desc: 'Print the count only' },
    ],
    examples: [
      { cmd: 'upg list --type persona' },
      { cmd: 'upg list --orphans --count' },
      { cmd: 'upg list --json | jq -r ".[].id"' },
    ],
    seeAlso: 'upg search, upg tree',
  },
  tree: {
    usage: 'upg tree [filter] [options]',
    summary: 'Tree view of the graph: filter by entity type or domain, or assemble a named framework pattern. --json emits the nested structure.',
    options: [
      FILE_OPT, JSON_OPT,
      { flag: '--pattern <id>', desc: 'Assemble a named tree pattern: ost, okr, user, product, validation, strategy, feature_areas, delivery, architecture, journey, design_system, commercial, north_star, org' },
      { flag: '--id <id>', desc: 'Subtree rooted at a specific node' },
      { flag: '--depth <n>', desc: 'Maximum depth. Defaults to 10' },
    ],
    examples: [
      { cmd: 'upg tree' },
      { cmd: 'upg tree persona --depth 3' },
      { cmd: 'upg tree --pattern okr', comment: 'objective to key_result to metric' },
      { cmd: 'upg tree --pattern strategy', comment: 'the bets cascade, with gaps' },
      { cmd: 'upg tree --json' },
    ],
    seeAlso: 'upg list, upg spec',
  },
  search: {
    usage: 'upg search <query> [options]',
    summary: 'Fuzzy text search across titles and descriptions.',
    options: [
      FILE_OPT, JSON_OPT,
      { flag: '--type <type>', desc: 'Filter results by entity type' },
    ],
    examples: [
      { cmd: 'upg search onboarding' },
      { cmd: 'upg search "weeknight" --type job' },
      { cmd: 'upg search login --json' },
    ],
    seeAlso: 'upg list',
  },
  create: {
    usage: 'upg create <type> <title> [options]',
    summary: 'Create an entity. Type is validated against the spec; --status is validated against the entity lifecycle.',
    options: [
      FILE_OPT, JSON_OPT,
      { flag: '--parent <id>', desc: 'Parent node ID. Auto-creates an edge' },
      { flag: '--status <status>', desc: 'Lifecycle status (validated against the type)' },
      { flag: '--data <json>', desc: 'Type-specific fields as JSON' },
      { flag: '--tags <list>', desc: 'Comma-separated tags' },
    ],
    examples: [
      { cmd: 'upg create persona "Busy Parent"' },
      { cmd: 'upg create feature "Meal planner" --parent n_abc --json', comment: 'capture the new id from JSON' },
      { cmd: 'ID=$(upg create job "Plan dinner" --json | jq -r .node.id)' },
      { cmd: 'upg create persona -- "--draft"', comment: 'use -- so a flag-like title is a title, not a flag' },
    ],
    seeAlso: 'upg connect, upg update',
  },
  update: {
    usage: 'upg update <id> [options]',
    summary: 'Update an entity. Unspecified fields are preserved; --status is validated against the lifecycle.',
    options: [
      FILE_OPT, JSON_OPT,
      { flag: '--title <title>', desc: 'New title' },
      { flag: '--description <desc>', desc: 'New description' },
      { flag: '--status <status>', desc: 'New status (validated against the type)' },
      { flag: '--tags <list>', desc: 'Comma-separated tags. Replaces existing' },
      { flag: '--data <json>', desc: 'Type-specific fields as JSON. Merged' },
    ],
    examples: [
      { cmd: 'upg update n_abc --status validated' },
      { cmd: 'upg update n_abc --title "New name" --json' },
      { cmd: 'upg update n_abc --tags core,mvp' },
    ],
    seeAlso: 'upg create, upg list',
  },
  delete: {
    usage: 'upg delete [id] [options]',
    summary: 'Delete an entity and its edges. Omit the id for an interactive picker (TTY only). Non-TTY requires --yes.',
    options: [
      FILE_OPT, JSON_OPT,
      { flag: '--type <type>', desc: 'Filter the interactive picker by type' },
      { flag: '--yes, -y', desc: 'Skip confirmation (required for non-interactive use)' },
      { flag: '--force', desc: 'Alias of --yes' },
    ],
    examples: [
      { cmd: 'upg delete n_abc', comment: 'interactive confirm' },
      { cmd: 'upg delete n_abc --yes', comment: 'scriptable' },
      { cmd: 'upg delete n_abc --yes --json', comment: 'reports node + cascaded edges' },
    ],
    seeAlso: 'upg list',
  },
  connect: {
    usage: 'upg connect <source-id> <target-id> [options]',
    summary: 'Create an edge between two nodes. Type is auto-inferred; incompatible pairs are rejected (exit 2).',
    options: [
      FILE_OPT, JSON_OPT,
      { flag: '--type <type>', desc: 'Edge type. Auto-inferred if omitted' },
      { flag: '--properties <json>', desc: 'Edge property bag as JSON (only for property-carrying edge types; unknown keys / off-scale values rejected)' },
    ],
    examples: [
      { cmd: 'upg connect n_persona n_job', comment: 'infers persona_pursues_job' },
      { cmd: 'upg connect n_a n_b --type relates_to' },
      { cmd: 'upg connect comp_x cv_tier --type node_classified_as_classification_value --properties \'{"confidence":{"value":3,"label":"medium"}}\'' },
      { cmd: 'upg connect n_a n_b --json' },
    ],
    seeAlso: 'upg create',
  },
  apply: {
    usage: 'upg apply <framework> [entity-ids...] [options]',
    summary: 'Run a framework over entities: creates a framework_exercise and an includes edge to each. The result lives on the edge, so the same entity can be scored in many exercises and any entity type can be scored.',
    options: [
      FILE_OPT, JSON_OPT,
      { flag: '--title <title>', desc: 'Human label for the exercise (default "<Framework> exercise")' },
      { flag: '--status <status>', desc: 'Lifecycle phase: draft | active | archived (default draft)' },
    ],
    examples: [
      { cmd: 'upg apply moscow feat_sso feat_dark --title "Q3 Release Scope"', comment: 'prints the exercise id' },
      { cmd: 'upg apply rice-scoring opp_onboarding', comment: 'an exercise can score any entity type' },
    ],
    seeAlso: 'upg score, upg list --type framework_exercise',
  },
  score: {
    usage: 'upg score <exercise-id> <entity-id> --data <json> [options]',
    summary: "Record a framework's result for one entity on the exercise's includes edge (a MoSCoW bucket, a RICE score). Auto-includes the entity if it is not yet in scope.",
    options: [
      FILE_OPT, JSON_OPT,
      { flag: '--data <json>', desc: 'Required. Result as JSON, e.g. \'{"moscow":"must"}\' or \'{"reach":4,"impact":3,"confidence":4,"effort":2}\'' },
      { flag: '--replace', desc: 'Replace the edge properties instead of merging into them' },
      { flag: '--slot-role <role>', desc: 'Framework slot role this entity plays (e.g. pain_reliever); rides the same edge as the result' },
    ],
    examples: [
      { cmd: 'upg score n_fx_q3 feat_sso --data \'{"moscow":"must"}\'' },
      { cmd: 'upg score n_fx_q3 feat_dark --data \'{"moscow":"could"}\'' },
    ],
    seeAlso: 'upg apply, upg show',
  },
  show: {
    usage: 'upg show <exercise> [options]',
    summary: 'Show a framework exercise: each included entity and the scores recorded on its edge, as a table.',
    options: [FILE_OPT, JSON_OPT],
    examples: [
      { cmd: 'upg show n_fx_q3', comment: 'by id' },
      { cmd: 'upg show "Q3 release scope"', comment: 'by title' },
      { cmd: 'upg show n_fx_q3 --json' },
    ],
    seeAlso: 'upg apply, upg score',
  },
  gaps: {
    usage: 'upg gaps [options]',
    summary: 'Surface empty domains, broken chains, and sparse areas.',
    options: [
      FILE_OPT, JSON_OPT,
      { flag: '--domain <domain>', desc: 'Focus on a specific domain' },
    ],
    examples: [
      { cmd: 'upg gaps' },
      { cmd: 'upg gaps --domain ux_design' },
      { cmd: 'upg gaps --json' },
    ],
    seeAlso: 'upg health, upg verify',
  },
  init: {
    usage: 'upg init [options]',
    summary: 'Create a .upg file. Interactive by default; fully flag-driven when scripted.',
    options: [
      { flag: '--title <title>', desc: 'Product title. Skips the prompt' },
      { flag: '--template <name>', desc: 'blank | saas | marketplace | mobile | oss' },
      { flag: '--workspace', desc: 'Create .upg/<name>.upg + workspace.json' },
      { flag: '--single', desc: 'Create product.upg in the current directory' },
      { flag: '--file <path>', desc: 'Explicit output path (overrides the single/workspace default; honours $UPG_FILE)' },
      { flag: '--force', desc: 'Overwrite an existing file' },
      { flag: '--yes', desc: 'Non-interactive: defaults for anything not set by a flag (template blank, mode single)' },
    ],
    examples: [
      { cmd: 'upg init' },
      { cmd: 'upg init --title "My App" --template saas --single' },
      { cmd: 'upg init --yes', comment: 'scriptable: accept all defaults' },
    ],
    seeAlso: 'upg workspace, upg mcp setup',
  },
  workspace: {
    usage: 'upg workspace [action] [items...]',
    summary: 'Workspace actions: list (default), switch <name>, rekind --kind <kind> <file...>.',
    options: [
      { flag: '--kind <kind>', desc: 'For rekind: product | org_rollup | watched | operating_function' },
      { flag: '--json', desc: 'Machine-readable JSON output (rekind)' },
    ],
    examples: [
      { cmd: 'upg workspace', comment: 'list products' },
      { cmd: 'upg workspace switch my-product' },
      { cmd: "upg workspace rekind --kind watched .upg/competitor-*.upg", comment: 'bulk set member_kind' },
    ],
    seeAlso: 'upg init --workspace, upg product update --member-kind',
  },
  import: {
    usage: 'upg import --from <tool> [options]',
    summary: 'Import product knowledge from Markdown, Notion, Linear, Vistaly, Dovetail, or GitHub.',
    options: [
      FILE_OPT,
      { flag: '--from <tool>', desc: 'markdown | notion | linear | vistaly | dovetail | github' },
      { flag: '--input <path>', desc: 'Source file or directory' },
      { flag: '--output <path>', desc: 'Output .upg path. Defaults to auto-discover or ./product.upg' },
      { flag: '--dry-run', desc: 'Preview without writing' },
      { flag: '--yes', desc: 'Skip confirmation prompts' },
    ],
    examples: [
      { cmd: 'upg import --from markdown --input ./docs' },
      { cmd: 'upg import --from github --dry-run' },
    ],
    seeAlso: 'upg export',
  },
  export: {
    usage: 'upg export [options]',
    summary: 'Export entities as JSON, Markdown, or CSV.',
    options: [
      FILE_OPT,
      { flag: '--format <fmt>', desc: 'json | md | csv. Defaults to json' },
      { flag: '--type <type>', desc: 'Filter by entity type' },
    ],
    examples: [
      { cmd: 'upg export', comment: 'JSON to stdout' },
      { cmd: 'upg export --format md > graph.md' },
      { cmd: 'upg export --format csv --type persona' },
    ],
    seeAlso: 'upg import, upg list --json',
  },
  fmt: {
    usage: 'upg fmt [files...] [options]',
    summary: 'Rewrite .upg files to canonical, byte-stable form. --check is a CI gate (exit 2 if not canonical).',
    options: [
      { flag: '--check', desc: 'Do not write; exit 2 if any file is not canonical' },
    ],
    examples: [
      { cmd: 'upg fmt', comment: 'format the discovered file in place' },
      { cmd: 'upg fmt .upg/*.upg' },
      { cmd: 'upg fmt --check .upg/*.upg', comment: 'CI gate' },
    ],
    seeAlso: 'upg verify',
  },
  'install-skills': {
    usage: 'upg install-skills [options]',
    summary: 'Install the bundled UPG skills into Claude Code (.claude/skills/).',
    options: [
      { flag: '--scope <scope>', desc: 'project | user. Defaults to project' },
      { flag: '--force', desc: 'Overwrite existing skill links' },
      { flag: '--mode <mode>', desc: 'auto (default), symlink, or copy. auto falls back to copy on Windows' },
      { flag: '--list', desc: 'Print skill names; skip the install' },
      { flag: '--remove', desc: 'Remove UPG skills recorded in the manifest' },
    ],
    examples: [
      { cmd: 'upg install-skills' },
      { cmd: 'upg install-skills --scope user' },
      { cmd: 'upg install-skills --list' },
    ],
    seeAlso: 'upg mcp setup',
  },
  mcp: {
    usage: 'upg mcp <setup|status|run> [options]',
    summary: 'Wire the UPG MCP server into Claude Code (setup), inspect config (status), or run the server (run).',
    options: [
      { flag: '--scope <scope>', desc: 'setup: project | user' },
      { flag: '--force', desc: 'setup: overwrite an existing entry' },
    ],
    examples: [
      { cmd: 'upg mcp setup', comment: 'one-time wiring' },
      { cmd: 'upg mcp status' },
    ],
    seeAlso: 'upg install-skills',
  },

  // ── Tool parity (CLI-next): the 0.9.x MCP surface as commands ──────────────
  spec: {
    usage: 'upg spec <noun> [id] [options]',
    summary:
      'Browse the UPG spec catalogue offline. No graph needed. Nouns: ' +
      'types, type, children, edges, edge, cross-edges, resolve-edge; ' +
      'regions, region, region-for, domains, domain, rings, ring; ' +
      'lenses, lens, frameworks, framework, framework-categories, framework-patterns; ' +
      'playbooks, playbook, approaches, approach; ' +
      'lifecycles, lifecycle, status-values, scales, scale; ' +
      'anti-patterns, anti-pattern, benchmarks, stages, migrations, schema, version.',
    options: [
      JSON_OPT,
    ],
    examples: [
      { cmd: 'upg spec regions', comment: 'the 11 canonical regions' },
      { cmd: 'upg spec lifecycle feature', comment: 'a type\'s status journey' },
      { cmd: 'upg spec status-values release' },
      { cmd: 'upg spec resolve-edge persona job', comment: 'the canonical edge for a pair' },
      { cmd: 'upg spec children opportunity' },
      { cmd: 'upg spec anti-patterns', comment: 'every catalogued anti-pattern' },
    ],
    seeAlso: 'upg list, upg health',
  },
  template: {
    usage: 'upg template <list|show> [options]',
    summary:
      'Browse the curated starter templates (the same library the /upg-new-from-template ' +
      'skill and the site gallery use). `list [industry]` shows summaries; `show <id>` ' +
      'prints the full pattern: entities, typed edges, and prompts.',
    options: [
      { flag: '--stage <stage>', desc: 'list: filter by stage (concept, validation, growth, mature)' },
      JSON_OPT,
    ],
    examples: [
      { cmd: 'upg template list', comment: 'all 17 templates, grouped by industry' },
      { cmd: 'upg template list saas', comment: 'just the SaaS templates' },
      { cmd: 'upg template show saas-business-model', comment: 'full pattern + prompts' },
    ],
    seeAlso: 'upg init, upg spec',
  },
  query: {
    usage: 'upg query --from <type>|--from-id <id> [options]',
    summary: 'Traverse the graph following typed edges, with field projection and truncation. The BFS primitive behind tree views.',
    options: [
      FILE_OPT, JSON_OPT,
      { flag: '--from <type>', desc: 'Start from all nodes of this type' },
      { flag: '--from-id <id>', desc: 'Start from a specific node' },
      { flag: '--traverse <edges>', desc: 'Comma list of edge types to follow per level (prefix ! to exclude)' },
      { flag: '--depth <n>', desc: 'Max depth (default 3, max 10)' },
      { flag: '--include <fields>', desc: 'Node fields to project' },
      { flag: '--edge-include <fields>', desc: 'Edge fields to project: id,type,source,target. Pass "" to omit edges' },
      { flag: '--limit <n>', desc: 'Max nodes to collect (default 200)' },
    ],
    examples: [
      { cmd: 'upg query --from persona --traverse persona_pursues_job --depth 1' },
      { cmd: 'upg query --from-id n_abc --depth 2 --json' },
    ],
    seeAlso: 'upg tree, upg list',
  },
  registry: {
    usage: 'upg registry <define|update|register|promote|list|connect|org> [options]',
    summary: 'The canonical-entity registry: shared entities many products instance. Operates on a portfolio graph (default portfolio.upg).',
    options: [
      FILE_OPT, JSON_OPT,
    ],
    examples: [
      { cmd: 'upg registry list', comment: 'all canonical entities' },
      { cmd: 'upg registry define persona "Developer"' },
      { cmd: 'upg registry register my-product n_xyz --canonical persona_developer' },
    ],
    seeAlso: 'upg portfolio, upg spec',
  },
  portfolio: {
    usage: 'upg portfolio <list|attach|detach|health|query|check|edges|connect|classify|disconnect|migrate> [options]',
    summary: 'Cross-product and portfolio operations: portfolio membership, cross-product edges, classification cells, a portfolio digest, and validation including portfolio anti-patterns. `connect --properties` and `classify` carry confidence / provenance on property-carrying edges; `edges --type/--source-product/--group-by` filter the listing.',
    options: [
      FILE_OPT, JSON_OPT,
    ],
    examples: [
      { cmd: 'upg portfolio list' },
      { cmd: 'upg portfolio check', comment: 'portfolio validation + anti-patterns' },
      { cmd: 'upg portfolio health' },
      { cmd: 'upg portfolio classify comp_x registry/cv_leader --confidence high --evidence sig_q2', comment: 'classification cell with provenance' },
      { cmd: 'upg portfolio edges --group-by source' },
    ],
    seeAlso: 'upg registry, upg health',
  },
  area: {
    usage: 'upg area <list|create|update|delete|show|tree|assign|move|remove|link-audience> [options]',
    summary: 'Product areas within a portfolio: the area hierarchy, area-scoped subgraphs, product membership, and audience links.',
    options: [
      FILE_OPT, JSON_OPT,
    ],
    examples: [
      { cmd: 'upg area list' },
      { cmd: 'upg area create "Schema & Forms"' },
      { cmd: 'upg area tree area_schema_forms', comment: 'the area subgraph' },
    ],
    seeAlso: 'upg portfolio, upg tree',
  },
  migrate: {
    usage: 'upg migrate <type|status|properties|edges> [options]',
    summary: 'Catalogue-aware migrations: retype a node (applies spec defaults), migrate statuses/properties to current, or rename an edge type. Pairs with fmt and fix.',
    options: [
      FILE_OPT, JSON_OPT,
      { flag: '--dry-run / --no-dry-run', desc: 'Preview without writing (defaults vary per subcommand)' },
    ],
    examples: [
      { cmd: 'upg migrate type n_abc need', comment: 'retype + apply defaults' },
      { cmd: 'upg migrate status', comment: 'preview status migrations (dry-run default)' },
      { cmd: 'upg migrate edges --from old_edge --to new_edge --flip' },
    ],
    seeAlso: 'upg fmt, upg fix',
  },

  // ── Tool parity singletons ─────────────────────────────────────────────────
  move: {
    usage: 'upg move <id> <new-parent> [options]',
    summary: 'Re-parent a node under a new parent, re-typing its containment edge.',
    options: [FILE_OPT, JSON_OPT, { flag: '--type <edge>', desc: 'Override the inferred containment edge type' }, { flag: '--old-edge <edge-id>', desc: 'Disambiguate when the node has multiple hierarchy edges' }, { flag: '-y, --yes', desc: 'Skip confirmation' }],
    examples: [{ cmd: 'upg move n_story n_epic' }],
    seeAlso: 'upg connect, upg tree',
  },
  disconnect: {
    usage: 'upg disconnect <edge-id> [options]',
    summary: 'Remove a single edge by id (the inverse of connect).',
    options: [FILE_OPT, JSON_OPT, { flag: '-y, --yes', desc: 'Skip confirmation' }],
    examples: [{ cmd: 'upg disconnect e_abc123' }],
    seeAlso: 'upg connect, upg delete',
  },
  dedupe: {
    usage: 'upg dedupe [options]',
    summary: 'Find and merge duplicate nodes (same type + title). Dry-run by default; --apply to commit.',
    options: [FILE_OPT, JSON_OPT, { flag: '--type <type>', desc: 'Scope to one entity type' }, { flag: '--dry-run', desc: 'Preview only; do not write (default: on)' }, { flag: '--apply', desc: 'Commit the merge (else preview)' }, { flag: '--keep <s>', desc: 'newest | oldest (default newest)' }, { flag: '-y, --yes', desc: 'Skip confirmation' }],
    examples: [{ cmd: 'upg dedupe', comment: 'preview' }, { cmd: 'upg dedupe --type persona --apply -y' }],
    seeAlso: 'upg check, upg fix',
  },
  clone: {
    usage: 'upg clone <from-product> [options]',
    summary: 'Scaffold a structure from a template product, optionally scoped to a region.',
    options: [FILE_OPT, JSON_OPT, { flag: '--into <product>', desc: 'Target product (else active)' }, { flag: '--region <id>', desc: 'Only clone a region' }, { flag: '--dry-run', desc: 'Preview' }, { flag: '-y, --yes', desc: 'Skip confirmation' }],
    examples: [{ cmd: 'upg clone template --into my-product --dry-run' }],
    seeAlso: 'upg workspace, upg create',
  },
  context: {
    usage: 'upg context [options]',
    summary: 'A lens-aware product summary: counts, key entities, and domain guidance.',
    options: [FILE_OPT, JSON_OPT, { flag: '--lens <id>', desc: 'View through a role lens' }, { flag: '--domains <list>', desc: 'Filter to domains' }, { flag: '--summary', desc: 'Include edge counts by type and orphan count' }],
    examples: [{ cmd: 'upg context' }, { cmd: 'upg context --lens ux_design' }, { cmd: 'upg context --summary' }],
    seeAlso: 'upg health, upg here',
  },
  log: {
    usage: 'upg log [options]',
    summary: 'The recent mutation feed for the graph (create / update / delete).',
    options: [FILE_OPT, JSON_OPT, { flag: '--since <iso>', desc: 'Only changes after this timestamp' }, { flag: '--limit <n>', desc: 'Most recent N' }],
    examples: [{ cmd: 'upg log --limit 20' }],
    seeAlso: 'upg diff',
  },
  prioritise: {
    usage: 'upg prioritise <ids...> --framework <id> [options]',
    summary: 'Rank entities by a scoring framework (RICE, ICE, WSJF, value-vs-effort). Read-only. --framework and at least one id are required.',
    options: [
      FILE_OPT, JSON_OPT,
      { flag: '--framework <id>', desc: 'Required. Framework id, e.g. rice-scoring, ice-scoring, wsjf' },
    ],
    examples: [
      { cmd: 'upg prioritise n_a n_b --framework rice-scoring' },
      { cmd: 'upg prioritise n_a n_b --framework value-vs-effort --json' },
    ],
    seeAlso: 'upg score, upg apply, upg spec frameworks',
  },
  sync: {
    usage: 'upg sync status [options]',
    summary: 'Report local sync state vs the cloud (read-only; push/pull stay agent-only).',
    options: [FILE_OPT, JSON_OPT],
    examples: [{ cmd: 'upg sync status' }],
    seeAlso: 'upg workspace',
  },
  product: {
    usage: 'upg product update [options]',
    summary: 'Edit product-level fields (title, description, stage, member_kind).',
    options: [
      FILE_OPT,
      JSON_OPT,
      { flag: '--title <t>', desc: 'New title' },
      { flag: '--stage <s>', desc: 'Product stage' },
      { flag: '--member-kind <kind>', desc: 'Workspace member kind: product | org_rollup | watched | operating_function' },
    ],
    examples: [
      { cmd: 'upg product update --stage growth' },
      { cmd: 'upg product update --member-kind watched --file .upg/competitor-x.upg' },
    ],
    seeAlso: 'upg workspace, upg init',
  },
  batch: {
    usage: 'upg batch <create|update|delete> [options]',
    summary: 'Atomic batch operations: create, update, or delete many entities in one call.',
    options: [FILE_OPT, JSON_OPT, { flag: '--data <json>', desc: 'create/update: JSON array (or { nodes, edges })' }, { flag: '--ids <list>', desc: 'delete: comma-separated ids' }, { flag: '--dry-run', desc: 'create: validate without writing' }],
    examples: [{ cmd: 'upg batch create --data \'[{"type":"need","title":"X"}]\'' }, { cmd: 'upg batch delete --ids n_a,n_b -y' }],
    seeAlso: 'upg create, upg import',
  },
}

/** Resolve a command name (or alias) to its help entry, if any. */
export function commandHelp(name: string): HelpEntry | undefined {
  return helpTopics[name]
}

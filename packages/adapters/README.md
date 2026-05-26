# @unified-product-graph/adapters

37 adapters that turn records from external tools into [Unified Product Graph](https://unifiedproductgraph.org) nodes and edges.

```
Markdown · Notion · Linear · GitHub · Jira · ...   →  UPG nodes + edges
```

## Adapter status

Each adapter implements `convert(items)` against pre-fetched data. `markdown` also implements `list()` against an in-memory string. The other 36 read from an API or MCP connection in `list()`.

| Adapter | `convert()` | `list()` | Source |
|---------|-------------|----------|--------|
| **markdown** | yes | yes (in-memory) | Structured `.md` files |
| **notion** | yes | needs Notion MCP | Notion pages, databases, relations |
| **dovetail** | yes | needs API | Research projects, notes, highlights, themes |
| **vistaly** | yes | needs API | Continuous-discovery cards |
| **quantive** | yes | needs API | OKRs (Objective, Key Result, Initiative) |
| **shortcut** | yes | needs API | Objectives, Key Results, Epics, Stories |
| **coda** | yes | needs API | Tables, rows, lookup columns |
| **amplitude** | yes | needs API | Charts, cohorts, experiments, funnels |
| **posthog** | yes | needs API | Feature flags, experiments, insights, cohorts |
| **canny** | yes | needs API | Feature requests, companies, votes |
| **intercom** | yes | needs API | Conversations, contacts, articles, surveys |
| **hubspot** | yes | needs API | Contacts, companies, deals, tickets, feedback |
| **salesforce** | yes | needs API | Accounts, contacts, leads, opportunities, cases |
| **gainsight** | yes | needs API | Accounts, objectives, success plans, health scores |
| **pendo** | yes | needs API | Feature adoption, pages, feedback |
| **figma** | yes | needs API | Screens, components, design documents |
| **miro** | yes | needs API | Sticky notes, cards, frames |
| **confluence** | yes | needs API | Pages, blog posts |
| **launchdarkly** | yes | needs API | Feature flags, experiments, metrics |
| **condens** | yes | needs API | Research sessions, notes, highlights, insights |
| **lookback** | yes | needs API | Sessions, moments, insights, participants |
| **sprig** | yes | needs API | Surveys, responses, themes, insights, segments |
| **maze** | yes | needs API | Research studies, test plans, observations |
| **slack** | yes | needs API | Structured artifacts (pinned, canvases, bookmarks) |
| **linear** | yes | needs Linear MCP | Projects, issues, cycles |
| **github** | yes | needs GitHub MCP or gh | Issues, milestones |
| **gitlab** | yes | needs API | Issues, epics, milestones, groups, projects |
| **jira** | yes | needs API | Issues, epics, projects, components, versions |
| **productboard** | yes | needs API | Features, feedback notes, releases, strategy |
| **aha** | yes | needs API | Strategy, delivery, customer intelligence |
| **zendesk** | yes | needs API | Tickets, customer feedback |
| **lattice** | yes | needs API | People management, OKRs |
| **storybook** | yes | needs API | Design-system components and stories |
| **airfocus** | yes | needs API | Prioritisation, roadmapping, OKRs |
| **craftio** | yes | needs API | Product strategy, OKRs, roadmap, feedback |
| **chisel** | yes | needs API | Discovery, roadmap, team-alignment OKRs |
| **prodpad** | yes | needs API | Product backlog, strategy |

The [Notion section](#notion-adapter) covers bidirectional Notion support.

## Installation

```bash
npm install @unified-product-graph/adapters
```

Requires `@unified-product-graph/core` as a peer dependency.

## Usage

### Markdown Adapter

Parses structured markdown into UPG entities using heading hierarchy and keyword-based type inference.

```ts
import { MarkdownAdapter } from '@unified-product-graph/adapters'

const adapter = new MarkdownAdapter()

// Parse a markdown string
const items = await adapter.list({
  content: `
# My Product

## Personas

### Alex -- Engineering Manager
Type: persona
Needs a better way to manage deployments.
Goals: reduce deploy time, improve reliability.

## Features

### One-Click Deploy
Type: feature
Status: planned
Deploy to production with a single command.

### Rollback Protection
Auto-rollback on error spike detection.
`,
})

// Convert to UPG nodes and edges
const result = await adapter.convert(items)

console.log(result.nodes)    // UPGBaseNode[] -- one per heading
console.log(result.edges)    // UPGEdge[] -- parent-child relationships
console.log(result.warnings) // string[] -- any inference issues
```

#### Markdown Mapping Rules

- `# Heading` becomes the top-level entity (product when no type keyword is found)
- `## Heading` becomes a child entity
- `### Heading` becomes a nested child
- Bullet points under a heading become description content
- `Type: value` lines set an explicit entity type
- `Status: value` lines set the entity status
- `[bracket tags]` and `#hashtags` are extracted as tags
- Type is inferred from keywords in the heading (e.g. "persona", "feature", "hypothesis", "competitor")

#### Multiple Files

```ts
const items = await adapter.list({
  files: [
    { path: 'personas.md', content: personasMarkdown },
    { path: 'features.md', content: featuresMarkdown },
  ],
})
```

### Using the Adapter Registry

```ts
import { getAdapter, ADAPTERS } from '@unified-product-graph/adapters'

const markdown = getAdapter('markdown')
const items = await markdown.list({ content: myMarkdown })

// All registered adapter names:
console.log(Object.keys(ADAPTERS)) // 37 entries: markdown, notion, dovetail, linear, github, ...
```

### Notion Adapter

Runs in both directions.

#### Direction 1: Notion to UPG (import)

Converts Notion databases and pages into UPG nodes and edges. Database names match against 35+ patterns to infer the entity type. `relation` properties between databases become typed UPG edges.

```ts
import { NotionAdapter } from '@unified-product-graph/adapters'
import type { SourceItem } from '@unified-product-graph/adapters'

const adapter = new NotionAdapter()

// Pass pages pre-fetched from Notion (via the Notion MCP or REST API)
const items: SourceItem[] = [
  {
    source_id: 'notion-page-abc123',
    source_type: 'database_item',
    title: 'Improve onboarding drop-off',
    content: 'Users are leaving during the setup flow...',
    metadata: {
      database_name: 'Opportunities',   // inferred as UPG `opportunity`
      status: 'under-consideration',
      unique_id: 'OPP-14',              // preserved as external_id sync anchor
      relations: {
        'Drives': ['notion-page-def456'] // relation property becomes a UPG edge
      },
    },
  },
  {
    source_id: 'notion-page-def456',
    source_type: 'database_item',
    title: 'Redesign setup wizard',
    metadata: { database_name: 'Solutions' }, // inferred as UPG `solution`
  },
]

const result = await adapter.convert(items)
// result.nodes: [opportunity node, solution node]
// result.edges: [opportunity_drives_solution edge]  (from the "Drives" relation)
// result.warnings: any unmapped relation property names
```

**Database name to entity type mapping** (35+ patterns, excerpt):

| Notion database name | UPG entity type | Confidence |
|---------------------|-----------------|------------|
| Opportunities | `opportunity` | high |
| Solutions | `solution` | high |
| Personas, User Types | `persona` | high |
| OKRs, Goals, Objectives | `objective` | high |
| Key Results, KRs | `key_result` | high |
| Insights, Research Insights | `insight` | high |
| Research, Interviews, User Research | `research_study` | high |
| Features | `feature` | high |
| Experiments, Tests, Assumption Tests | `experiment` | high |
| Competitors, Competitor Tracker | `competitor` | high |
| Sprints, Cycles | *(unmappable, emits warning)* | n/a |

**Relation property to UPG edge mapping** (excerpt):

| Notion relation property name | UPG edge type |
|------------------------------|---------------|
| Informs, Surfaces, Reveals | `insight_informs_opportunity` |
| Drives, Addresses | `opportunity_drives_solution` |
| Delivers, Ships | `outcome_delivered_by_feature` |
| Implements, Aligns With | `project_implements_initiative` |
| Produces | `research_study_produces_insight` |

#### Direction 2: UPG to Notion (schema generation)

Generates a Notion API payload that creates a structured workspace from a UPG graph. Pair with `@unified-product-graph/notion-sync` to execute against the Notion API.

```ts
import { generateNotionWorkspace } from '@unified-product-graph/adapters/notion-schema-generator'

const plan = generateNotionWorkspace(nodes, edges)

// plan.databases: one per entity type present in the graph
// plan.pages:     one per node, with property values
// plan.relations: edge-to-relation mappings (populated after pages are created)
// plan.warnings:  entity types with no Notion schema defined

console.log(plan.databases.map(d => d.database_name))
// ['Opportunities', 'Solutions', 'Features', 'Personas', ...]
```

Each generated database includes canonical properties for that entity type:

```ts
import { generateDatabaseSchema } from '@unified-product-graph/adapters/notion-schema-generator'

const schema = generateDatabaseSchema('opportunity')
// {
//   'Name':        { type: 'title' },
//   'Description': { type: 'rich_text' },
//   'Status':      { type: 'select', options: ['new', 'validated', 'closed', ...] },
//   'UPG ID':      { type: 'unique_id' },   // sync anchor
//   'Severity':    { type: 'select' },
//   'Persona':     { type: 'relation' },    // populated during push phase 3
// }
```

#### Direction 3: Discover an existing Notion workspace

Classify an existing Notion workspace's databases and map them to UPG entity types.

```ts
import { classifyDatabases } from '@unified-product-graph/adapters/notion-discovery'

const classifications = classifyDatabases([
  { database_id: 'abc', name: 'Opportunities', properties: [...] },
  { database_id: 'def', name: 'My Stuff',      properties: [...] },
])

// [
//   {
//     database_id: 'abc',
//     inferred_entity_type: 'opportunity',
//     confidence: 'high',
//     matched_by: 'name',
//     suggested_edge_mappings: [{ property_name: 'Drives', inferred_edge_type: 'opportunity_drives_solution', confidence: 'medium' }],
//     warnings: [],
//   },
//   {
//     database_id: 'def',
//     inferred_entity_type: null,
//     confidence: 'unknown',
//     matched_by: 'none',
//     warnings: ['Could not infer entity type, review manually'],
//   },
// ]

// Get a human-readable confirmation prompt for the user
import { buildConfirmationPrompt } from '@unified-product-graph/adapters/notion-discovery'
console.log(buildConfirmationPrompt(classifications))
```

The generated `NotionWorkspacePlan` is a declarative payload. Pair this adapter with any Notion API client to create databases, sync nodes, or run bidirectional sync.

### Linear and GitHub Adapters (Partial)

Both have working `convert()` methods. Pass pre-fetched data:

```ts
import { LinearAdapter } from '@unified-product-graph/adapters'

const adapter = new LinearAdapter()
const result = await adapter.convert(prefetchedItems)
```

Calling `list()` throws an error explaining the MCP dependency.

## The UPGAdapter Interface

Every adapter implements this interface. Use it to build adapters for other sources:

```ts
interface UPGAdapter {
  name: string        // e.g. 'markdown', 'jira'
  label: string       // e.g. 'Markdown', 'Jira'
  description: string

  /** Discover available items in the source system */
  list(config: AdapterConfig): Promise<SourceItem[]>

  /** Convert source items to UPG nodes and edges */
  convert(items: SourceItem[], config?: AdapterConfig): Promise<ImportResult>
}

interface ImportResult {
  nodes: UPGBaseNode[]
  edges: UPGEdge[]
  source_map: Record<string, string>  // source ID to UPG node ID
  warnings?: string[]
}
```

## License

MIT

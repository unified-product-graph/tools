# Adapter Audit & Release Ledger

Branch: `feat/adapter-audit` (off `origin/dev`). Worktree: `/Users/FH/Documents/_Code/tpc-adapter-audit`.

Autonomous run started 2026-06-18. Goal: take every shipped integration through a
real end-to-end import audit, fix the adapter where it drifts from the source's
real API/shape, and release it on the site one at a time as it passes.

## The audit bar (what "passes" means)

Each adapter is run through the full production path
(`list → convert → writeToUPGFile → reload from disk`) via the reusable harness
`packages/upg-cli/src/__tests__/helpers/import-e2e.ts`, against a fixture built
from the source's REAL shape. It passes when:

1. **Ground truth** — fixture is built from the source's real API/export schema
   (public docs), not the adapter's own assumptions. Gaps flagged.
2. **Types** — every emitted node type is in the spec catalogue (the store
   quarantines unknowns on reload → reload count must equal node count).
3. **Edges** — every edge type is catalogued AND points the correct direction
   (verified with `resolve_edge_for_pair`).
4. **Status** — every emitted status is valid for that entity type's lifecycle,
   or omitted (no "invalid status for lifecycle" drift).
5. **Properties** — numeric/metric values nested under `properties` (canonical),
   not off-schema top-level fields (the writer only persists canonical fields).
6. **Provenance** — `external_tool` / `external_id` set and surviving the round-trip.
7. **(Live adapters)** — endpoints + field names + enums match the real API.

Releasing = add the slug to `RELEASED_INTEGRATION_SLUGS` in
`apps/upg-site/src/data/integrations.ts`. Until then it reads "Coming soon".

## Cross-cutting fixes (benefit every adapter)

- **Writer provenance fix** — `writeToUPGFile` now preserves canonical
  `external_tool`/`external_ref`/`external_id` (was dropping them). Done.
- **Audit harness** — `import-e2e.ts` (fetch-stub router + round-trip). Done.

### linear — ✅ RELEASED (well-built; 2 real bugs fixed)
Linear was the strongest adapter so far (catalogue-aware containment edges,
properties nesting, endpoint-validated cross-domain edges). The audit still caught:
- **status was never imported**: `list()` writes `metadata.status` (the workflow
  state) but `convert()` read `metadata.state` → always undefined. Fixed +
  per-type validated (`normalizeLinearStatus` now maps to real delivery phase ids
  `proposed/todo/in_progress/done/archived`, kept only where valid for the type).
- **`external_url`** (off-schema → dropped) → canonical **`external_ref`**.
Tests: 32 unit + 3 e2e, green.

### github — ✅ RELEASED (endpoint + status + provenance fixes)
- **milestone mapped to `milestone`** but emitted `release_contains_feature/bug`
  from it (there is NO milestone->feature edge in the catalogue) → mapped GitHub
  milestone to UPG **`release`** (a versioned target that contains issues; also
  matches the site copy), so those edges are now correctly release-sourced. The
  incoherent `milestone_gates_release` path was removed.
- per-type status: a bug's `open` survives (real bug phase); `open`/`closed` map
  to `in_progress`/`done` and are kept only where valid for the type.
- `external_url` (off-schema) → canonical `external_ref`.
Tests: 45 unit + 4 e2e, green.

### jira — ✅ RELEASED (a skip bug + endpoint + status fixes)
- **issues were silently dropped**: `list()` tags issues with `entity_kind:'issue'`,
  but `convert()`'s pass-1 treated any non-structural `entity_kind` as an unknown
  structural kind and skipped it → a real Jira import produced ZERO issues. Fixed
  (only structural kinds are gated; issues fall through to issue-type mapping).
- **wrong-endpoint edges**: `epic_specified_by_user_story` forced onto tasks,
  `task_implements_user_story` emitted reversed, `feature_area_contains_feature` /
  `release_contains_feature` onto user_story/epic/bug issues → catalogue-driven
  resolver (correct type + direction, node_informs_node fallback). The real edges
  (project_delivers_epic, epic_specified_by_user_story, task_implements_user_story,
  release_contains_bug) now fire correctly.
- per-type status validation (bug `open` survives; To Do/In Progress/Done map to
  todo/in_progress/done; user_story is lifecycle-free → omitted).
- **Live note:** `list()` uses `GET /rest/api/3/search` (Atlassian deprecated this
  in favour of `POST /rest/api/3/search/jql`; verify against a live instance).
Tests: 35 unit + 4 e2e, green.

### notion — ✅ RELEASED (best-built import path; 2 small fixes)
Notion already used the catalogue-aware containment resolver (correct edge types
+ direction). Fixes:
- global `LIFECYCLE_STATUS_MAP` emitted stages invalid for many target
  lifecycles → per-type validation (a feature's `shipped` survives; user_story is
  lifecycle-free → omitted).
- `external_url` (off-schema) → canonical `external_ref`.
Relation-property edges (`resolveRelationEdge`) can still produce endpoint
mismatches if a relation's verb does not match the node types — a follow-up to
validate, but they only fire when `metadata.relations` is present.
Tests: e2e green (3); existing adapter-edge-catalogue notion tests still pass.

## Phase A COMPLETE — all 10 website integrations released

vistaly · markdown · posthog · productboard · dovetail · figma · linear · github
· jira · notion. Every one audited end-to-end (real-shaped fixture → list/convert
→ write .upg → reload → 6-check conformance), fixed, and flipped on in
RELEASED_INTEGRATION_SLUGS. Phase B (hidden 27) is next.

## Post-milestone queue (Captain, 2026-06-18)

Lined up to run AFTER the adapter audit milestone, to bring everything in sync
with the now-corrected reality:

1. **Reconcile the /integrations site copy with each fixed adapter.**
   ✅ DONE 2026-06-18 for all 10 RELEASED slugs (vistaly, dovetail, notion,
   linear, jira, github, productboard, posthog, figma, gitlab). The pre-audit
   copy was not just stale but largely **aspirational** — it advertised mappings
   to UPG types the adapters never emit (figma `design_token`/`design_spec`/
   `ui_component`/`wireframe`/`user_flow`; posthog `feature_flag`/`survey_response`/
   `event_schema`/`variant`; productboard `key_result`/`behavioral_segment`),
   wrong core mappings (linear Project→epic, github Milestone→milestone +
   PR-as-deployment), and phantom edges (`customer_feedback_becomes_feature_request`,
   `feature_expressed_by_screen`, `insight_informs_opportunity`,
   `initiative_drives_outcome`). Fixed under the **verified-only** rule (Captain's
   call): anything the adapter does not emit moved to `gaps`/`skipped`; every
   `sampleImport` rebuilt to mirror the adapter's proven e2e output; every
   `primaryEdge` + sample edge is a real emitted edge (hierarchy edge names
   confirmed via `resolve_edge_for_pair` — `feature_area_contains_feature`,
   `product_organises_into_feature_area`; `objective→feature`, `release→epic`,
   `product→project`, `file→frame/component` all resolve to null →
   `node_informs_node`). ~53 corrections; upg-site type-check green; no em-dashes
   in rendered copy. Per-adapter reconciliation reports are in the night's agent
   outputs. **Phase B slugs still carry aspirational copy** — reconcile each at
   its release (same rule), not before.
2. (Engineering follow-ups already logged per adapter: Dovetail live-verify of
   the cursor param + a couple GET field names; Dovetail themes/contacts/docs
   hierarchy edges.)

## Backlog order

### Phase A — on the website (10 launch slugs)
| # | Slug | Kind | Status |
|---|------|------|--------|
| 1 | vistaly | live (custom fetch) | ✅ RELEASED — adapter was fictional; rewritten against real /beta API |
| 2 | dovetail | live (custom fetch) | ✅ RELEASED — list() rewritten against real endpoints (Captain's dev ref); e2e green; verify cursor param + a few GET field names live |
| 3 | linear | live (SDK) | ✅ RELEASED — status read-bug + per-type validation + external_ref fix |
| 4 | jira | live (custom fetch) | ✅ RELEASED — issue-skip bug + per-type status + catalogue-driven edges |
| 5 | github | live (custom fetch) | ✅ RELEASED — milestone->release (endpoint fix), per-type status, external_ref |
| 6 | markdown | in-memory (real) | ✅ RELEASED — conformant; catalogue-aware edges, valid inferred types |
| 7 | notion | MCP / export | ✅ RELEASED — per-type status + external_ref (edges already catalogue-aware) |
| 8 | posthog | convert-only | ✅ RELEASED — convert bugs fixed (see findings) |
| 9 | productboard | convert-only | ✅ RELEASED — per-type status + catalogue-driven edges |
| 10 | figma | convert-only | ✅ RELEASED — identifiers->properties, per-type status, catalogue-driven edges |

### Phase B — landscape + standard fix recipe (2026-06-18 static scan)

A static scan of all 27 convert-only adapters shows they share the Phase A bug
classes and **none** use catalogue-driven edge resolution yet. The fix recipe is
now mechanical (proven 10×):
1. `import { getLifecycleForType, UPG_EDGE_PAIR_MAP } from '@unified-product-graph/core'`
2. add `validStatusesForType` + `resolve<Tool>StatusForType(raw, type)` (raw
   passthrough → mapped → omit-if-invalid) and use it wherever status is set.
3. nest any top-level metric/identifier fields under `properties`; `external_url`
   → `external_ref`.
4. replace hardcoded edge emission with the catalogue-driven `resolvePairEdge`
   (or `resolveContainmentEdge`) + `node_informs_node` fallback.
5. e2e (`<slug>-e2e.test.ts`) with a representative fixture → `conformanceIssues`
   == []; realign any unit tests that pinned the old behavior; flip the slug.

Per-adapter scan flags (statusmap / external_url / detectable-hardcoded-edges):
- **gitlab** (2 / 2 / 4) — ✅ RELEASED (per-type status + external_ref + catalogue-driven deferred edges; 56 unit + 3 e2e green).
- **aha** (3 / 0 / 1), coda (4 / 1 / 0) — status + a few edges/ext_url.
- quantive·shortcut·condens·lookback·sprig·airfocus·craftio·chisel·prodpad (3 status maps each) — status-heavy.
- amplitude·canny·intercom·hubspot·salesforce·gainsight·pendo·launchdarkly·maze·zendesk·lattice·lattice (2) — status + verify edges.
- miro·confluence·slack·storybook (0 status maps) — lightest; verify edges only.

### Phase B — hidden backlog (27)
quantive · shortcut · coda · amplitude · canny · intercom · hubspot · salesforce ·
gainsight · pendo · miro · confluence · launchdarkly · condens · lookback · sprig ·
maze · slack · gitlab · aha · zendesk · lattice · storybook · airfocus · craftio ·
chisel · prodpad

## Per-adapter findings

### vistaly — ✅ RELEASED
The adapter was built against a **fictional API** (verified against the live
OpenAPI spec, `api.vistaly.com/v1/swagger.json`, 2025-06-21):
- Called `GET /v1/workspaces` + `/v1/workspaces/{id}/cards` — neither exists.
  Real enumeration: `GET /beta/cards/{id}/context`.
- Every field name wrong (`id`→`cardId`, `card_type`→`cardType`, …).
- Type enum wrong both ways (missed real `problem`/`product`; invented 8 types).
- Status map had zero overlap with real statuses.

Rewritten against the real API. Mapping: outcome/objective/opportunity/solution/
assumption/experiment direct, kpi→metric, product→product, **problem→need**
(ratified). Per-type status normalisation (no more invalid-status drift). Metric
values under `properties`. Edge directions verified; `objective_advances_outcome`
(the old "gap" was a bug). Tests: 32 unit + 7 e2e, green. Follow-up (deferred):
reconcile the site `schemaMapping`/`sampleImport` copy with the real contract.

### dovetail — 🔍 RELEASE HELD (drift documented)
Ground truth from `developers.dovetail.com` (ReadMe docs; **no public OpenAPI** —
the API's own `openapi.json` is auth-gated, so GET response shapes can't be fully
confirmed). Confirmed drift in `list()`:
- **3 invented endpoints** (all 404): `/v1/projects/:id/data`, `/v1/projects/:id/highlights`,
  `/v1/projects/:id/themes`. Real: `GET /v1/data` (global), `GET /v1/highlights`
  (global), `GET /v1/channels/:id/themes` (themes live under **channels**, not projects).
- **Wrong field names**: `theme.name`→`title`, `theme.description`→`summary`,
  `contact.title`→`name`, `highlight.data_id`→`note_id`, `start_s`/`end_s`→`start_time`/`end_time`.
- **No pagination** despite cursor-paginated `{ data, page:{ has_more, next_cursor } }`.
- `highlight.content` doesn't exist (highlights are timestamp clips); `data` list has
  no `content` (needs a separate `/export` call) and likely no `type` field.

Deeper issue: the `convert()` edge model is **project-centric**, but the real
structure is global resources + themes-under-channels + global contacts, so most
hierarchy edges (`research_study_clusters_into_affinity_cluster`,
`research_study_enrolls_participant`, `observation_yields_insight`) won't fire
against real data. So Dovetail needs BOTH a `list()` rewrite AND a `convert()`
edge-model redesign, then verification against a live workspace. **Held** — not a
guess-and-ship. The drift map above is the spec for the fix.

**UPDATE (2026-06-18, Captain provided the API reference
`developers.dovetail.com/reference/...`):** confirmed base/auth/paths and that
`/v1/data` is metadata-only. `list()` rewritten against the real GLOBAL endpoints
(`/projects`, `/data`, `/highlights`, `/docs`, `/contacts`, `/channels`,
`/channels/{id}/themes`) with cursor pagination and real field names (`note_id`,
`title`, `summary`, `name`, `start_time`/`end_time`). The research chain
(research_study → observation → quote) connects; channel themes / contacts / docs
import as valid nodes (their hierarchy edges are a follow-up — Dovetail's real
structure is global resources + themes-under-channels, so the project-centric
edges don't all fire). e2e green (37 unit + 4 e2e). **Released.** Two GET field
names couldn't be confirmed from the (client-rendered) docs and are handled
defensively — verify against a live workspace: the **pagination cursor param**
(`page[after]` assumed) and the **highlight text field** (`text` assumed;
falls back to a "Clip Ns-Ms" title from start/end_time if absent). The
data/doc project reference handles both `project_id` and nested `project.id`.

### markdown — ✅ RELEASED
In-memory parser, no API. Catalogue-aware edges (`resolveContainmentEdge` +
`node_informs_node` fallback), valid inferred types. Conformant out of the box.

### posthog — ✅ RELEASED (convert bugs fixed)
The conformance audit caught four real bugs, all now fixed:
- emitted the **deprecated `hypothesis_claim`** type → now `hypothesis`;
- the experiment→hypothesis edge used `feature_tests_hypothesis` (wrong type AND
  direction) → now `hypothesis_tested_by_experiment` (hypothesis → experiment);
- a **global status map** emitted lifecycle-invalid statuses (`active` on
  feature/experiment, `complete` on customer_feedback) → now validated against
  the target type's lifecycle, passing valid values through (experiment
  `running`) and omitting the rest;
- metric values (`current_value`/`target_value`/`unit`) were **top-level node
  fields** → silently dropped by the writer → now nested under `properties`.
Tests: 30 unit + 3 e2e, green. These four are the systemic bug classes — the same
audit now runs against every convert-only adapter.

### productboard — ✅ RELEASED (convert bugs fixed)
The audit (now also checking edge ENDPOINT types) caught:
- a global status map emitting lifecycle-invalid statuses → now per-type
  validated + remapped to delivery-lifecycle phases (feature keeps its status);
- **wrong-endpoint edges**: `feature_area_contains_feature` forced onto bug/epic
  children, `outcome_delivered_by_feature` sourced from an objective,
  `initiative_drives_outcome` targeting an objective, and
  `customer_feedback_becomes_feature_request` pointed at a feature (its target
  must be a feature_request). All replaced by a **catalogue-driven resolver**
  (`UPG_EDGE_PAIR_MAP`) that emits the canonical edge + direction where one
  exists, and an honest `node_informs_node` otherwise.
Tests: 35 unit + 2 e2e, green.

> Reporter now has 6 checks: reload-validity, edge-catalogue, **edge-endpoint
> types**, per-type status validity, off-schema fields, traceability.

### figma — ✅ RELEASED (convert bugs fixed)
- `file_key`/`node_id`/`thumbnail_url` were **top-level node fields** (dropped on
  persist) → nested under `properties`;
- status was applied untyped → per-type validation (`archived` → `deprecated`,
  valid for screen/design_component; `active` dropped, no clean target);
- **wrong-endpoint edges**: `product_contains_screen` /
  `design_system_contains_design_component` were emitted from a `document` node
  (a Figma file maps to document) → catalogue-driven resolver, so screen→screen,
  screen→component, component_set→component, prototype→screen stay canonical and
  file→* falls back to `node_informs_node`.
Tests: 23 unit + 3 e2e, green.

## Strategy (refined after Dovetail)

Two classes of adapter need different work:
- **Live custom-fetch** (vistaly✓, dovetail, jira): list() was written against
  assumed APIs. Releasable only with authoritative ground truth: Vistaly had a
  public OpenAPI spec → fixed + released; Dovetail doesn't → drift documented,
  held for live verification. Same check coming for jira.
- **Everything else** (SDK live + convert-only, ~33): the real leverage is a
  spec-conformance audit of `convert()` — catalogued types, catalogued + correctly
  directed edges, valid per-type statuses, numerics under `properties`, provenance.
  This needs no live API and surfaces certain, fixable bugs. Building this next as
  the backbone for the remaining adapters.

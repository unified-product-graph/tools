# Vistaly — captured source schema (ground truth)

> **Source of truth:** Vistaly's live OpenAPI spec, fetched from
> `https://api.vistaly.com/v1/swagger.json` on 2026-06-17.
> `info.title = "Vistaly API"`, `info.version = "2025-06-21"`,
> `servers[0].url = "https://api.vistaly.com"`.
>
> This file captures what Vistaly's API **actually** returns, so fixtures
> resemble real incoming data — not our adapter's assumptions about it.
> The drift table at the bottom is the audit finding.

---

## Real API — paths (verbatim from spec `paths`)

```
GET  /beta/cards/{cardId}                 → GetCardResponse  (one card)
PUT  /beta/cards/{cardId}
POST /beta/cards                          → CreateCardResponse
GET  /beta/cards/{cardId}/comments
GET  /beta/cards/{cardId}/context         → CardContextResponse  (tree around one card)
POST /beta/cards/search                   → semantic search (requires a query)
PUT  /beta/cards/{cardId}/parents
GET  /v1/auth/info
POST /v1/cards/{cardId}/metrics           (+ /metrics/bulk)
GET/POST /v1/feedback  (+ /{id}, /process)
POST /v1/interviews  (+ /{id}, /{id}/transcript)
GET  /v1/health
GET  /v1/docs/full  ·  /v1/docs/summary
```

**There is no `GET /v1/workspaces` and no `GET /v1/workspaces/{id}/cards`.**
There is no "list all cards in a workspace" endpoint at all. To enumerate a
workspace you must already hold a card id and walk `/beta/cards/{id}/context`,
or call `POST /beta/cards/search`.

## Real API — card object (`GetCardResponse`, * = required)

```
* cardId: string                 (NOT "id")
* cardTitle: string              (NOT "title")
* cardType: CardType (enum)      (NOT "card_type")
* organizationId: string
  cardDetails: string            (NOT "description")
  cardStatus: string             (NOT "status")
  workspaceId: string
  parents:  array<{ contextId, model: card|tree|tree.backlog, id }>   (NOT "parent_id"/"parent_type")
  children: array<{ cardId, contextId }>
  assignees: array<string>
  labels: array<string>          (label IDs, not free strings; there is no "tags" field)
  metricCurrent: number          (NOT "metric_current_value")
  metricTarget:  number          (NOT "metric_target_value")
  metricUnit:    string          (NOT "metric_unit")
  metricType, metricStart, metricLowerThreshold, metricUpperThreshold
  archived, archivedAt, archivedBy, startDate, endDate
  jiraLinked, jiraIssueId, commentsCount, commentsLastCreatedAt
  createdAt, createdBy, updatedAt, updatedBy, resources[]
```

## Real API — tree (`CardContextResponse` from `/beta/cards/{id}/context`)

```
{ context: EnrichedCardContext[], metadata: { direction, cardCount, maxLevel } }

EnrichedCardContext (* = required):
* cardId, cardTitle, cardType (enum), cardUrl, level, children: string[] (child cardIds),
  organizationId, workspaceId
  cardDetails?, cardStatus?, metricCurrent?, metricTarget?, metricUnit?, insights[], comments[]
```
Query params: `direction=ancestors|descendants|both` (default descendants),
`maxLevels` (1–10, default 4), `includeTargetCard`, `includeComments`,
`includeInsights`, `includeDescriptions`.

## Real API — `CardType` enum (verbatim)

```
assumption · experiment · kpi · objective · opportunity · outcome · problem · product · solution
```

## Real API — `CardStatus` enum (verbatim, type-scoped)

```
addressed · at risk · developing · done · failed · idea · identified · later · next ·
not now · now · passed · pending · progressing · running · on track · uncommitted
```

---

## Our adapter's ASSUMED contract (`packages/upg-adapters/src/adapters/vistaly.ts`)

`list()` calls, in order:
1. `GET https://api.vistaly.com/v1/workspaces`            → `{ data: [{ id, name }] }`
2. `GET https://api.vistaly.com/v1/workspaces/{wsId}/cards` → `{ data: Card[] }`

Assumed `Card`:
```
{ id, title, description?, card_type, status?, parent_id?, parent_type?,
  metric_current_value?, metric_target_value?, metric_unit?, tags?, labels? }
```
Assumed `card_type` values (VISTALY_TYPE_MAP keys):
`vision, mission, objective, outcome, kpi, metric, assumption, initiative,
opportunity, solution, experiment, assumption_test, interview, feedback, sprint`

Assumed `status` values (VISTALY_STATUS_MAP keys):
`new, under-consideration, planned, in-progress, released, won't-do`

---

## DRIFT — assumption vs. reality (the audit finding)

| Layer | Adapter assumes | Reality (live spec) | Verdict |
|------|------------------|---------------------|---------|
| Enumerate workspaces | `GET /v1/workspaces` | endpoint does not exist | **404 — broken** |
| List cards | `GET /v1/workspaces/{id}/cards` | endpoint does not exist (no list-all exists) | **404 — broken** |
| Response envelope | `{ data: [...] }` | card at root / `{ context, metadata }` | **wrong** |
| id field | `id` | `cardId` | **wrong** |
| title field | `title` | `cardTitle` | **wrong** |
| type field | `card_type` | `cardType` | **wrong** |
| description | `description` | `cardDetails` | **wrong** |
| status field | `status` | `cardStatus` | **wrong** |
| parent ref | `parent_id` + `parent_type` (strings) | `parents[]` objects / context `children[]` ids | **wrong** |
| metric fields | `metric_current_value`/`_target_value`/`_unit` | `metricCurrent`/`metricTarget`/`metricUnit` | **wrong** |
| tags | `tags[]` | no such field (`labels[]` = IDs) | **wrong** |
| type enum | adds vision, mission, metric, initiative, assumption_test, interview, feedback, sprint | real adds **problem**, **product**; has none of those extras | **wrong both ways** |
| status enum | new/planned/in-progress/released/… | idea/now/next/later/done/identified/on track/… | **0 keys overlap** |

**Net:** the Vistaly "live" adapter is written against an imagined API. As shipped
it cannot fetch (the two endpoints `list()` calls return 404), and even if the
data were handed to it, every field read resolves to `undefined`, so every card
becomes an untyped, title-less `document`. The two real unmapped enum values
(`problem`, `product`) would also fall through to `document`.

---

## Fixtures in this directory

- `card-context.real.json` — a realistic `/beta/cards/{root}/context` response in
  the **real** shape (a discovery tree). This is "data as it actually comes in."
- `cards.assumed.json` — a `{ data: Card[] }` payload in the shape the adapter
  **assumes**. Used as the control that proves the convert+persist machinery is
  sound and the only defect is the input contract.

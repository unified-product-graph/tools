# Helm — a tiny product-graph coach

Helm is a small CLI built on `@unified-product-graph/sdk` that ships as the **canonical example** of how to build a real application on top of UPG.

It does three things — capture decisions, connect features to personas, and report graph health — across about 200 lines of code. Each command file is a self-contained showcase of one part of the SDK surface.

> Not to be confused with the Kubernetes package manager. This Helm is a UPG SDK example.

## Quickstart

```bash
# From this directory:
npm install
npm run build

# Health report on the bundled demo product (Bramble — a jam marketplace)
./dist/cli.js report

# Capture a decision
./dist/cli.js capture decision "Ship iOS first, not Android"

# Connect a feature to the job it addresses (edge type inferred)
./dist/cli.js connect "Saved searches" "Discover unique"

# Or run with a different .upg file
./dist/cli.js -f ./my-product.upg report
```

## What it demonstrates

### `helm report` — read-only diagnostics

Shows the SDK's high-level read API. One call to `upg.health()` returns both a score and a structured digest with coverage by business area, orphan counts, and gap analysis. `upg.verify()` returns `null` when integrity is clean. `upg.nodes.list({ type })` filters by type without post-filtering.

```ts
const { score, digest } = await upg.health()
const integrity = await upg.verify()
const features = await upg.nodes.list({ type: 'feature' })
```

These calls don't trigger disk writes. Safe to run from a cron job, a Slack bot, or a CI status check at any rate.

→ See [`src/commands/report.ts`](./src/commands/report.ts)

### `helm capture <type> <title>` — the write path

Shows `upg.nodes.create()` and the SDK's built-in type validation. If the user fat-fingers `decsion`, `UnknownEntityTypeError` is thrown with near-miss suggestions — Helm doesn't write any validation logic of its own.

```ts
const result = await upg.nodes.create({
  type: 'decision',
  title: 'Ship iOS first',
})
```

By the time the promise resolves, the `.upg` file on disk has been updated. No manual `flush()`, no debounce timers, no file-lock handling.

→ See [`src/commands/capture.ts`](./src/commands/capture.ts)

### `helm connect <feature> <job>` — search + edge type inference

Shows two-read parallel lookup followed by an inferred-type connect. The user supplies human-readable names; Helm resolves them via `upg.search()` (with type narrowing) and lets the SDK pick the canonical edge type from the UPG edge catalog — `feature_addresses_job` in this case — out of 800+ candidates.

```ts
const [feature, job] = await Promise.all([
  upg.search(featureTitle, { type: 'feature', limit: 1 }),
  upg.search(jobTitle, { type: 'job', limit: 1 }),
])

await upg.edges.connect(feature[0].node.id, job[0].node.id)
// Edge type inferred. No 800-row catalog lookup at the call site.
```

If the pair has no canonical edge (e.g. `feature → persona` — features address *jobs*, not personas), the SDK fails with a clear error you can render to the user. Override `--source-type` / `--target-type` flags to try other pairings.

→ See [`src/commands/connect.ts`](./src/commands/connect.ts)

## The bundled demo graph

`demo.upg` is a fictional product called **Bramble** — a marketplace for homemade jams and preserves. It has 12 nodes (1 product, 2 personas, 3 features, 1 job, 1 need, 1 decision, 1 hypothesis, 1 metric, 1 competitor) and 13 edges. Small enough to read top-to-bottom, large enough to exercise the SDK across multiple entity types.

Feel free to mutate it. Captures persist. Run `git checkout demo.upg` to reset.

## What this example deliberately doesn't do

- **No `UPGFileStore` direct usage.** Production app code should stay on `UPGClient`. The lower-level primitives are re-exported from the SDK for advanced cases (custom traversal, bulk migrations) and you can drop down to them by importing `{ UPGFileStore } from '@unified-product-graph/sdk'`.
- **No batching.** Each command performs one logical operation. For bulk adapter authoring (importing 1000 nodes from Linear, Notion, etc.) the SDK will grow a `batch()` API in v0.7 — until then, hold the lower-level `UPGFileStore` directly and call `flush()` once at the end.
- **No `diff()` use.** `UPGClient.diff()` is a v0.7 placeholder. For now, use the CLI's `upg diff` command for ref-to-ref diffing.

## File layout

```
helm/
├── README.md              ← you are here
├── package.json           ← name: @upg-examples/helm
├── tsconfig.json
├── tsup.config.ts
├── demo.upg               ← bundled fixture (Bramble jam marketplace)
└── src/
    ├── cli.ts             ← commander entry point
    ├── upg.ts             ← singleton UPGClient
    └── commands/
        ├── capture.ts     ← showcases upg.nodes.create
        ├── connect.ts     ← showcases upg.search + upg.edges.connect
        └── report.ts      ← showcases upg.health + upg.verify + upg.nodes.list
```

## License

MIT — same as the SDK.

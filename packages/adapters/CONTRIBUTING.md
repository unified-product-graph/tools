# Contributing to `@unified-product-graph/adapters`

Thanks for your interest in building or improving an adapter. This package
is the most natural contribution vector in the UPG ecosystem. Each adapter
is a small, self-contained file with a clear contract.

## The adapter pattern

Every adapter implements the `UPGAdapter` interface from `src/types.ts`:

```ts
interface UPGAdapter {
  name: string
  label: string
  description: string
  list(config: AdapterConfig): Promise<SourceItem[]>
  convert(items: SourceItem[], config?: AdapterConfig): Promise<ImportResult>
}
```

An adapter does one job: map records from a source system to canonical
UPG nodes and edges. The mapping is documented in the JSDoc header of the
file and exercised by tests.

Read `src/adapters/markdown.ts` for the simplest end-to-end reference, and
`src/adapters/dovetail.ts` for a richer example with multi-type inference
and edge emission.

## How to add a new adapter

1. **Create one file** in `src/adapters/<vendor>.ts`. Keep it self-contained.
2. **Write a JSDoc header** that names the source, lists the entity types
   it maps to, and notes any edges it emits. Active voice. No internal
   ticket references or monorepo paths.
3. **Export type maps** (`<VENDOR>_TYPE_MAP`, etc.) so consumers can
   override or extend the mapping.
4. **Register the adapter** in the `ADAPTERS` map in `src/index.ts` when
   `list()` is implemented. When `list()` requires API credentials, export
   the class without registering it. Consumers will instantiate it directly.
5. **Add a test file** at `src/__tests__/<vendor>-adapter.test.ts`
   covering: entity-type inference, status normalisation, edge emission,
   and at least one realistic source payload converted end-to-end.

## Test fixture conventions

Use synthetic data only. Keep real customer records, real workspace IDs,
real API tokens, and personal information out of test files.

Safe patterns:

- Companies: `Acme Corp`, `Globex`, `Initech`
- Emails: anything `@example.com` (RFC 2606 reserved)
- IDs: `prefix-001`, `notion-page-abc123`, `sfdc-001XXXXXX`
- People: role-based labels (`Mobile usability participant`), not real names

When you need to demonstrate a hex-looking ID, make it obviously fake.

## Coding standards

- TypeScript strict mode.
- Public signatures stay free of `any`.
- Status normalisation goes through a `<VENDOR>_STATUS_MAP`, not inline
  string literals.
- Adapters stand alone. They do not depend on each other.

## Filing issues

Bugs, mapping disagreements, and feature requests:
<https://github.com/unified-product-graph/adapters/issues>

Spec-level questions (canonical entity types, edge verbs) belong in the
core spec repository.

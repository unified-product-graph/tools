---
name: upg-send-feedback
description: "Share feedback about the Unified Product Graph: bugs, feature requests, ideas. Sent straight to the UPG team's triage queue."
user-invocable: true
argument-hint: "[bug|feature|observation]"
category: tooling
---

# /upg-send-feedback: Send Feedback to the UPG Team

You collect the user's feedback about the UPG and **send it via the `submit_feedback` MCP tool** so it lands directly in the maintainers' triage queue. Fast, transparent, private. No graph mutations; this is about THEIR feedback to US.

> **Mechanism:** this skill calls the native `mcp__unified-product-graph__submit_feedback` tool — the one write-OUT tool in the UPG surface. The tool is a thin HTTP client to `POST https://unifiedproductgraph.org/api/feedback`; it assembles context and enforces consent itself, so you do not `curl` and you do not gather context by hand.

**Before producing any output, read the design system:** `/upg-context` for emoji mappings, formatting rules, and shared interaction patterns.

## Tools

- `mcp__unified-product-graph__submit_feedback`: the send tool. Params: `type`, `title`, `description`, `details?`, `product_stage?`, `confirmed`. It auto-assembles `context` (client/server versions, runtime, and graph SIZE counts only) server-side — you never pass context, and no graph content is ever included.
- `Write`: ONLY as an offline fallback if the tool reports it could not reach the endpoint (see Step 7).

## Flow

### Step 1: Open

> Your feedback shapes how the Unified Product Graph evolves. This takes about **30 seconds**.

### Step 2: Ask Type

Skip this if the user provided `bug`, `feature`, or `observation` as an argument.

```
What kind of feedback?

1. bug; something broke or behaves unexpectedly
2. feature_request; something you wish existed
3. observation; a workflow friction, UX thought, or general note
4. general; anything else
```

ONE question. Wait for answer.

### Step 3: Ask Title

> Give it a one-sentence title.

Wait for answer.

### Step 4: Ask Description (and shape it to be actionable)

> Now the details; what were you doing, what happened, what did you expect?

Then SHAPE it so the team can act without a round-trip. Ask **one** short round of follow-ups only if the answer is thin; never guess. These become the tool's `details` object:

- **bug** → gather `steps_to_reproduce`, `expected`, `actual`, and a `severity` (low/medium/high/critical).
- **feature_request** → capture the underlying `problem` and `desired_outcome`, not just the proposed solution; note any current `workaround`.
- **observation / general** → the description is enough; omit `details`.

### Step 5: Preview (mandatory consent gate)

Do NOT set `confirmed` yet. Call the tool with the collected fields and **no `confirmed`** (or `confirmed: false`):

```
submit_feedback({
  type: "<type>",
  title: "<title>",
  description: "<description>",
  details: { <type-aware fields, omit if none> }
})
```

The tool sends NOTHING and returns `{ "status": "confirmation_required", "preview": { … } }`. The `preview` is the exact payload — including the auto-collected `context`. Show it to the user verbatim and get a yes:

```
Here's what I'll send to the UPG team:

  Type: <type>
  Title: "<title>"
  Description: "<description>"
  Details: <the type-aware fields, if any>
  Context: <the auto-collected context from the preview — client/server versions, runtime, graph counts>

No product graph data is included; just your feedback + the metadata above.

Send it? (y/n)
```

Wait for confirmation. If they say no, ask what to change or cancel gracefully. **Do not send without an explicit yes.**

### Step 6: Send

On an explicit yes, call the tool again with the **same fields plus `confirmed: true`**:

```
submit_feedback({
  type: "<type>",
  title: "<title>",
  description: "<description>",
  details: { <same as preview> },
  confirmed: true
})
```

A success returns `{ "status": "submitted", "id": "…", "message": "…" }`.

### Step 7: Confirm (or fall back offline)

On `status: "submitted"`:

```
Sent to the UPG team; thank you! Reference id: <id>

Your input directly shapes the Unified Product Graph.
```

The tool surfaces its own errors clearly:
- **429 (rate limited)** — tell the user to try again in about an hour. Nothing was saved.
- **401 (key rotated)** — ask the user to update `@unified-product-graph/mcp-server`.
- **Could not reach the endpoint** (network/offline) — fall back to local capture: use `Write` to save the feedback as `upg-feedback-YYYY-MM-DD.md` in the project root (append `-2`, `-3` if it exists), and tell the user:

```
Couldn't reach the feedback endpoint, so I saved it locally to upg-feedback-YYYY-MM-DD.md.
Send it when you're back online (open an issue at unifiedproductgraph.org and paste it in, or email it).
```

## Key Principles

- **FAST.** ~30 seconds. Type + title + description, shape if needed, preview, confirm, send.
- **One question at a time.** Never batch questions.
- **Send, don't stash.** The tool is the deliverable; the local file is only an offline fallback.
- **NEVER include product graph data.** The tool auto-assembles `context` from an allowlist (versions, runtime, SIZE counts) — never node titles, descriptions, or graph content. You never add context yourself.
- **Show before sending.** Use the tool's `confirmation_required` preview as the consent gate — the user must see and approve the exact payload before you re-call with `confirmed: true`.
- **No graph mutations.** Feedback only; no entities created.
- **Graceful degradation.** If the tool reports it couldn't reach the endpoint, save locally.

---
name: upg-feedback
description: "Share feedback about the Unified Product Graph — bugs, feature requests, ideas. Sent directly to the UPG team."
user-invocable: true
argument-hint: "[bug|feature|observation]"
category: tooling
---

# /upg-feedback — Share Feedback with the UPG Team

You collect user feedback about the UPG and send it to the team. Fast, transparent, private. No graph mutations — this is about THEIR feedback to US.

**Before producing any output, read the design system:** `/upg-context` for emoji mappings, formatting rules, and shared interaction patterns.

## Tools

- `mcp__unified-product-graph__get_product_context` and `mcp__unified-product-graph__get_graph_digest` — for automatic context gathering only
- `WebFetch` — to POST the feedback payload

## Flow

### Step 1: Open

> Your feedback shapes how the Unified Product Graph evolves. This takes about **30 seconds**.

### Step 2: Ask Type

Skip this if the user provided `bug`, `feature`, or `observation` as an argument.

```
What kind of feedback?

1. bug — something broke or behaves unexpectedly
2. feature_request — something you wish existed
3. observation — a workflow friction, UX thought, or general note
4. general — anything else
```

ONE question. Wait for answer.

### Step 3: Ask Title

> Give it a one-sentence title.

Wait for answer.

### Step 4: Ask Description

> Now the details — what were you doing, what happened, what did you expect? For feature requests: what would this unlock for you?

Wait for answer.

### Step 5: Gather Context (silent — no questions)

Collect metadata automatically. **Never read or send node titles, descriptions, or graph content.**

- **UPG version**: read from `get_product_context` if available, otherwise `"0.2.0"`
- **Product stage**: read from `get_product_context` if available
- **Entity count**: read from `get_graph_digest` if available
- **Recent skill**: scan conversation history for the most recent `/upg-*` invocation

If MCP calls fail, use defaults silently. Don't slow down the flow.

### Step 6: Show Payload (mandatory)

Transparency is critical. Show exactly what will be sent:

```
Here's what I'll send to the UPG team:

  Type: <type>
  Title: "<title>"
  Description: "<description>"
  Context: UPG v<version> · <stage> stage · <N> entities · from <skill>

No product graph data is included — just your feedback + metadata above.

Send it? (y/n)
```

Wait for confirmation. If they say no, ask what to change or cancel gracefully.

### Step 7: Send

POST to `https://cloud.unifiedproductgraph.org/api/feedback` with JSON body:

```json
{
  "type": "<bug|feature_request|observation|general>",
  "title": "<title>",
  "description": "<description>",
  "context": {
    "upg_version": "<version>",
    "product_stage": "<stage>",
    "entity_count": <N>,
    "from_skill": "<skill or null>"
  }
}
```

### Step 8: Confirm

On success:

```
Feedback sent — thank you!

Your input directly shapes the Unified Product Graph.
The team reviews every submission.
```

On failure (network error, non-2xx response): save feedback as markdown in the project root:

```
I couldn't reach the server right now. I've saved your feedback locally
  as upg-feedback-YYYY-MM-DD.md — you can send it manually or try again later.
```

The fallback file format:

```markdown
# UPG Feedback — YYYY-MM-DD

**Type:** <type>
**Title:** <title>
**Description:** <description>
**Context:** UPG v<version> · <stage> · <N> entities · from <skill>
```

## Key Principles

- **FAST.** 30 seconds. Three questions max (type + title + description), then confirm and send.
- **One question at a time.** Never batch questions.
- **NEVER send product graph data.** Only feedback text + opt-in metadata shown in the payload preview.
- **Show before sending.** The user must see and approve the exact payload.
- **No graph mutations.** Feedback only — no entities created.
- **Graceful degradation.** If MCP calls or the POST fail, keep going with defaults and local fallback.

┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄┄
Your .upg file is yours — open standard, portable, git-friendly.
unifiedproductgraph.org

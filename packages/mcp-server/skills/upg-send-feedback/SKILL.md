---
name: upg-send-feedback
description: "Share feedback about the Unified Product Graph: bugs, feature requests, ideas. Captured locally as a portable file you can send to the team."
user-invocable: true
argument-hint: "[bug|feature|observation]"
category: tooling
---

# /upg-send-feedback: Capture Feedback for the UPG Team

You collect user feedback about the UPG and write it to a local Markdown file in the project root. Fast, transparent, private. No graph mutations; this is about THEIR feedback to US.

There is no public feedback endpoint to submit to, and the `WebFetch` tool cannot POST a body anyway. So the path is **capture locally, then the user sends the file** (paste into a GitHub issue, email, or attach it). The local file IS the deliverable, not a fallback.

**Before producing any output, read the design system:** `/upg-context` for emoji mappings, formatting rules, and shared interaction patterns.

## Tools

- `mcp__unified-product-graph__get_product_context` and `mcp__unified-product-graph__get_graph_digest`: for automatic context gathering only
- `Write`: to save the feedback file to the project root

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

### Step 4: Ask Description

> Now the details; what were you doing, what happened, what did you expect? For feature requests: what would this unlock for you?

Wait for answer.

### Step 5: Gather Context (silent: no questions)

Collect metadata automatically. **Never read or send node titles, descriptions, or graph content.**

- **UPG version**: call `get_spec_version().upg_version` (falls back silently if unavailable)
- **Product stage**: read from `get_product_context` if available
- **Entity count**: read from `get_graph_digest` if available
- **Recent skill**: scan conversation history for the most recent `/upg-*` invocation

If MCP calls fail, use defaults silently. Don't slow down the flow.

### Step 6: Show Payload (mandatory)

Transparency is critical. Show exactly what will be written to the file:

```
Here's what I'll save for the UPG team:

  Type: <type>
  Title: "<title>"
  Description: "<description>"
  Context: UPG v<version> · <stage> stage · <N> entities · from <skill>

No product graph data is included; just your feedback + metadata above.

Save it? (y/n)
```

Wait for confirmation. If they say no, ask what to change or cancel gracefully.

### Step 7: Save

Use the `Write` tool to save the feedback as Markdown in the project root, filename `upg-feedback-YYYY-MM-DD.md` (use today's date; if a file with that name already exists, append `-2`, `-3`, etc. so nothing is overwritten).

The file format:

```markdown
# UPG Feedback: YYYY-MM-DD

**Type:** <bug|feature_request|observation|general>
**Title:** <title>
**Description:** <description>
**Context:** UPG v<version> · <stage> · <N> entities · from <skill>
```

### Step 8: Confirm

```
Saved to upg-feedback-YYYY-MM-DD.md; thank you!

To get it to the team, send the file however suits you:
- open an issue at unifiedproductgraph.org (follow the feedback link) and paste it in, or
- email it / attach the file.

Your input directly shapes the Unified Product Graph.
```

## Key Principles

- **FAST.** 30 seconds. Three questions max (type + title + description), then confirm and save.
- **One question at a time.** Never batch questions.
- **Capture locally.** There is no submit endpoint; write the file, the user sends it. The file is the deliverable.
- **NEVER include product graph data.** Only feedback text + opt-in metadata shown in the preview.
- **Show before saving.** The user must see and approve the exact payload.
- **No graph mutations.** Feedback only; no entities created.
- **Graceful degradation.** If MCP context calls fail, use defaults silently and still write the file.

---
name: upg-launch-detail
description: "Detailed discovery flow steps for /upg-new-launch"
---

# /upg-new-launch: Discovery Flow (Detail)

Loaded on demand when entering the guided launch planning flow.

> **MCP-first (applies to every create below).** Before creating any entity (GTM strategy, ICP, positioning, messaging, launch, acquisition channel, content strategy), call `get_entity_schema(<type>)`. Build `properties` from its `expected_properties`, set `status` **top-level** from one of the lifecycle phases the schema returns (don't hard-code the status enum), and pass any assessment as `{ value, label }`. Before any edge, call `get_entity_schema({ type: source_type, resolve_edge_to: target_type }).resolve_edge`: if it returns an edge, create it without an explicit `type:` (server infers); if it returns `null`, keep the relationship implicit (shared `parent_id`) rather than inventing an edge. The payloads below show shape and intent; the authoritative keys and phases come from the schema.

## Discovery Flow

### Starting Up

First, call `get_product_context` to understand the existing graph. Look for:
- Product description and stage
- Existing personas and ICPs (these define the launch audience)
- Business model entities (value props, revenue streams, pricing)
- Market segments (especially the beachhead)
- Features and releases (what's being launched)
- Competitors (positioning context)

If the user passed an argument (e.g., `/upg-new-launch beta release`), use it as context and jump straight into Step 1 with tailored options.

### Step 1: What Are You Launching?

> **Phase 1 of 4: Your positioning** (~5 minutes total)

Ask: **"What are you launching? Is this a new product, a major feature, or a milestone release?"**

Check for existing features and releases in the graph. Offer options:

```
1. <existing feature/release from graph>; launching this
2. The whole product; first public launch
3. A major new feature; <suggest based on product context>
4. A new pricing tier or plan
5. Something else; describe what you're putting out there
6. Not sure yet; we can skip this or come back to it
```

STOP. Wait for the answer.

Create the GTM strategy container:

```
// Read get_entity_schema("gtm_strategy") first, then:
create_node({
  type: "gtm_strategy",
  title: "<Product Name> GTM; <launch description>",
  description: "<what's being launched and why now>",
  properties: { /* keys from the schema, e.g. launch type, target date */ },
  parent_id: "<product_id>"
})
```

If an existing feature or release was selected, link them through a `launch` entity rather than the GTM strategy directly: resolve the GTM-strategy→launch edge with `get_entity_schema({ type, resolve_edge_to }).resolve_edge`, and the launch then relates to the feature/release it ships. Always confirm a pair has a canonical edge via `get_entity_schema({ type, resolve_edge_to }).resolve_edge` before connecting; if it returns `null`, note the relationship in the description rather than inventing an edge.

Confirm: "📣 **GTM strategy started** for <launch description>."

### Step 2: Ideal Customer

Ask: **"Who's the ideal customer for this launch? Who should hear about it first?"**

Check for existing personas, ICPs, and market segments. Offer options:

```
1. <existing persona>; they're the primary audience
2. <existing ICP from `/upg-walk-region market_intelligence`>; launch to the beachhead
3. <existing customer segment from `/upg-walk-region business_model`>; the paying segment
4. A new audience; <suggest based on launch type>
5. Different audience; tell me who this is for
6. Not sure yet; we can skip this or come back to it
```

STOP. Wait for the answer.

If they pick an existing entity, create an edge. If new, create an ICP:

```
// Read get_entity_schema("ideal_customer_profile") first, then:
create_node({
  type: "ideal_customer_profile",
  title: "<ICP name>",
  description: "<who they are, why they care about this launch>",
  properties: { /* keys from the schema, e.g. characteristics, pain level, awareness, buying stage */ },
  parent_id: "<gtm_strategy_id>"
})
```

Connect to existing persona if relevant; resolve the edge first:

```
// edge = get_entity_schema({ type: "ideal_customer_profile", resolve_edge_to: "persona" }).resolve_edge
create_edge({ source_id: "<icp_id>", target_id: "<persona_id>" })  // server infers type
```

Confirm: "🎯 **<ICP Name>** is the launch audience."

### Step 3: Positioning

Ask: **"How do you want to position this? What's the frame you want people to see <Product Name> through?"**

> *Positioning isn't a tagline; it's the mental category you want to own. It answers: "What is this, and why should I care?"*

Offer positioning frameworks:

```
1. Category leader; "The best <category> for <audience>"
2. Problem-first; "The solution to <specific painful problem>"
3. Against the status quo; "Unlike <current approach>, we <key difference>"
4. New category; "We're creating a new way to <do something>"
5. Different positioning; describe how you want to be seen
6. Not sure yet; we can skip this or come back to it
```

STOP. Wait for the answer.

Create the positioning entity:

```
// Read get_entity_schema("positioning") first, then:
create_node({
  type: "positioning",
  title: "<positioning statement>",
  description: "<expanded positioning narrative>",
  properties: { /* keys from the schema, e.g. framework, for-who, unlike, we-are, because */ },
  parent_id: "<gtm_strategy_id>"
})
```

If competitors exist in the graph, resolve the edge first:

```
// edge = get_entity_schema({ type: "positioning", resolve_edge_to: "competitor" }).resolve_edge
create_edge({ source_id: "<positioning_id>", target_id: "<competitor_id>" })  // server infers type
```

Confirm: "🎯 **Positioning locked in**: <brief summary>."

### Step 4: Key Message

Ask: **"What's the one message you want people to remember? If someone hears about <Product Name> from a friend, what do they say?"**

Offer message options based on the positioning and ICP:

```
1. "<message tied to positioning>"; leads with the differentiator
2. "<message tied to persona pain>"; leads with the problem
3. "<message tied to outcome>"; leads with the result
4. "<message tied to category>"; leads with the new frame
5. Different message; write it in your own words
6. Not sure yet; we can skip this or come back to it
```

STOP. Wait for the answer.

Create the messaging entity:

```
// Read get_entity_schema("messaging") first, then:
create_node({
  type: "messaging",
  title: "<headline message>",
  description: "<expanded messaging; the full narrative>",
  properties: { /* keys from the schema, e.g. headline, subheadline, proof points, tone */ },
  parent_id: "<gtm_strategy_id>"
})
```

Connect to positioning only if a canonical edge exists: call `get_entity_schema({ type: "messaging", resolve_edge_to: "positioning" }).resolve_edge`. If it returns `null`, keep the relationship implicit (both hang off the same `gtm_strategy` via `parent_id`) rather than inventing an edge type.

Confirm: "💬 **Key message set**: *\"<headline>\"*"

### Step 5: Launch Channels

Ask: **"What channels will you use to get this out there? Where does <ICP Name> hang out?"**

Offer channel options tailored to the ICP and product:

```
1. Product Hunt + Twitter/X; classic indie/startup launch
2. Email to existing users + blog post; warm audience first
3. Content marketing + SEO; long-game organic
4. LinkedIn + direct outreach; B2B professional networks
5. Community + word of mouth; Discord, Slack communities, Reddit
6. Paid ads; targeted campaigns on relevant platforms
7. Different channels; what works for your audience?
8. Not sure yet; we can skip this or come back to it
```

> **Launch channels vs growth channels:** Launch channels = where you make a splash on day one. Growth channels = where you build an ongoing engine. If you don't see a difference, we can merge them into one step.

Tell them they can pick multiple (e.g., "1, 2, and 5").

STOP. Wait for the answer.

For each channel, note it in the GTM strategy properties (channels are lightweight here, not separate entities unless the user wants to go deeper):

```
update_node({
  id: "<gtm_strategy_id>",
  properties: {
    ...,
    channels: ["<channel 1>", "<channel 2>", "<channel 3>"],
    primary_channel: "<the main one>"
  }
})
```

Confirm: "📣 **Channels mapped**: <primary channel> as the lead, supported by <others>."

### Step 6: Launch Timeline

Ask: **"What's the launch timeline? How do you want to phase this?"**

Offer phased approaches:

```
1. Soft launch → Beta → GA; gradual rollout over weeks
2. Big bang; pick a date, go all-in
3. Waitlist → Early access → Public; build anticipation first
4. Internal → Closed beta → Open; test with friendlies first
5. Different approach; tell me your timeline
6. Not sure yet; we can skip this or come back to it
```

STOP. Wait for the answer.

Create the launch entity with phases:

```
// Read get_entity_schema("launch") first, then:
create_node({
  type: "launch",
  title: "<Product Name> Launch; <type>",
  description: "<launch approach and rationale>",
  status: "<planning phase from the schema>",
  properties: {
    /* keys from the schema, e.g. approach, phases[], success metric */
    phases: [
      { "name": "<phase 1>", "target_date": "<date or timeframe>", "goal": "<what success looks like>" },
      { "name": "<phase 2>", "target_date": "<date or timeframe>", "goal": "<what success looks like>" }
    ]
  },
  parent_id: "<gtm_strategy_id>"
})
```

> **Note:** parent_id already creates an edge; don't create an explicit edge for the same relationship. The launch node is already connected to the GTM strategy via parent_id.

Confirm: "🚀 **Launch plan set**: <approach> with <n> phases."

### Step 7: Acquisition Channels (optional)

Ask: **"What channels will drive acquisition for <Product Name>? This goes beyond launch day; where will your ongoing growth come from?"**

Offer channel options tailored to the ICP and product:

```
1. SEO; rank for high-intent keywords your audience searches for
2. Social media; organic content on Twitter/X, LinkedIn, Instagram, TikTok
3. Referral program; existing users bring new users
4. Paid ads; targeted campaigns (Google, Meta, LinkedIn)
5. Content marketing; blog, newsletter, educational content
6. Partnerships; co-marketing, integrations, affiliates
7. Community; Discord, Slack, Reddit, forums
8. Product-led growth; free tier / freemium drives viral adoption
9. Different channels; tell me what works for your audience
10. Not sure yet; we can skip this or come back to it
```

Tell them they can pick multiple (e.g., "1, 3, and 5").

STOP. Wait for the answer.

Create an `acquisition_channel` entity for each selected channel:

```
// Read get_entity_schema("acquisition_channel") first, then:
create_node({
  type: "acquisition_channel",
  title: "<channel name>",
  description: "<how this channel works for the product and audience>",
  properties: { /* keys from the schema, e.g. channel type, cost model, time to impact, primary */ },
  parent_id: "<gtm_strategy_id>"
})
```

Connect each channel to its audience. Resolve the canonical edge first: `get_entity_schema({ type: "acquisition_channel", resolve_edge_to: "persona" }).resolve_edge` (channels typically reach the underlying persona rather than the ICP directly — confirm via the resolver). Then:

```
// edge = get_entity_schema({ type: "acquisition_channel", resolve_edge_to: "persona" }).resolve_edge
create_edge({ source_id: "<acquisition_channel_id>", target_id: "<persona_id>" })  // server infers type
```

Confirm: "📣 **<N> acquisition channels mapped**: <primary channel> as the lead growth engine."

### Step 8: Content Strategy (optional)

Ask: **"What content will you create to attract and educate <ICP Name>? Content fuels your acquisition channels."**

Offer content strategy options based on the channels and audience:

```
1. Blog + SEO; long-form articles targeting search intent
2. Newsletter; regular email content building trust over time
3. Social-first; short-form posts, threads, videos for social platforms
4. Educational; tutorials, guides, courses, documentation
5. Thought leadership; opinions, frameworks, industry analysis
6. Case studies + proof; customer stories, before/after, data
7. Video / podcast; YouTube, podcast, webinars
8. Different approach; tell me your content philosophy
9. Not sure yet; we can skip this or come back to it
```

STOP. Wait for the answer.

Create the `content_strategy` entity:

```
// Read get_entity_schema("content_strategy") first, then:
create_node({
  type: "content_strategy",
  title: "<Product Name> Content Strategy",
  description: "<content philosophy and approach>",
  properties: { /* keys from the schema, e.g. content types, primary format, cadence, audience, goal */ },
  parent_id: "<gtm_strategy_id>"
})
```

Connect to relevant acquisition channels only if a canonical edge exists: call `get_entity_schema({ type: "content_strategy", resolve_edge_to: "acquisition_channel" }).resolve_edge`. If it returns `null`, keep the relationship implicit (both hang off the same `gtm_strategy` via `parent_id`) rather than inventing an edge type.

Confirm: "📝 **Content strategy set**: <primary format> focused on <goal>."


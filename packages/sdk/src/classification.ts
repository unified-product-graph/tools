/**
 * UPG entity classification — three axes used by skills to determine
 * relevance:
 *
 * 1. **Business Area**: what question does this entity help answer?
 * 2. **Tier**: what stage of company maturity needs this?
 * 3. **Tier Cluster**: which capability group within team/scaleup tiers?
 *
 * Canonical reference; import from here rather than duplicating mappings.
 * Entity types are defined in `@unified-product-graph/core`. Use
 * `validateClassificationCoverage()` to detect drift between the spec and
 * this map.
 */

import { UPG_TYPES } from '@unified-product-graph/core'

// ─── Types ──────────────────────────────────────────────────────────────────────

export type BusinessArea =
  | 'identity'
  | 'understanding'
  | 'discovery'
  | 'reaching'
  | 'converting'
  | 'building'
  | 'sustaining'
  | 'learning'

export type Tier = 'solo' | 'team' | 'scaleup' | 'enterprise'

export type TierCluster =
  | 'team_coordination'
  | 'design_alignment'
  | 'user_signal'
  | 'growth_operations'
  | 'ecosystem_partnerships'
  | 'program_management'

// ─── Metadata ───────────────────────────────────────────────────────────────────

export const BUSINESS_AREA_META: Record<BusinessArea, { label: string; question: string; emoji: string }> = {
  identity:      { label: 'Identity',      question: 'What is this? Where is it going?',           emoji: '🧭' },
  understanding: { label: 'Understanding', question: 'Who needs this? What problem are we solving?', emoji: '🔍' },
  discovery:     { label: 'Discovery',     question: 'What should we build? What\'s the opportunity?', emoji: '💡' },
  reaching:      { label: 'Reaching',      question: 'How do people find out about this?',          emoji: '📣' },
  converting:    { label: 'Converting',    question: 'How does money come in?',                     emoji: '💰' },
  building:      { label: 'Building',      question: 'What does the user actually get?',            emoji: '🔨' },
  sustaining:    { label: 'Sustaining',    question: 'Is this financially viable?',                 emoji: '⚖️' },
  learning:      { label: 'Learning',      question: 'Is it working? How do we get better?',       emoji: '📊' },
}

export const TIER_DESCRIPTIONS: Record<Tier, { label: string; description: string }> = {
  solo:       { label: 'Solo Builder',  description: 'Everything one person needs to go from idea to product' },
  team:       { label: 'Small Team',    description: '2-10 people — coordination, design alignment, user signal' },
  scaleup:    { label: 'Scale-Up',      description: '10-50 people — growth operations, partnerships, program mgmt' },
  enterprise: { label: 'Enterprise',    description: '50+ people — full operational breadth across all domains' },
}

/** Tier entity counts — computed from ENTITY_CLASSIFICATION so they never drift */
export function getTierEntityCount(tier: Tier): number {
  const tierOrder: Tier[] = ['solo', 'team', 'scaleup', 'enterprise']
  const maxIndex = tierOrder.indexOf(tier)
  const includedTiers = new Set(tierOrder.slice(0, maxIndex + 1))
  return Object.values(ENTITY_CLASSIFICATION).filter(c => includedTiers.has(c.tier)).length
}

export const TIER_CLUSTER_META: Record<TierCluster, { label: string; description: string; tier: Tier }> = {
  team_coordination:      { label: 'Team Coordination',       description: 'Roles, dependencies, and milestones for small teams',              tier: 'team' },
  design_alignment:       { label: 'Design Alignment',        description: 'Prototypes, wireframes, and shared design language',               tier: 'team' },
  user_signal:            { label: 'User Signal',             description: 'Feature requests, feedback themes, and growth loops',              tier: 'team' },
  growth_operations:      { label: 'Growth Operations',       description: 'Campaigns, A/B tests, segments, and content calendars',            tier: 'scaleup' },
  ecosystem_partnerships: { label: 'Ecosystem & Partnerships', description: 'Partners, integrations, customer health, and support',            tier: 'scaleup' },
  program_management:     { label: 'Program Management',      description: 'Sprint plans, capacity plans, data sources, and roadmap items',    tier: 'scaleup' },
}

// ─── Entity Classification Map ──────────────────────────────────────────────────

interface EntityClassification {
  business_area: BusinessArea
  tier: Tier
  cluster?: TierCluster
}

export const ENTITY_CLASSIFICATION: Record<string, EntityClassification> = {
  // ═══════════════════════════════════════════════════════════════════════════════
  // SOLO BUILDER — 40 core types
  // ═══════════════════════════════════════════════════════════════════════════════

  // identity (3)
  product:                { business_area: 'identity',      tier: 'solo' },
  vision:                 { business_area: 'identity',      tier: 'solo' },
  mission:                { business_area: 'identity',      tier: 'solo' },

  // understanding (7)
  persona:                { business_area: 'understanding', tier: 'solo' },
  jtbd:                   { business_area: 'understanding', tier: 'solo' },
  need:                   { business_area: 'understanding', tier: 'solo' },
  pain_point:             { business_area: 'understanding', tier: 'solo' },
  research_study:         { business_area: 'understanding', tier: 'solo' },
  research_insight:       { business_area: 'understanding', tier: 'solo' },
  insight:                { business_area: 'understanding', tier: 'solo' },

  // discovery (5)
  opportunity:            { business_area: 'discovery',     tier: 'solo' },
  solution:               { business_area: 'discovery',     tier: 'solo' },
  competitor:             { business_area: 'discovery',     tier: 'solo' },
  hypothesis:             { business_area: 'discovery',     tier: 'solo' },
  experiment:             { business_area: 'discovery',     tier: 'solo' },
  learning:               { business_area: 'discovery',     tier: 'solo' },

  // reaching (5)
  ideal_customer_profile: { business_area: 'reaching',      tier: 'solo' },
  positioning:            { business_area: 'reaching',      tier: 'solo' },
  messaging:              { business_area: 'reaching',      tier: 'solo' },
  acquisition_channel:    { business_area: 'reaching',      tier: 'solo' },
  content_strategy:       { business_area: 'reaching',      tier: 'solo' },

  // converting (4)
  value_proposition:      { business_area: 'converting',    tier: 'solo' },
  pricing_tier:           { business_area: 'converting',    tier: 'solo' },
  funnel:                 { business_area: 'converting',    tier: 'solo' },
  funnel_step:            { business_area: 'converting',    tier: 'solo' },

  // building (7)
  feature_area:           { business_area: 'building',      tier: 'solo' },
  feature:                { business_area: 'building',      tier: 'solo' },
  user_story:             { business_area: 'building',      tier: 'solo' },
  epic:                   { business_area: 'building',      tier: 'solo' },
  release:                { business_area: 'building',      tier: 'solo' },
  user_journey:           { business_area: 'building',      tier: 'solo' },
  user_flow:              { business_area: 'building',      tier: 'solo' },

  // sustaining (5)
  business_model:         { business_area: 'sustaining',    tier: 'solo' },
  revenue_stream:         { business_area: 'sustaining',    tier: 'solo' },
  cost_structure:         { business_area: 'sustaining',    tier: 'solo' },
  unit_economics:         { business_area: 'sustaining',    tier: 'solo' },
  pricing_strategy:       { business_area: 'sustaining',    tier: 'solo' },

  // learning (6)
  outcome:                { business_area: 'learning',      tier: 'solo' },
  kpi:                    { business_area: 'learning',      tier: 'solo' },
  metric:                 { business_area: 'learning',      tier: 'solo' },
  objective:              { business_area: 'learning',      tier: 'solo' },
  key_result:             { business_area: 'learning',      tier: 'solo' },
  retrospective:          { business_area: 'learning',      tier: 'solo' },

  // ═══════════════════════════════════════════════════════════════════════════════
  // SMALL TEAM — +15 types (55 total)
  // ═══════════════════════════════════════════════════════════════════════════════

  // team_coordination cluster (5)
  team:                   { business_area: 'building',      tier: 'team', cluster: 'team_coordination' },
  role:                   { business_area: 'building',      tier: 'team', cluster: 'team_coordination' },
  stakeholder:            { business_area: 'identity',      tier: 'team', cluster: 'team_coordination' },
  dependency:             { business_area: 'building',      tier: 'team', cluster: 'team_coordination' },
  milestone:              { business_area: 'learning',      tier: 'team', cluster: 'team_coordination' },

  // design_alignment cluster (5)
  prototype:              { business_area: 'building',      tier: 'team', cluster: 'design_alignment' },
  wireframe:              { business_area: 'building',      tier: 'team', cluster: 'design_alignment' },
  design_component:       { business_area: 'building',      tier: 'team', cluster: 'design_alignment' },
  onboarding_flow:        { business_area: 'building',      tier: 'team', cluster: 'design_alignment' },
  screen:                 { business_area: 'building',      tier: 'team', cluster: 'design_alignment' },

  // user_signal cluster (5)
  feature_request:        { business_area: 'learning',      tier: 'team', cluster: 'user_signal' },
  feedback_theme:         { business_area: 'learning',      tier: 'team', cluster: 'user_signal' },
  beta_program:           { business_area: 'discovery',     tier: 'team', cluster: 'user_signal' },
  growth_loop:            { business_area: 'reaching',      tier: 'team', cluster: 'user_signal' },
  roadmap:                { business_area: 'building',      tier: 'team', cluster: 'user_signal' },

  // ═══════════════════════════════════════════════════════════════════════════════
  // SCALE-UP — +15 types (70 total)
  // ═══════════════════════════════════════════════════════════════════════════════

  // growth_operations cluster (5)
  campaign:               { business_area: 'reaching',      tier: 'scaleup', cluster: 'growth_operations' },
  ab_test:                { business_area: 'learning',      tier: 'scaleup', cluster: 'growth_operations' },
  segment:                { business_area: 'understanding', tier: 'scaleup', cluster: 'growth_operations' },
  growth_experiment:      { business_area: 'discovery',     tier: 'scaleup', cluster: 'growth_operations' },
  content_calendar:       { business_area: 'reaching',      tier: 'scaleup', cluster: 'growth_operations' },

  // ecosystem_partnerships cluster (5)
  partnership:            { business_area: 'reaching',      tier: 'scaleup', cluster: 'ecosystem_partnerships' },
  integration_partner:    { business_area: 'building',      tier: 'scaleup', cluster: 'ecosystem_partnerships' },
  customer_health_score:  { business_area: 'learning',      tier: 'scaleup', cluster: 'ecosystem_partnerships' },
  support_ticket:         { business_area: 'learning',      tier: 'scaleup', cluster: 'ecosystem_partnerships' },
  dashboard:              { business_area: 'learning',      tier: 'scaleup', cluster: 'ecosystem_partnerships' },

  // program_management cluster (4)
  capacity_plan:          { business_area: 'building',      tier: 'scaleup', cluster: 'program_management' },
  data_source:            { business_area: 'learning',      tier: 'scaleup', cluster: 'program_management' },
  event_schema:           { business_area: 'learning',      tier: 'scaleup', cluster: 'program_management' },
  roadmap_item:           { business_area: 'building',      tier: 'scaleup', cluster: 'program_management' },

  // ═══════════════════════════════════════════════════════════════════════════════
  // ENTERPRISE — everything else (311 total)
  // ═══════════════════════════════════════════════════════════════════════════════

  // Strategic expansion
  strategic_theme:        { business_area: 'identity',      tier: 'enterprise' },
  initiative:             { business_area: 'identity',      tier: 'enterprise' },
  capability:             { business_area: 'building',      tier: 'enterprise' },
  value_stream:           { business_area: 'building',      tier: 'enterprise' },
  strategic_pillar:       { business_area: 'identity',      tier: 'enterprise' },
  assumption:             { business_area: 'discovery',     tier: 'enterprise' },
  decision:               { business_area: 'identity',      tier: 'enterprise' },

  // User expansion
  desired_outcome:        { business_area: 'understanding', tier: 'enterprise' },
  job_step:               { business_area: 'understanding', tier: 'enterprise' },
  user_need:              { business_area: 'understanding', tier: 'enterprise' },
  switching_cost:         { business_area: 'understanding', tier: 'enterprise' },

  // Discovery expansion
  feasibility_study:      { business_area: 'discovery',     tier: 'enterprise' },
  design_sprint:          { business_area: 'discovery',     tier: 'enterprise' },

  // Validation expansion
  test_plan:              { business_area: 'discovery',     tier: 'enterprise' },
  evidence:               { business_area: 'learning',      tier: 'enterprise' },
  research_plan:          { business_area: 'understanding', tier: 'enterprise' },

  // Market Intelligence
  competitor_feature:     { business_area: 'discovery',     tier: 'enterprise' },
  market_trend:           { business_area: 'discovery',     tier: 'enterprise' },
  market_segment:         { business_area: 'understanding', tier: 'enterprise' },
  competitive_analysis:   { business_area: 'discovery',     tier: 'enterprise' },

  // UX Research
  participant:            { business_area: 'understanding', tier: 'enterprise' },
  observation:            { business_area: 'understanding', tier: 'enterprise' },
  quote:                  { business_area: 'understanding', tier: 'enterprise' },
  affinity_cluster:       { business_area: 'understanding', tier: 'enterprise' },
  research_question:      { business_area: 'understanding', tier: 'enterprise' },
  interview_guide:        { business_area: 'understanding', tier: 'enterprise' },
  finding:                { business_area: 'learning',      tier: 'enterprise' },
  survey_response:        { business_area: 'understanding', tier: 'enterprise' },
  highlight:              { business_area: 'understanding', tier: 'enterprise' },

  // Design
  journey_step:           { business_area: 'building',      tier: 'enterprise' },
  ux_insight:             { business_area: 'understanding', tier: 'enterprise' },
  how_might_we:           { business_area: 'discovery',     tier: 'enterprise' },
  design_concept:         { business_area: 'building',      tier: 'enterprise' },
  design_token:           { business_area: 'building',      tier: 'enterprise' },
  brand_identity:         { business_area: 'identity',      tier: 'enterprise' },
  brand_colour:           { business_area: 'building',      tier: 'enterprise' },
  brand_typography:       { business_area: 'building',      tier: 'enterprise' },
  brand_voice:            { business_area: 'reaching',      tier: 'enterprise' },
  design_pattern:         { business_area: 'building',      tier: 'enterprise' },
  design_guideline:       { business_area: 'building',      tier: 'enterprise' },
  annotation:             { business_area: 'building',      tier: 'enterprise' },
  interaction_spec:       { business_area: 'building',      tier: 'enterprise' },
  design_system:          { business_area: 'building',      tier: 'enterprise' },
  screen_state:           { business_area: 'building',      tier: 'enterprise' },

  // Product Spec
  acceptance_criterion:   { business_area: 'building',      tier: 'enterprise' },
  task:                   { business_area: 'building',      tier: 'enterprise' },
  bug:                    { business_area: 'building',      tier: 'enterprise' },
  theme:                  { business_area: 'identity',      tier: 'enterprise' },
  changelog:              { business_area: 'building',      tier: 'enterprise' },

  // Engineering
  bounded_context:        { business_area: 'building',      tier: 'enterprise' },
  service:                { business_area: 'building',      tier: 'enterprise' },
  domain_event:           { business_area: 'building',      tier: 'enterprise' },
  api_contract:           { business_area: 'building',      tier: 'enterprise' },
  architecture_decision:  { business_area: 'building',      tier: 'enterprise' },
  technical_debt_item:    { business_area: 'building',      tier: 'enterprise' },
  feature_flag:           { business_area: 'building',      tier: 'enterprise' },
  deployment:             { business_area: 'building',      tier: 'enterprise' },
  aggregate:              { business_area: 'building',      tier: 'enterprise' },
  domain_entity:          { business_area: 'building',      tier: 'enterprise' },
  value_object:           { business_area: 'building',      tier: 'enterprise' },
  command:                { business_area: 'building',      tier: 'enterprise' },
  read_model:             { business_area: 'building',      tier: 'enterprise' },
  api_endpoint:           { business_area: 'building',      tier: 'enterprise' },
  database_schema:        { business_area: 'building',      tier: 'enterprise' },
  queue_topic:            { business_area: 'building',      tier: 'enterprise' },
  build_artifact:         { business_area: 'building',      tier: 'enterprise' },
  code_repository:        { business_area: 'building',      tier: 'enterprise' },
  library_dependency:     { business_area: 'building',      tier: 'enterprise' },
  integration_pattern:    { business_area: 'building',      tier: 'enterprise' },
  external_api:           { business_area: 'building',      tier: 'enterprise' },
  data_flow:              { business_area: 'building',      tier: 'enterprise' },

  // Growth (remaining)
  north_star_metric:      { business_area: 'learning',      tier: 'enterprise' },
  input_metric:           { business_area: 'learning',      tier: 'enterprise' },
  cohort:                 { business_area: 'understanding', tier: 'enterprise' },
  variant:                { business_area: 'discovery',     tier: 'enterprise' },
  attribution_model:      { business_area: 'learning',      tier: 'enterprise' },

  // Business Model (remaining)
  key_resource:           { business_area: 'sustaining',    tier: 'enterprise' },
  key_activity:           { business_area: 'sustaining',    tier: 'enterprise' },
  customer_segment_bm:    { business_area: 'understanding', tier: 'enterprise' },
  channel_bm:             { business_area: 'reaching',      tier: 'enterprise' },
  customer_relationship:  { business_area: 'converting',    tier: 'enterprise' },
  distribution_channel:   { business_area: 'reaching',      tier: 'enterprise' },

  // Go-To-Market (remaining)
  gtm_strategy:           { business_area: 'reaching',      tier: 'enterprise' },
  launch:                 { business_area: 'reaching',      tier: 'enterprise' },
  sales_motion:           { business_area: 'converting',    tier: 'enterprise' },
  competitive_battle_card:{ business_area: 'reaching',      tier: 'enterprise' },
  demand_gen_program:     { business_area: 'reaching',      tier: 'enterprise' },
  territory:              { business_area: 'converting',    tier: 'enterprise' },
  objection:              { business_area: 'converting',    tier: 'enterprise' },
  rebuttal:               { business_area: 'converting',    tier: 'enterprise' },
  proof_point:            { business_area: 'converting',    tier: 'enterprise' },

  // Team & Organisation (remaining)
  product_decision:       { business_area: 'identity',      tier: 'enterprise' },
  team_okr:               { business_area: 'learning',      tier: 'enterprise' },
  department:             { business_area: 'building',      tier: 'enterprise' },
  skill:                  { business_area: 'building',      tier: 'enterprise' },
  ceremony:               { business_area: 'building',      tier: 'enterprise' },

  // Data & Analytics (remaining)
  metric_definition:      { business_area: 'learning',      tier: 'enterprise' },
  data_model:             { business_area: 'learning',      tier: 'enterprise' },
  data_quality_rule:      { business_area: 'learning',      tier: 'enterprise' },
  data_product:           { business_area: 'learning',      tier: 'enterprise' },
  data_pipeline:          { business_area: 'learning',      tier: 'enterprise' },
  data_lineage:           { business_area: 'learning',      tier: 'enterprise' },
  glossary_term:          { business_area: 'learning',      tier: 'enterprise' },
  data_domain:            { business_area: 'learning',      tier: 'enterprise' },
  report:                 { business_area: 'learning',      tier: 'enterprise' },

  // Content & Knowledge
  content_piece:          { business_area: 'reaching',      tier: 'enterprise' },
  knowledge_base_article: { business_area: 'reaching',      tier: 'enterprise' },
  brand_asset:            { business_area: 'reaching',      tier: 'enterprise' },
  internal_doc:           { business_area: 'building',      tier: 'enterprise' },
  prompt_template:        { business_area: 'building',      tier: 'enterprise' },
  content_theme:          { business_area: 'reaching',      tier: 'enterprise' },
  documentation_template: { business_area: 'building',      tier: 'enterprise' },

  // Legal & Compliance
  compliance_requirement: { business_area: 'sustaining',    tier: 'enterprise' },
  risk:                   { business_area: 'sustaining',    tier: 'enterprise' },
  data_contract:          { business_area: 'sustaining',    tier: 'enterprise' },
  legal_entity:           { business_area: 'sustaining',    tier: 'enterprise' },
  ip_asset:               { business_area: 'sustaining',    tier: 'enterprise' },
  audit_log_policy:       { business_area: 'sustaining',    tier: 'enterprise' },
  contract:               { business_area: 'sustaining',    tier: 'enterprise' },
  contract_clause:        { business_area: 'sustaining',    tier: 'enterprise' },
  privacy_policy:         { business_area: 'sustaining',    tier: 'enterprise' },
  compliance_framework:   { business_area: 'sustaining',    tier: 'enterprise' },
  security_audit:         { business_area: 'sustaining',    tier: 'enterprise' },

  // DevOps & Platform
  sli:                    { business_area: 'building',      tier: 'enterprise' },
  slo:                    { business_area: 'building',      tier: 'enterprise' },
  error_budget:           { business_area: 'building',      tier: 'enterprise' },
  incident:               { business_area: 'building',      tier: 'enterprise' },
  postmortem:             { business_area: 'learning',      tier: 'enterprise' },
  runbook:                { business_area: 'building',      tier: 'enterprise' },
  monitor:                { business_area: 'building',      tier: 'enterprise' },
  alert_rule:             { business_area: 'building',      tier: 'enterprise' },
  ci_pipeline:            { business_area: 'building',      tier: 'enterprise' },
  release_strategy:       { business_area: 'building',      tier: 'enterprise' },
  on_call_rotation:       { business_area: 'building',      tier: 'enterprise' },
  infrastructure_component: { business_area: 'building',    tier: 'enterprise' },

  // Security
  threat_model:           { business_area: 'sustaining',    tier: 'enterprise' },
  threat:                 { business_area: 'sustaining',    tier: 'enterprise' },
  vulnerability:          { business_area: 'sustaining',    tier: 'enterprise' },
  security_control:       { business_area: 'sustaining',    tier: 'enterprise' },
  security_policy:        { business_area: 'sustaining',    tier: 'enterprise' },
  security_incident:      { business_area: 'sustaining',    tier: 'enterprise' },
  penetration_test:       { business_area: 'sustaining',    tier: 'enterprise' },
  security_review:        { business_area: 'sustaining',    tier: 'enterprise' },
  data_classification:    { business_area: 'sustaining',    tier: 'enterprise' },
  access_policy:          { business_area: 'sustaining',    tier: 'enterprise' },

  // Accessibility
  a11y_standard:          { business_area: 'building',      tier: 'enterprise' },
  a11y_guideline:         { business_area: 'building',      tier: 'enterprise' },
  a11y_audit:             { business_area: 'building',      tier: 'enterprise' },
  a11y_issue:             { business_area: 'building',      tier: 'enterprise' },
  a11y_annotation:        { business_area: 'building',      tier: 'enterprise' },

  // QA & Testing
  test_suite:             { business_area: 'building',      tier: 'enterprise' },
  test_case:              { business_area: 'building',      tier: 'enterprise' },
  qa_session:             { business_area: 'building',      tier: 'enterprise' },
  regression_test:        { business_area: 'building',      tier: 'enterprise' },
  test_coverage_report:   { business_area: 'building',      tier: 'enterprise' },
  test_environment:       { business_area: 'building',      tier: 'enterprise' },
  defect_report:          { business_area: 'building',      tier: 'enterprise' },

  // Feedback & Voice of Customer (remaining)
  feedback_program:       { business_area: 'learning',      tier: 'enterprise' },
  feedback_vote:          { business_area: 'learning',      tier: 'enterprise' },
  nps_campaign:           { business_area: 'learning',      tier: 'enterprise' },
  user_advisory_board:    { business_area: 'learning',      tier: 'enterprise' },

  // Pricing & Packaging (remaining)
  pricing_experiment:     { business_area: 'converting',    tier: 'enterprise' },
  package:                { business_area: 'converting',    tier: 'enterprise' },
  discount_strategy:      { business_area: 'converting',    tier: 'enterprise' },
  trial_config:           { business_area: 'converting',    tier: 'enterprise' },
  paywall:                { business_area: 'converting',    tier: 'enterprise' },

  // AI/ML Operations
  ai_model:               { business_area: 'building',      tier: 'enterprise' },
  prompt_version:         { business_area: 'building',      tier: 'enterprise' },
  eval_benchmark:         { business_area: 'building',      tier: 'enterprise' },
  eval_run:               { business_area: 'building',      tier: 'enterprise' },
  ai_cost_tracker:        { business_area: 'sustaining',    tier: 'enterprise' },
  hallucination_report:   { business_area: 'learning',      tier: 'enterprise' },
  ai_guardrail:           { business_area: 'building',      tier: 'enterprise' },
  model_comparison:       { business_area: 'learning',      tier: 'enterprise' },

  // Agentic Workflows
  workflow_template:      { business_area: 'building',      tier: 'enterprise' },
  workflow_run:           { business_area: 'building',      tier: 'enterprise' },
  agent_definition:       { business_area: 'building',      tier: 'enterprise' },
  agent_session:          { business_area: 'building',      tier: 'enterprise' },
  review_gate:            { business_area: 'building',      tier: 'enterprise' },
  approval_record:        { business_area: 'building',      tier: 'enterprise' },
  agent_skill:            { business_area: 'building',      tier: 'enterprise' },
  agent_hook:             { business_area: 'building',      tier: 'enterprise' },
  workflow_artifact:      { business_area: 'building',      tier: 'enterprise' },

  // Portfolio & Organisation
  organization:           { business_area: 'identity',      tier: 'enterprise' },
  portfolio:              { business_area: 'identity',      tier: 'enterprise' },
  product_area:           { business_area: 'identity',      tier: 'enterprise' },

  // Workspace
  workspace:              { business_area: 'building',      tier: 'team', cluster: 'team_coordination' },

  // Sales & Revenue
  account:                { business_area: 'converting',    tier: 'enterprise' },
  contact:                { business_area: 'converting',    tier: 'enterprise' },
  lead:                   { business_area: 'converting',    tier: 'enterprise' },
  deal:                   { business_area: 'converting',    tier: 'enterprise' },
  pipeline_sales:         { business_area: 'converting',    tier: 'enterprise' },
  pipeline_stage:         { business_area: 'converting',    tier: 'enterprise' },
  quote_document:         { business_area: 'converting',    tier: 'enterprise' },
  subscription:           { business_area: 'converting',    tier: 'enterprise' },
  invoice:                { business_area: 'converting',    tier: 'enterprise' },
  forecast:               { business_area: 'converting',    tier: 'enterprise' },

  // Program Management
  program:                { business_area: 'building',      tier: 'enterprise' },
  project:                { business_area: 'building',      tier: 'enterprise' },
  risk_register:          { business_area: 'sustaining',    tier: 'enterprise' },
  risk_item:              { business_area: 'sustaining',    tier: 'enterprise' },
  change_request:         { business_area: 'building',      tier: 'enterprise' },
  deliverable:            { business_area: 'building',      tier: 'enterprise' },
  resource_allocation:    { business_area: 'building',      tier: 'enterprise' },
  status_report:          { business_area: 'learning',      tier: 'enterprise' },

  // Marketing Operations
  marketing_strategy:     { business_area: 'reaching',      tier: 'enterprise' },
  marketing_channel:      { business_area: 'reaching',      tier: 'enterprise' },
  marketing_campaign_plan:{ business_area: 'reaching',      tier: 'enterprise' },
  email_sequence:         { business_area: 'reaching',      tier: 'enterprise' },
  social_post:            { business_area: 'reaching',      tier: 'enterprise' },
  seo_keyword:            { business_area: 'reaching',      tier: 'enterprise' },
  ad_creative:            { business_area: 'reaching',      tier: 'enterprise' },
  press_release:          { business_area: 'reaching',      tier: 'enterprise' },
  event:                  { business_area: 'reaching',      tier: 'enterprise' },
  community_initiative:   { business_area: 'reaching',      tier: 'enterprise' },

  // Operations & Customer Success (remaining)
  customer_feedback:      { business_area: 'learning',      tier: 'enterprise' },
  churn_reason:           { business_area: 'learning',      tier: 'enterprise' },
  playbook:               { business_area: 'sustaining',    tier: 'enterprise' },
  sla:                    { business_area: 'sustaining',    tier: 'enterprise' },
  customer_journey_stage: { business_area: 'building',      tier: 'enterprise' },
  touchpoint:             { business_area: 'reaching',      tier: 'enterprise' },
  success_milestone:      { business_area: 'learning',      tier: 'enterprise' },
  service_blueprint:      { business_area: 'sustaining',    tier: 'enterprise' },
  nps_score:              { business_area: 'learning',      tier: 'enterprise' },

  // Localisation & i18n
  locale:                 { business_area: 'building',      tier: 'enterprise' },
  translation_key:        { business_area: 'building',      tier: 'enterprise' },
  translation_bundle:     { business_area: 'building',      tier: 'enterprise' },
  locale_config:          { business_area: 'building',      tier: 'enterprise' },
  cultural_adaptation:    { business_area: 'building',      tier: 'enterprise' },
  regional_pricing:       { business_area: 'converting',    tier: 'enterprise' },

  // Customer Education
  education_program:      { business_area: 'reaching',      tier: 'enterprise' },
  tutorial:               { business_area: 'reaching',      tier: 'enterprise' },
  walkthrough:            { business_area: 'reaching',      tier: 'enterprise' },
  webinar:                { business_area: 'reaching',      tier: 'enterprise' },
  certification:          { business_area: 'reaching',      tier: 'enterprise' },
  help_video:             { business_area: 'reaching',      tier: 'enterprise' },
  learning_path:          { business_area: 'reaching',      tier: 'enterprise' },

  // Partners & Ecosystem (remaining)
  partner_program:        { business_area: 'reaching',      tier: 'enterprise' },
  partner_tier:           { business_area: 'reaching',      tier: 'enterprise' },
  api_ecosystem:          { business_area: 'building',      tier: 'enterprise' },
  marketplace_listing:    { business_area: 'reaching',      tier: 'enterprise' },
  developer_portal:       { business_area: 'building',      tier: 'enterprise' },
  partner_revenue_share:  { business_area: 'converting',    tier: 'enterprise' },
}

// ─── Default classification for unknown types ───────────────────────────────────

const DEFAULT_CLASSIFICATION: EntityClassification = {
  business_area: 'building',
  tier: 'enterprise',
}

// ─── Helper functions ───────────────────────────────────────────────────────────

/** Get the classification for an entity type (falls back to enterprise/building for unknown types) */
export function getClassification(entityType: string): EntityClassification {
  return ENTITY_CLASSIFICATION[entityType] ?? DEFAULT_CLASSIFICATION
}

/** Get all entity types assigned to a specific tier (exact match, not cumulative) */
export function getEntitiesForTier(tier: Tier): string[] {
  return Object.entries(ENTITY_CLASSIFICATION)
    .filter(([, c]) => c.tier === tier)
    .map(([type]) => type)
}

/** Get all entity types assigned to a specific business area */
export function getEntitiesForBusinessArea(area: BusinessArea): string[] {
  return Object.entries(ENTITY_CLASSIFICATION)
    .filter(([, c]) => c.business_area === area)
    .map(([type]) => type)
}

/** Get all entity types for a tier AND business area intersection */
export function getEntitiesForTierAndArea(tier: Tier, area: BusinessArea): string[] {
  return Object.entries(ENTITY_CLASSIFICATION)
    .filter(([, c]) => c.tier === tier && c.business_area === area)
    .map(([type]) => type)
}

/** Get all entity types in a specific tier cluster */
export function getEntitiesForCluster(cluster: TierCluster): string[] {
  return Object.entries(ENTITY_CLASSIFICATION)
    .filter(([, c]) => c.cluster === cluster)
    .map(([type]) => type)
}

/**
 * Map a product stage to the appropriate tier.
 * Products at earlier stages need fewer entity types.
 */
export function getTierForStage(stage: string): Tier {
  switch (stage) {
    case 'idea':
    case 'mvp':
      return 'solo'
    case 'growth':
      return 'team'
    case 'scale':
      return 'scaleup'
    default:
      return 'solo'
  }
}

/**
 * Get all entity types available at a given tier (cumulative).
 * solo includes only solo. team includes solo + team. etc.
 */
export function getEntitiesUpToTier(tier: Tier): string[] {
  const tierOrder: Tier[] = ['solo', 'team', 'scaleup', 'enterprise']
  const maxIndex = tierOrder.indexOf(tier)
  const includedTiers = new Set(tierOrder.slice(0, maxIndex + 1))

  return Object.entries(ENTITY_CLASSIFICATION)
    .filter(([, c]) => includedTiers.has(c.tier))
    .map(([type]) => type)
}

/**
 * Check whether an entity type is relevant for a given product stage.
 * A type is relevant if its tier is at or below the tier for the stage.
 */
export function isRelevantForStage(entityType: string, stage: string): boolean {
  const tierOrder: Tier[] = ['solo', 'team', 'scaleup', 'enterprise']
  const stageTier = getTierForStage(stage)
  const entityTier = getClassification(entityType).tier
  return tierOrder.indexOf(entityTier) <= tierOrder.indexOf(stageTier)
}

// ─── Spec coverage validation ──────────────────────────────────────────────────

/**
 * Validates that ENTITY_CLASSIFICATION covers every type in @unified-product-graph/core.
 * Run at dev time or in tests to catch drift early.
 * Returns { missing, extra } — both should be empty for a healthy sync.
 */
export function validateClassificationCoverage(): {
  missing: string[]
  extra: string[]
} {
  const specTypes = new Set(UPG_TYPES)
  const classTypes = new Set(Object.keys(ENTITY_CLASSIFICATION))

  return {
    missing: [...specTypes].filter(t => !classTypes.has(t)),
    extra: [...classTypes].filter(t => !specTypes.has(t)),
  }
}

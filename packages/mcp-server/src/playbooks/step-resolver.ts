/**
 * Step resolver. The W2 mechanical lever on the CLI surface.
 *
 * For `kind: 'domain_guide'` steps, the runtime expands the step at execution
 * time by reading `DomainUsageGuide[domain_id]` from
 * `@unified-product-graph/core`. The playbook itself never carries the
 * creation sequence, so domain-shaped playbooks cannot hard-code one.
 */

import type { Step } from '@unified-product-graph/core'
import { UPG_DOMAIN_GUIDES, isDomainGuideStep } from '@unified-product-graph/core'

/** A step resolved to concrete runtime instructions. */
export type ResolvedStep =
  | {
      kind: 'domain_guide'
      order: number
      phase: string
      name?: string
      prompt_hint?: string
      domain_id: string
      /** The canonical entity type to create first in this domain. */
      anchor_entity: string
      /** The full creation sequence pulled from DomainUsageGuide at runtime. */
      creation_sequence: readonly string[]
      /** Cross-domain bridges the guide requires. */
      required_bridges: readonly {
        edge_type: string
        target_domain: string
        when: string
      }[]
      /** Common mistakes agents make; surface to the user. */
      anti_patterns: readonly string[]
    }
  | {
      kind: 'framework'
      order: number
      phase: string
      name?: string
      prompt_hint?: string
      framework_id: string
    }
  | {
      kind: 'entity_sequence'
      order: number
      phase: string
      name?: string
      prompt_hint?: string
      entity_types: readonly string[]
    }
  | {
      kind: 'sub_sequence'
      order: number
      phase: string
      name?: string
      prompt_hint?: string
      sub_sequence_id: string
    }

const _guideByDomain = new Map(
  UPG_DOMAIN_GUIDES.map((g) => [g.domain_id as string, g]),
)

/**
 * Resolve a playbook step to runtime instructions.
 *
 * For `domain_guide` steps, looks up the `DomainUsageGuide` and returns the
 * creation sequence, required bridges, and anti-patterns. Throws if the
 * referenced domain has no guide; that would be a spec drift bug.
 *
 * For other kinds, the resolver is a near-identity: the step's own fields
 * are the runtime instructions.
 */
export function resolveStep(step: Step): ResolvedStep {
  const base = {
    order: step.order,
    phase: step.phase,
    name: step.name,
    prompt_hint: step.prompt_hint,
  }

  switch (step.kind) {
    case 'domain_guide': {
      const guide = _guideByDomain.get(step.domain_id)
      if (!guide) {
        throw new Error(
          `Playbook step points at domain "${step.domain_id}" with no DomainUsageGuide. ` +
            `Either register a guide or use 'entity_sequence' instead.`,
        )
      }
      return {
        ...base,
        kind: 'domain_guide',
        domain_id: step.domain_id,
        anchor_entity: guide.anchor_entity,
        creation_sequence: guide.creation_sequence,
        required_bridges: guide.required_bridges.map((b) => ({
          edge_type: b.edge_type,
          target_domain: b.target_domain,
          when: b.when,
        })),
        // UPGAntiPattern carries name/description/affected_entity/remediation;
        // ResolvedStep keeps the legacy string[] shape; project to description.
        anti_patterns: guide.anti_patterns.map((a) => a.description),
      }
    }
    case 'framework':
      return { ...base, kind: 'framework', framework_id: step.framework_id }
    case 'entity_sequence':
      return { ...base, kind: 'entity_sequence', entity_types: step.entity_types }
    case 'sub_sequence':
      return { ...base, kind: 'sub_sequence', sub_sequence_id: step.sub_sequence_id }
    default: {
      const exhaustive: never = step
      throw new Error(`Unhandled playbook step: ${JSON.stringify(exhaustive)}`)
    }
  }
}

/** Re-export for convenience; step-kind helpers live in @unified-product-graph/core. */
export { isDomainGuideStep }

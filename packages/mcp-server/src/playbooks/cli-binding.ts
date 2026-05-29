/**
 * CLI playbook binding. Structure/experience split for the CLI surface.
 *
 * Reads canonical `UPGPlaybook` definitions from `@unified-product-graph/core`
 * and exposes the shared `PlaybookRuntime` contract, with a step resolver
 * that expands `domain_guide` steps via `DomainUsageGuide` at execution time.
 *
 * `/upg-explore` is the user-facing skill that drives this runtime.
 */

import type {
  PlaybookFilter,
  PlaybookRun,
  PlaybookRuntime,
  RunContext,
  StepOutput,
  Step,
  UPGPlaybook,
  UPGRegionId,
} from '@unified-product-graph/core'
import { UPG_PLAYBOOKS } from '@unified-product-graph/core'
import { nanoid } from 'nanoid'

export { resolveStep, type ResolvedStep } from './step-resolver.js'

/** The CLI surface renders playbooks as text prompts, one step at a time. */
export const CLI_PLAYBOOK_BINDING = {
  surface: 'cli' as const,
  renderer: 'text-prompt' as const,
}

/** Render a single step as a plain-text prompt; structure resolved to text only. */
export function renderCliStep(step: Step): string {
  const header = `[step ${step.order} · ${step.phase}]`
  switch (step.kind) {
    case 'domain_guide':
      return `${header} Follow the creation sequence for domain: ${step.domain_id}`
    case 'framework':
      return `${header} Apply framework: ${step.framework_id}`
    case 'entity_sequence':
      return `${header} Create entities: ${step.entity_types.join(', ')}`
    case 'sub_sequence':
      return `${header} Run sub-sequence: ${step.sub_sequence_id}`
    default: {
      const exhaustive: never = step
      throw new Error(`Unhandled playbook step: ${JSON.stringify(exhaustive)}`)
    }
  }
}

/**
 * Minimal in-memory runtime backed by a playbook registry. No persistence;
 * reference implementation for the shared contract. Real runs write through
 * to the `.upg` store.
 */
export function createInMemoryCliRuntime(
  registry: readonly UPGPlaybook[],
): PlaybookRuntime {
  const byId = new Map(registry.map((p) => [p.id, p]))
  const byRegion = new Map<UPGRegionId, UPGPlaybook[]>()
  for (const p of registry) {
    const list = byRegion.get(p.region) ?? []
    list.push(p)
    byRegion.set(p.region, list)
  }
  const runs = new Map<string, PlaybookRun>()

  return {
    listPlaybooks(filter?: PlaybookFilter): readonly UPGPlaybook[] {
      let out: readonly UPGPlaybook[] = registry
      if (filter?.region) {
        out = out.filter((p) => p.region === filter.region)
      }
      if (filter?.is_canonical !== undefined) {
        out = out.filter((p) => (p.is_canonical === true) === filter.is_canonical)
      }
      if (filter?.framework_id) {
        out = out.filter((p) => p.framework_id === filter.framework_id)
      }
      if (filter?.target_anchor_entity) {
        out = out.filter((p) => p.target_anchor_entity === filter.target_anchor_entity)
      }
      return out
    },

    getPlaybook(id: string): UPGPlaybook | null {
      return byId.get(id) ?? null
    },

    getCanonicalPlaybookForRegion(region: UPGRegionId): UPGPlaybook | null {
      const list = byRegion.get(region) ?? []
      return list.find((p) => p.is_canonical === true) ?? null
    },

    getPlaybooksForRegion(region: UPGRegionId): readonly UPGPlaybook[] {
      return byRegion.get(region) ?? []
    },

    startRun(playbook_id: string, context: RunContext): PlaybookRun {
      const p = byId.get(playbook_id)
      if (!p) throw new Error(`Unknown playbook: ${playbook_id}`)
      const run: PlaybookRun = {
        id: nanoid(),
        playbook_id,
        playbook_version: p.version,
        started_at: new Date().toISOString(),
        context,
        current_step_order: p.creation_sequence[0]?.order,
      }
      runs.set(run.id, run)
      return run
    },

    recordStep(run_id: string, step_order: number, output: StepOutput): void {
      const run = runs.get(run_id)
      if (!run) throw new Error(`Unknown run: ${run_id}`)
      run.current_step_order = step_order
      // Output is surface-owned in this stub; real runtime persists to the graph.
      void output
    },
  }
}

/**
 * The CLI runtime backed by the canonical playbook registry shipped in
 * `@unified-product-graph/core`. This is what `/upg-explore` reaches for;
 * any playbook in the registry becomes instantly runnable on the CLI surface
 * with no extra code.
 */
export function createCliRuntime(): PlaybookRuntime {
  return createInMemoryCliRuntime(UPG_PLAYBOOKS)
}

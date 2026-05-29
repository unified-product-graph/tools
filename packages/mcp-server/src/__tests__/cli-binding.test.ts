/**
 * CLI playbook binding tests (was workflow binding): validates the
 * structure/experience split end to end: `@unified-product-graph/core` types
 * compose with the CLI binding stub without any coupling between structure
 * and surface.
 */

import { describe, it, expect } from 'vitest'
import type { UPGPlaybook } from '@unified-product-graph/core'

import {
 CLI_PLAYBOOK_BINDING,
 createInMemoryCliRuntime,
 renderCliStep,
} from '../playbooks/cli-binding.js'

const PERSONA_PLAYBOOK: UPGPlaybook = {
 id: 'playbook:persona-discovery-test',
 name: 'Persona Discovery (test)',
 version: '0.1.0',
 description: 'Create a persona with JTBDs and pain points.',
 region: 'users_needs',
 is_canonical: true,
 target_anchor_entity: 'persona',
 creation_sequence: [
 {
 kind: 'domain_guide',
 order: 1,
 phase: 'Setup',
 domain_id: 'user',
 },
 {
 kind: 'entity_sequence',
 order: 2,
 phase: 'Build',
 entity_types: ['jtbd', 'pain_point'],
 },
 ],
}

describe('CLI playbook binding', () => {
 it('renders each step kind as text', () => {
 expect(renderCliStep(PERSONA_PLAYBOOK.creation_sequence[0])).toContain('domain: user')
 expect(renderCliStep(PERSONA_PLAYBOOK.creation_sequence[1])).toContain('jtbd, pain_point')
 })

 it('binding targets the cli surface via text-prompt renderer', () => {
 expect(CLI_PLAYBOOK_BINDING.surface).toBe('cli')
 expect(CLI_PLAYBOOK_BINDING.renderer).toBe('text-prompt')
 })

 it('runtime implements the shared PlaybookRuntime contract', () => {
 const runtime = createInMemoryCliRuntime([PERSONA_PLAYBOOK])

 expect(runtime.listPlaybooks()).toHaveLength(1)
 expect(runtime.getPlaybook('playbook:persona-discovery-test')?.name).toBe(
 'Persona Discovery (test)',
 )
 expect(runtime.getPlaybook('missing')).toBeNull()

 const run = runtime.startRun('playbook:persona-discovery-test', {
 graph_path: '/tmp/demo.upg',
 })
 expect(run.playbook_version).toBe('0.1.0')
 expect(run.current_step_order).toBe(1)

 runtime.recordStep(run.id, 2, { kind: 'response', response_text: 'done' })
 })

 it('listPlaybooks filters by region, canonical, framework, anchor', () => {
 const runtime = createInMemoryCliRuntime([PERSONA_PLAYBOOK])
 expect(runtime.listPlaybooks({ region: 'users_needs' })).toHaveLength(1)
 expect(runtime.listPlaybooks({ region: 'market_competitive' })).toHaveLength(0)
 expect(runtime.listPlaybooks({ is_canonical: true })).toHaveLength(1)
 expect(runtime.listPlaybooks({ is_canonical: false })).toHaveLength(0)
 expect(
 runtime.listPlaybooks({ target_anchor_entity: 'persona' }),
 ).toHaveLength(1)
 })

 it('region accessors return canonical playbooks correctly', () => {
 const runtime = createInMemoryCliRuntime([PERSONA_PLAYBOOK])
 const canonical = runtime.getCanonicalPlaybookForRegion('users_needs')
 expect(canonical?.id).toBe('playbook:persona-discovery-test')

 const all = runtime.getPlaybooksForRegion('users_needs')
 expect(all).toHaveLength(1)
 })
})

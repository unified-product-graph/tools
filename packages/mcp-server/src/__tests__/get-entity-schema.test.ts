/**
 * Regression tests for `get_entity_schema`.
 *
 * Deprecated entity-type aliases (jtbd → job, pain_point → need, kpi → metric)
 * must resolve to the canonical type's schema rather than returning empty.
 */
import { describe, it, expect } from 'vitest'
import { getEntitySchema } from '../tools/schema.js'
import type { ToolResult } from '../lib/server-context.js'

function callSchema(type: string) {
 const result = getEntitySchema({ type }, {} as never) as ToolResult
 if (result.isError) throw new Error(result.content[0].text)
 return JSON.parse(result.content[0].text)
}

describe('get_entity_schema', () => {
 it('returns the canonical schema for canonical types', () => {
 const job = callSchema('job')
 expect(job.type).toBe('job')
 expect(job.alias_of).toBeUndefined()
 expect(job.domain).toBeTruthy()
 })

 it('resolves jtbd → job and surfaces alias_of', () => {
 const jtbd = callSchema('jtbd')
 const job = callSchema('job')
 expect(jtbd.type).toBe('job')
 expect(jtbd.alias_of).toEqual({ from: 'jtbd', to: 'job' })
 // Schema body should match the canonical type (minus the alias_of marker).
 expect(jtbd.domain).toEqual(job.domain)
 expect(jtbd.expected_properties).toEqual(job.expected_properties)
 expect(jtbd.edges_out).toEqual(job.edges_out)
 })

 it('resolves pain_point → need and surfaces alias_of', () => {
 const pain = callSchema('pain_point')
 const need = callSchema('need')
 expect(pain.type).toBe('need')
 expect(pain.alias_of).toEqual({ from: 'pain_point', to: 'need' })
 expect(pain.domain).toEqual(need.domain)
 })

 it('returns experiment schema with no alias_of (experiment is canonical)', () => {
 const experiment = callSchema('experiment')
 expect(experiment.type).toBe('experiment')
 expect(experiment.alias_of).toBeUndefined()
 expect(experiment.domain).toBeTruthy()
 })

 it('rejects unknown entity types with a clear error', () => {
 const result = getEntitySchema({ type: 'not_a_real_type_xyz' }, {} as never) as ToolResult
 expect(result.isError).toBe(true)
 expect(result.content[0].text).toMatch(/Unknown entity type/)
 })

 it('still errors when type is missing', () => {
 const result = getEntitySchema({}, {} as never) as ToolResult
 expect(result.isError).toBe(true)
 expect(result.content[0].text).toMatch(/Missing required parameter/)
 })
})

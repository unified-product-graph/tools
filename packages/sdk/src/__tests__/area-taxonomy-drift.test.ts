/**
 * Area-taxonomy drift guard (0.9.16, A4). Core ships UPG_AREA_TAXONOMY, the
 * documented cross-walk between the three "area" groupings. Two of those
 * groupings have their runtime source of truth in THIS package:
 *
 *   - the 10 `digest.coverage` keys  -> BUSINESS_AREAS (lib/tools.ts)
 *   - the 8 "business areas"         -> BUSINESS_AREA_META (classification.ts)
 *
 * Core cannot import the SDK, so this test (which can import both) pins the
 * cross-walk's key sets against the live sources. If someone adds an 11th
 * coverage key or a 9th business area without updating UPG_AREA_TAXONOMY, this
 * fails loudly instead of letting the cross-walk go stale.
 */
import { describe, it, expect } from 'vitest'
import { UPG_AREA_TAXONOMY } from '@unified-product-graph/core'
import { BUSINESS_AREAS, BUSINESS_AREA_META } from '../index.js'

describe('UPG_AREA_TAXONOMY <-> SDK runtime sources', () => {
  it('coverage_key set matches digest.coverage BUSINESS_AREAS exactly', () => {
    const taxonomyKeys = UPG_AREA_TAXONOMY.map((e) => e.coverage_key).sort()
    const sdkKeys = Object.keys(BUSINESS_AREAS).sort()
    expect(taxonomyKeys).toEqual(sdkKeys)
  })

  it('every non-null business_area is one of the 8 BUSINESS_AREA_META keys', () => {
    const businessAreas = new Set(Object.keys(BUSINESS_AREA_META))
    for (const e of UPG_AREA_TAXONOMY) {
      if (e.business_area !== null) {
        expect(businessAreas.has(e.business_area), `${e.coverage_key} -> unknown business_area ${e.business_area}`).toBe(true)
      }
    }
  })

  it('every BUSINESS_AREA_META key is referenced by exactly one coverage key', () => {
    const referenced = UPG_AREA_TAXONOMY.map((e) => e.business_area).filter((b): b is string => b !== null).sort()
    expect(referenced).toEqual(Object.keys(BUSINESS_AREA_META).sort())
  })
})

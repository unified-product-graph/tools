/**
 * — terminal control-byte sanitisation (unit) and — friendly
 * error wrapping (unit). These exercise the pure functions directly; the
 * end-to-end behaviour against the built binary is covered in
 * cli-presentation.test.ts.
 */

import { describe, it, expect } from 'vitest'
import { sanitizeForTerminal } from '../lib/sanitize.js'
import { friendlyErrorMessage } from '../lib/errors.js'

// Build control chars by code so this source file itself stays free of raw
// control bytes (and never trips a terminal when grep'd).
const ESC = String.fromCharCode(0x1b)
const BEL = String.fromCharCode(0x07)
const NUL = String.fromCharCode(0x00)
const DEL = String.fromCharCode(0x7f)
const C1 = String.fromCharCode(0x9b) // CSI (C1 control)

describe(': sanitizeForTerminal', () => {
  it('escapes ESC to caret notation (^[)', () => {
    expect(sanitizeForTerminal(`${ESC}[31mred`)).toBe('^[[31mred')
  })

  it('escapes BEL to ^G', () => {
    expect(sanitizeForTerminal(`ding${BEL}`)).toBe('ding^G')
  })

  it('escapes NUL to ^@ and DEL to ^?', () => {
    expect(sanitizeForTerminal(`a${NUL}b${DEL}c`)).toBe('a^@b^?c')
  })

  it('escapes the full attack title from the ticket: no raw ESC/BEL remain', () => {
    const evil = `${ESC}[31mEVIL${ESC}[2J${ESC}[1;1Hgotcha${BEL}`
    const out = sanitizeForTerminal(evil)
    expect(out).toBe('^[[31mEVIL^[[2J^[[1;1Hgotcha^G')
    // Hard invariant: zero raw ESC or BEL bytes survive.
    expect(out).not.toContain(ESC)
    expect(out).not.toContain(BEL)
  })

  it('renders C1 controls as an inert \\uXXXX token', () => {
    expect(sanitizeForTerminal(`x${C1}y`)).toBe('x\\u009by')
  })

  it('folds TAB / newline / CR to a single space so a field stays on one line', () => {
    expect(sanitizeForTerminal('a\tb')).toBe('a b')
    expect(sanitizeForTerminal('a\nb')).toBe('a b')
    expect(sanitizeForTerminal('a\r\nb')).toBe('a b')
    expect(sanitizeForTerminal('a\n\n\nb')).toBe('a b')
  })

  it('leaves clean strings (incl. unicode) untouched', () => {
    expect(sanitizeForTerminal('Busy Parent')).toBe('Busy Parent')
    expect(sanitizeForTerminal('café ↦ 日本語')).toBe('café ↦ 日本語')
  })

  it('is idempotent for already-sanitised output', () => {
    const once = sanitizeForTerminal(`${ESC}[2J`)
    expect(sanitizeForTerminal(once)).toBe(once)
  })

  it('coerces null/undefined to an empty string', () => {
    expect(sanitizeForTerminal(null)).toBe('')
    expect(sanitizeForTerminal(undefined)).toBe('')
  })
})

describe(': friendlyErrorMessage', () => {
  it('wraps an EISDIR errno (code-tagged) into a directory message', () => {
    const err = Object.assign(new Error('EISDIR: illegal operation on a directory, read'), { code: 'EISDIR' })
    expect(friendlyErrorMessage(err)).toMatch(/it is a directory/i)
    expect(friendlyErrorMessage(err)).not.toMatch(/^EISDIR/)
  })

  it('wraps EACCES with the leaked path preserved', () => {
    const err = Object.assign(new Error("EACCES: permission denied, open '/abs/path.upg'"), { code: 'EACCES' })
    const out = friendlyErrorMessage(err)
    expect(out).toMatch(/permission denied/i)
    expect(out).toContain('/abs/path.upg')
    expect(out).not.toMatch(/^EACCES/)
  })

  it('wraps ENAMETOOLONG, keeping the path', () => {
    const err = Object.assign(new Error("ENAMETOOLONG: name too long, open '/x/aaaa.upg'"), { code: 'ENAMETOOLONG' })
    const out = friendlyErrorMessage(err)
    expect(out).toMatch(/path too long/i)
    expect(out).toContain('/x/aaaa.upg')
  })

  it('wraps the proper-lockfile "already being held" message', () => {
    const err = Object.assign(new Error('Lock file is already being held'), { code: 'ELOCKED' })
    expect(friendlyErrorMessage(err)).toMatch(/another process is writing this graph/i)
  })

  it('matches errno by message even when no .code is attached', () => {
    expect(friendlyErrorMessage(new Error('EISDIR: illegal operation on a directory, read'))).toMatch(/it is a directory/i)
  })

  it('passes unrelated messages through unchanged', () => {
    expect(friendlyErrorMessage(new Error('No .upg file at /tmp/x.upg'))).toBe('No .upg file at /tmp/x.upg')
    expect(friendlyErrorMessage('plain string')).toBe('plain string')
  })
})

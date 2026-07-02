import { describe, it, expect, beforeEach, afterAll } from 'vitest'

import { verifyToken, isAuthEnabled, extractToken, AUTH_COOKIE } from '@/lib/auth'

const ORIGINAL_TOKEN = process.env.RAZ_API_TOKEN

function makeHeaders(entries: Record<string, string> = {}): Headers {
  return new Headers(entries)
}

afterAll(() => {
  if (ORIGINAL_TOKEN === undefined) delete process.env.RAZ_API_TOKEN
  else process.env.RAZ_API_TOKEN = ORIGINAL_TOKEN
})

describe('isAuthEnabled()', () => {
  it('is false when RAZ_API_TOKEN is unset', () => {
    delete process.env.RAZ_API_TOKEN
    expect(isAuthEnabled()).toBe(false)
  })

  it('is false when RAZ_API_TOKEN is empty', () => {
    process.env.RAZ_API_TOKEN = ''
    expect(isAuthEnabled()).toBe(false)
  })

  it('is true when RAZ_API_TOKEN is set', () => {
    process.env.RAZ_API_TOKEN = 'secret'
    expect(isAuthEnabled()).toBe(true)
  })
})

describe('verifyToken()', () => {
  describe('auth disabled (no RAZ_API_TOKEN)', () => {
    beforeEach(() => {
      delete process.env.RAZ_API_TOKEN
    })

    it('accepts any candidate, including null', () => {
      expect(verifyToken(null)).toBe(true)
      expect(verifyToken(undefined)).toBe(true)
      expect(verifyToken('anything')).toBe(true)
    })
  })

  describe('auth enabled', () => {
    beforeEach(() => {
      process.env.RAZ_API_TOKEN = 'correct-horse-battery-staple'
    })

    it('accepts the exact token', () => {
      expect(verifyToken('correct-horse-battery-staple')).toBe(true)
    })

    it('rejects a wrong token', () => {
      expect(verifyToken('wrong-token')).toBe(false)
    })

    it('rejects null, undefined, and empty candidates', () => {
      expect(verifyToken(null)).toBe(false)
      expect(verifyToken(undefined)).toBe(false)
      expect(verifyToken('')).toBe(false)
    })

    it('rejects a candidate of different length without throwing', () => {
      expect(verifyToken('x')).toBe(false)
      expect(verifyToken('correct-horse-battery-staple-plus-extra')).toBe(false)
    })

    it('rejects a token that differs only in case', () => {
      expect(verifyToken('Correct-Horse-Battery-Staple')).toBe(false)
    })
  })
})

describe('extractToken()', () => {
  it('returns null when nothing is provided', () => {
    expect(extractToken(makeHeaders())).toBeNull()
  })

  it('reads a Bearer authorization header', () => {
    expect(extractToken(makeHeaders({ authorization: 'Bearer abc123' }))).toBe('abc123')
  })

  it('is case-insensitive on the Bearer prefix', () => {
    expect(extractToken(makeHeaders({ authorization: 'bearer abc123' }))).toBe('abc123')
  })

  it('ignores a non-Bearer authorization header and falls through', () => {
    expect(extractToken(makeHeaders({ authorization: 'Basic dXNlcg==' }), 'from-cookie')).toBe('from-cookie')
  })

  it('reads the x-raz-token header', () => {
    expect(extractToken(makeHeaders({ 'x-raz-token': 'header-token' }))).toBe('header-token')
  })

  it('falls back to the cookie value', () => {
    expect(extractToken(makeHeaders(), 'cookie-token')).toBe('cookie-token')
  })

  it('prefers Bearer over x-raz-token over cookie', () => {
    const headers = makeHeaders({ authorization: 'Bearer a', 'x-raz-token': 'b' })
    expect(extractToken(headers, 'c')).toBe('a')
    expect(extractToken(makeHeaders({ 'x-raz-token': 'b' }), 'c')).toBe('b')
  })

  it('falls through an empty Bearer value', () => {
    expect(extractToken(makeHeaders({ authorization: 'Bearer   ' }), 'cookie-token')).toBe('cookie-token')
  })

  it('exports the cookie name used by the login route', () => {
    expect(AUTH_COOKIE).toBe('raz_token')
  })
})

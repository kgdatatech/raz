import { createHash, timingSafeEqual } from 'crypto'

// Cookie set by /api/auth/login so browser dashboard sessions authenticate
// without attaching headers to every fetch.
export const AUTH_COOKIE = 'raz_token'

export function isAuthEnabled(): boolean {
  return Boolean(process.env.RAZ_API_TOKEN)
}

// Hashing both sides gives equal-length buffers, so timingSafeEqual never
// throws and comparison time leaks nothing about the token length.
export function verifyToken(candidate: string | null | undefined): boolean {
  const expected = process.env.RAZ_API_TOKEN
  if (!expected) return true
  if (!candidate) return false
  const a = createHash('sha256').update(candidate).digest()
  const b = createHash('sha256').update(expected).digest()
  return timingSafeEqual(a, b)
}

// Precedence: Authorization: Bearer > x-raz-token header > session cookie.
export function extractToken(headers: Headers, cookieValue?: string): string | null {
  const authHeader = headers.get('authorization')
  if (authHeader?.toLowerCase().startsWith('bearer ')) {
    const bearer = authHeader.slice(7).trim()
    if (bearer) return bearer
  }
  const headerToken = headers.get('x-raz-token')
  if (headerToken) return headerToken
  return cookieValue ?? null
}

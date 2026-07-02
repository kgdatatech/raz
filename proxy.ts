import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { AUTH_COOKIE, extractToken, isAuthEnabled, verifyToken } from './lib/auth'

// Routes that stay reachable without a token:
// - /api/webhook/github verifies its own HMAC signature
// - /api/health is a liveness probe
// - /login and /api/auth/login are how a browser session obtains the cookie
const PUBLIC_PATHS = ['/api/webhook/github', '/api/health', '/api/auth/login', '/login']

export function proxy(request: NextRequest): NextResponse {
  if (!isAuthEnabled()) return NextResponse.next()

  const { pathname } = request.nextUrl
  if (PUBLIC_PATHS.some((p) => pathname === p || pathname.startsWith(`${p}/`))) {
    return NextResponse.next()
  }

  const candidate = extractToken(request.headers, request.cookies.get(AUTH_COOKIE)?.value)
  if (verifyToken(candidate)) return NextResponse.next()

  if (pathname.startsWith('/api/')) {
    return NextResponse.json(
      { error: 'Unauthorized — send the RAZ API token via "Authorization: Bearer", "x-raz-token", or log in at /login.' },
      { status: 401 },
    )
  }
  return NextResponse.redirect(new URL('/login', request.url))
}

export const config = {
  matcher: ['/((?!_next/static|_next/image|favicon.ico|icon.svg).*)'],
}

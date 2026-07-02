import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { AUTH_COOKIE, isAuthEnabled, verifyToken } from '@/lib/auth'

export const runtime = 'nodejs'

const COOKIE_MAX_AGE_SECONDS = 30 * 24 * 60 * 60 // 30 days

export async function POST(req: NextRequest): Promise<NextResponse> {
  if (!isAuthEnabled()) {
    return NextResponse.json({ error: 'Auth is not enabled — RAZ_API_TOKEN is not configured.' }, { status: 400 })
  }

  const { token } = await req.json().catch(() => ({ token: undefined }))
  if (typeof token !== 'string' || !verifyToken(token)) {
    return NextResponse.json({ error: 'Invalid token.' }, { status: 401 })
  }

  const res = NextResponse.json({ ok: true })
  res.cookies.set({
    name:     AUTH_COOKIE,
    value:    token,
    httpOnly: true,
    sameSite: 'lax',
    path:     '/',
    maxAge:   COOKIE_MAX_AGE_SECONDS,
    secure:   req.nextUrl.protocol === 'https:',
  })
  return res
}

export async function DELETE(): Promise<NextResponse> {
  const res = NextResponse.json({ ok: true })
  res.cookies.set({ name: AUTH_COOKIE, value: '', httpOnly: true, sameSite: 'lax', path: '/', maxAge: 0 })
  return res
}

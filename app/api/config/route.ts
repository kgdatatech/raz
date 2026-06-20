import { NextRequest, NextResponse } from 'next/server'
import { getConfig, setConfig, getAllConfig } from '@/lib/db'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const key = req.nextUrl.searchParams.get('key')
  if (key) return NextResponse.json({ value: getConfig(key) })
  return NextResponse.json(getAllConfig())
}

export async function POST(req: NextRequest) {
  const { key, value } = await req.json().catch(() => ({}))
  if (!key || value === undefined) return NextResponse.json({ error: 'Missing key or value' }, { status: 400 })
  setConfig(String(key), String(value))
  return NextResponse.json({ ok: true })
}

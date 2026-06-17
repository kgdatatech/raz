import { NextRequest, NextResponse } from 'next/server'
import { listMemoryRows, deleteMemory, setMemory } from '@/lib/db'

export async function GET(req: NextRequest) {
  const repoId = Number(req.nextUrl.searchParams.get('repoId'))
  if (!repoId) return NextResponse.json([], { status: 400 })
  return NextResponse.json(listMemoryRows(repoId))
}

export async function DELETE(req: NextRequest) {
  const { repoId, key } = await req.json()
  if (!repoId || !key) return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
  deleteMemory(Number(repoId), key)
  return NextResponse.json({ ok: true })
}

export async function PATCH(req: NextRequest) {
  const { repoId, key, value } = await req.json()
  if (!repoId || !key || value === undefined) return NextResponse.json({ error: 'Missing fields' }, { status: 400 })
  setMemory(Number(repoId), key, value)
  return NextResponse.json({ ok: true })
}

import { NextRequest } from 'next/server'
import { listChatMessages, clearChatMessages } from '@/lib/db'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function GET(req: NextRequest) {
  const repoId = Number(req.nextUrl.searchParams.get('repoId'))
  if (!repoId) return Response.json({ messages: [] })
  return Response.json({ messages: listChatMessages(repoId) })
}

export async function DELETE(req: NextRequest) {
  const repoId = Number(req.nextUrl.searchParams.get('repoId'))
  if (!repoId) return Response.json({ ok: false })
  clearChatMessages(repoId)
  return Response.json({ ok: true })
}

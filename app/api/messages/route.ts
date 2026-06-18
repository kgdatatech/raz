import { NextRequest, NextResponse } from 'next/server'
import { listAgentMessages } from '@/lib/db'

export async function GET(req: NextRequest) {
  const repoId = Number(req.nextUrl.searchParams.get('repoId'))
  if (!repoId) return NextResponse.json([], { status: 400 })
  return NextResponse.json(listAgentMessages(repoId))
}

import { NextRequest, NextResponse } from 'next/server'
import { mergePR, closePR, reopenPR } from '@/lib/github'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const { action, owner, repo, prNumber } = await req.json().catch(() => ({}))
  if (!action || !owner || !repo || !prNumber) return NextResponse.json({ error: 'Missing params' }, { status: 400 })
  try {
    if (action === 'merge')  await mergePR(owner, repo, Number(prNumber))
    else if (action === 'close')  await closePR(owner, repo, Number(prNumber))
    else if (action === 'reopen') await reopenPR(owner, repo, Number(prNumber))
    else return NextResponse.json({ error: 'Unknown action' }, { status: 400 })
    return NextResponse.json({ ok: true })
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

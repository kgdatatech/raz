import { NextRequest, NextResponse } from 'next/server'
import { getPRDetails } from '@/lib/github'

export const runtime = 'nodejs'

export async function GET(req: NextRequest) {
  const { searchParams } = req.nextUrl
  const owner    = searchParams.get('owner')
  const repo     = searchParams.get('repo')
  const prNumber = Number(searchParams.get('prNumber'))
  if (!owner || !repo || !prNumber) return NextResponse.json({ error: 'Missing params' }, { status: 400 })
  try {
    const details = await getPRDetails(owner, repo, prNumber)
    return NextResponse.json(details)
  } catch (e) {
    return NextResponse.json({ error: String(e) }, { status: 500 })
  }
}

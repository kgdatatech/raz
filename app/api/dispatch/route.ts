import { NextResponse } from 'next/server'
import type { NextRequest } from 'next/server'
import { classifyIntent } from '@/lib/dispatch-ai'

export const runtime = 'nodejs'
export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest): Promise<NextResponse> {
  const { description } = await req.json().catch(() => ({ description: undefined }))
  if (typeof description !== 'string' || description.trim().length < 8) {
    return NextResponse.json({ error: 'Provide a task description of at least 8 characters.' }, { status: 400 })
  }
  return NextResponse.json(await classifyIntent(description.trim()))
}

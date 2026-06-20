import { NextRequest, NextResponse } from 'next/server'
import { getTaskLog } from '@/lib/db'

export const runtime = 'nodejs'

export async function GET(_req: NextRequest, { params }: { params: Promise<{ id: string }> }) {
  const { id } = await params
  const log = getTaskLog(id)
  return NextResponse.json(log ?? [])
}

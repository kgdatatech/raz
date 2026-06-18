import { NextRequest, NextResponse } from 'next/server'
import { getLatestPrStatus } from '@/lib/db'

export async function GET(req: NextRequest) {
  const taskId = req.nextUrl.searchParams.get('taskId')
  if (!taskId) return NextResponse.json(null, { status: 400 })
  return NextResponse.json(getLatestPrStatus(taskId) ?? null)
}

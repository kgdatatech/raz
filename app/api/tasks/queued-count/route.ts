import { NextResponse } from 'next/server'
import { countQueuedTasks } from '@/lib/db'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ count: countQueuedTasks() })
}

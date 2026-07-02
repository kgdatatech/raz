import { NextResponse } from 'next/server'
import { getSystemStatus } from '@/lib/db'
import { getSpendState } from '@/lib/spend'
import { getActiveTaskCount, getMaxConcurrentTasks } from '@/lib/queue-runner'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({
    ...getSystemStatus(),
    spend:  getSpendState(),
    runner: { active_tasks: getActiveTaskCount(), max_concurrent_tasks: getMaxConcurrentTasks() },
  })
}

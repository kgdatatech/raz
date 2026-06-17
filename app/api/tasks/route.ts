import { NextRequest, NextResponse } from 'next/server'
import { listTasks } from '@/lib/db'

export async function GET(req: NextRequest) {
  const repoId = req.nextUrl.searchParams.get('repoId')
  const tasks  = listTasks(repoId ? Number(repoId) : undefined)
  return NextResponse.json(tasks)
}

import { NextRequest, NextResponse } from 'next/server'
import { listTasks, deleteTask } from '@/lib/db'

export async function GET(req: NextRequest) {
  const repoId = req.nextUrl.searchParams.get('repoId')
  const tasks  = listTasks(repoId ? Number(repoId) : undefined)
  return NextResponse.json(tasks)
}

export async function DELETE(req: NextRequest) {
  const { id } = await req.json()
  if (!id) return NextResponse.json({ error: 'Missing id' }, { status: 400 })
  deleteTask(id as string)
  return NextResponse.json({ ok: true })
}

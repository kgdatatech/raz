import { NextRequest } from 'next/server'
import { answerQuestion } from '@/lib/db'

export const runtime = 'nodejs'

export async function POST(req: NextRequest) {
  const { questionId, answer } = await req.json().catch(() => ({}))
  if (!questionId || answer === undefined || answer === null) {
    return new Response(JSON.stringify({ error: 'Missing questionId or answer' }), { status: 400 })
  }
  answerQuestion(String(questionId), String(answer))
  return new Response(JSON.stringify({ ok: true }))
}

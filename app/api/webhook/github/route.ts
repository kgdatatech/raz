import { NextRequest, NextResponse } from 'next/server'
import { verifyGitHubSignature, handleGitHubWebhook, type GitHubPayload } from '@/lib/webhook-handler'

export const dynamic = 'force-dynamic'

export async function POST(req: NextRequest) {
  const rawBody  = await req.text()
  const sig      = req.headers.get('x-hub-signature-256') ?? ''
  const event    = req.headers.get('x-github-event') ?? ''

  const secret = process.env['GITHUB_WEBHOOK_SECRET']
  if (!secret) {
    return NextResponse.json({ error: 'GITHUB_WEBHOOK_SECRET not configured' }, { status: 500 })
  }

  if (!verifyGitHubSignature(secret, rawBody, sig)) {
    return NextResponse.json({ error: 'Invalid signature' }, { status: 401 })
  }

  let payload: GitHubPayload
  try {
    payload = JSON.parse(rawBody) as GitHubPayload
  } catch {
    return NextResponse.json({ error: 'Invalid JSON body' }, { status: 400 })
  }

  const result = await handleGitHubWebhook(event, payload)
  return NextResponse.json(result)
}

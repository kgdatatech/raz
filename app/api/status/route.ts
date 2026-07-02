import { NextResponse } from 'next/server'
import { getSystemStatus } from '@/lib/db'
import { getSpendState } from '@/lib/spend'

export const dynamic = 'force-dynamic'

export async function GET(): Promise<NextResponse> {
  return NextResponse.json({ ...getSystemStatus(), spend: getSpendState() })
}

import { NextRequest, NextResponse } from 'next/server'
import fs from 'fs'
import path from 'path'

const REPORTS_DIR = path.join(process.cwd(), '.raziel', 'reports')

function ensureDir() {
  fs.mkdirSync(REPORTS_DIR, { recursive: true })
}

// GET /api/reports          — list all reports
// GET /api/reports?file=X   — read a specific report file
export async function GET(req: NextRequest) {
  ensureDir()
  const file = req.nextUrl.searchParams.get('file')

  if (file) {
    const safe = path.basename(file) // prevent path traversal
    const full = path.join(REPORTS_DIR, safe)
    if (!fs.existsSync(full)) return NextResponse.json({ error: 'Not found' }, { status: 404 })
    const content = fs.readFileSync(full, 'utf-8')
    return NextResponse.json({ file: safe, content })
  }

  const files = fs.existsSync(REPORTS_DIR)
    ? fs.readdirSync(REPORTS_DIR)
        .filter((f) => f.endsWith('.md'))
        .sort()
        .reverse() // newest first
        .map((f) => {
          const stat = fs.statSync(path.join(REPORTS_DIR, f))
          return { file: f, size: stat.size, mtime: stat.mtime.toISOString() }
        })
    : []

  return NextResponse.json(files)
}

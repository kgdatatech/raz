const db = require('better-sqlite3')('.raziel/raziel.db')
const tasks = db.prepare('SELECT id, description, status, summary, plan, error, files_changed FROM tasks ORDER BY created_at DESC LIMIT 3').all()
for (const t of tasks) {
  console.log('--- TASK ---')
  console.log('id:', t.id)
  console.log('status:', t.status)
  console.log('error:', t.error)
  console.log('summary length:', t.summary?.length ?? 0)
  console.log('summary:', t.summary ?? '(null)')
  console.log('plan length:', t.plan?.length ?? 0)
  console.log('')
}
db.close()

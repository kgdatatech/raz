const db = require('better-sqlite3')('.raziel/raziel.db')
const r = db.prepare(
  "UPDATE tasks SET status='failed', error='Interrupted by server restart', completed_at=datetime('now') WHERE status='running'"
).run()
console.log('Fixed', r.changes, 'stuck task(s)')
db.close()

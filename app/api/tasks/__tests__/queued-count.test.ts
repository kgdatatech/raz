import { vi, describe, it, expect, beforeEach } from 'vitest'

/**
 * Pure unit test for GET /api/tasks/queued-count.
 * The DB module is fully mocked so no SQLite connection is needed here.
 * Correctness of countQueuedTasks() itself is covered in lib/__tests__/db.queued-count.test.ts.
 */
vi.mock('@/lib/db', () => ({
  countQueuedTasks: vi.fn(() => 0),
  // db is the default export — provide an empty stub so the import resolves
  default: {},
}))

import { GET, dynamic } from '@/app/api/tasks/queued-count/route'
import { countQueuedTasks } from '@/lib/db'

const mockCount = vi.mocked(countQueuedTasks)

describe('GET /api/tasks/queued-count', () => {
  beforeEach(() => {
    mockCount.mockReset()
  })

  it('exports dynamic = "force-dynamic" to opt out of Next.js caching', () => {
    expect(dynamic).toBe('force-dynamic')
  })

  it('returns { count: 0 } when no tasks are queued', async () => {
    mockCount.mockReturnValue(0)
    const response = await GET()
    const body = await response.json() as { count: number }
    expect(body).toEqual({ count: 0 })
  })

  it('returns { count: N } reflecting the real queue depth', async () => {
    mockCount.mockReturnValue(5)
    const response = await GET()
    const body = await response.json() as { count: number }
    expect(body.count).toBe(5)
  })

  it('count is always a non-negative integer', async () => {
    mockCount.mockReturnValue(12)
    const response = await GET()
    const body = await response.json() as { count: number }
    expect(typeof body.count).toBe('number')
    expect(body.count).toBeGreaterThanOrEqual(0)
    expect(Number.isInteger(body.count)).toBe(true)
  })

  it('calls countQueuedTasks() exactly once per request', async () => {
    mockCount.mockReturnValue(3)
    await GET()
    expect(mockCount).toHaveBeenCalledTimes(1)
  })
})

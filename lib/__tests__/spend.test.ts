import { vi, describe, it, expect, beforeEach } from 'vitest'

vi.hoisted(() => {
  process.env['RAZ_DB_PATH'] = ':memory:'
})

import db, { setConfig, getConfig } from '@/lib/db'
import {
  getDailyCapUsd, getTaskCapUsd, getTodaySpendUsd,
  recordTaskSpend, isDailyCapReached, getSpendState,
  DEFAULT_DAILY_CAP_USD, DEFAULT_TASK_CAP_USD,
} from '@/lib/spend'

function utcToday(): string {
  return new Date().toISOString().slice(0, 10)
}

function clearSpendConfig() {
  db.prepare(`DELETE FROM system_config WHERE key IN
    ('spend_daily_cap_usd', 'spend_task_cap_usd', 'spend_day', 'spend_today_usd')`).run()
}

describe('cap config parsing', () => {
  beforeEach(clearSpendConfig)

  it('returns defaults when keys are unset', () => {
    expect(getDailyCapUsd()).toBe(DEFAULT_DAILY_CAP_USD)
    expect(getTaskCapUsd()).toBe(DEFAULT_TASK_CAP_USD)
  })

  it('reads configured caps', () => {
    setConfig('spend_daily_cap_usd', '25')
    setConfig('spend_task_cap_usd', '0.5')
    expect(getDailyCapUsd()).toBe(25)
    expect(getTaskCapUsd()).toBe(0.5)
  })

  it('falls back to defaults on garbage or negative values', () => {
    setConfig('spend_daily_cap_usd', 'not-a-number')
    setConfig('spend_task_cap_usd', '-3')
    expect(getDailyCapUsd()).toBe(DEFAULT_DAILY_CAP_USD)
    expect(getTaskCapUsd()).toBe(DEFAULT_TASK_CAP_USD)
  })

  it('accepts 0 as a valid (disabled) cap', () => {
    setConfig('spend_daily_cap_usd', '0')
    expect(getDailyCapUsd()).toBe(0)
  })
})

describe('recordTaskSpend() and getTodaySpendUsd()', () => {
  beforeEach(clearSpendConfig)

  it('starts at zero', () => {
    expect(getTodaySpendUsd()).toBe(0)
  })

  it('accumulates spend across tasks', () => {
    recordTaskSpend(0.25)
    recordTaskSpend(0.5)
    expect(getTodaySpendUsd()).toBeCloseTo(0.75, 6)
  })

  it('ignores zero, negative, and non-finite costs', () => {
    recordTaskSpend(0)
    recordTaskSpend(-1)
    recordTaskSpend(NaN)
    recordTaskSpend(Infinity)
    expect(getTodaySpendUsd()).toBe(0)
  })

  it('sets spend_day to today on first record', () => {
    recordTaskSpend(0.1)
    expect(getConfig('spend_day')).toBe(utcToday())
  })

  it('resets the total when the UTC day changes', () => {
    setConfig('spend_day', '2020-01-01')
    setConfig('spend_today_usd', '9.99')
    expect(getTodaySpendUsd()).toBe(0)
    expect(getConfig('spend_day')).toBe(utcToday())
  })

  it('keeps accumulating within the same day', () => {
    recordTaskSpend(1)
    recordTaskSpend(2)
    expect(getTodaySpendUsd()).toBeCloseTo(3, 6)
  })
})

describe('isDailyCapReached()', () => {
  beforeEach(clearSpendConfig)

  it('returns false when under the cap', () => {
    setConfig('spend_daily_cap_usd', '5')
    recordTaskSpend(4.99)
    expect(isDailyCapReached()).toBe(false)
  })

  it('returns true when spend meets the cap', () => {
    setConfig('spend_daily_cap_usd', '5')
    recordTaskSpend(5)
    expect(isDailyCapReached()).toBe(true)
  })

  it('returns true when spend exceeds the cap', () => {
    setConfig('spend_daily_cap_usd', '5')
    recordTaskSpend(7.5)
    expect(isDailyCapReached()).toBe(true)
  })

  it('returns false when the cap is 0 (disabled)', () => {
    setConfig('spend_daily_cap_usd', '0')
    recordTaskSpend(1000)
    expect(isDailyCapReached()).toBe(false)
  })

  it('resets after a day rollover', () => {
    setConfig('spend_daily_cap_usd', '5')
    setConfig('spend_day', '2020-01-01')
    setConfig('spend_today_usd', '99')
    expect(isDailyCapReached()).toBe(false)
  })
})

describe('getSpendState()', () => {
  beforeEach(clearSpendConfig)

  it('returns a complete snapshot', () => {
    setConfig('spend_daily_cap_usd', '10')
    setConfig('spend_task_cap_usd', '2')
    recordTaskSpend(3.14159)
    const state = getSpendState()
    expect(state.day).toBe(utcToday())
    expect(state.today_usd).toBeCloseTo(3.1416, 4)
    expect(state.daily_cap_usd).toBe(10)
    expect(state.task_cap_usd).toBe(2)
    expect(state.cap_reached).toBe(false)
  })

  it('flags cap_reached when over the daily cap', () => {
    setConfig('spend_daily_cap_usd', '1')
    recordTaskSpend(1.5)
    expect(getSpendState().cap_reached).toBe(true)
  })

  it('never flags cap_reached when the cap is disabled', () => {
    setConfig('spend_daily_cap_usd', '0')
    recordTaskSpend(1000)
    expect(getSpendState().cap_reached).toBe(false)
  })
})

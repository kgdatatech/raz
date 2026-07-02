import { getConfig, setConfig } from './db'

// A cap value of 0 disables that cap.
export const DEFAULT_DAILY_CAP_USD = 10
export const DEFAULT_TASK_CAP_USD  = 2

export interface SpendState {
  day:           string
  today_usd:     number
  daily_cap_usd: number
  task_cap_usd:  number
  cap_reached:   boolean
}

function utcDay(): string {
  return new Date().toISOString().slice(0, 10)
}

function parseUsd(value: string | null, fallback: number): number {
  if (value === null || value === '') return fallback
  const n = Number(value)
  return Number.isFinite(n) && n >= 0 ? n : fallback
}

export function getDailyCapUsd(): number {
  return parseUsd(getConfig('spend_daily_cap_usd'), DEFAULT_DAILY_CAP_USD)
}

export function getTaskCapUsd(): number {
  return parseUsd(getConfig('spend_task_cap_usd'), DEFAULT_TASK_CAP_USD)
}

// Resets the accumulated total when the UTC day changes.
function rollSpendDay(): void {
  const today = utcDay()
  if (getConfig('spend_day') !== today) {
    setConfig('spend_day', today)
    setConfig('spend_today_usd', '0')
  }
}

export function getTodaySpendUsd(): number {
  rollSpendDay()
  return parseUsd(getConfig('spend_today_usd'), 0)
}

export function recordTaskSpend(costUsd: number): void {
  if (!Number.isFinite(costUsd) || costUsd <= 0) return
  rollSpendDay()
  const total = parseUsd(getConfig('spend_today_usd'), 0) + costUsd
  setConfig('spend_today_usd', total.toFixed(6))
}

export function isDailyCapReached(): boolean {
  const cap = getDailyCapUsd()
  if (cap <= 0) return false
  return getTodaySpendUsd() >= cap
}

export function getSpendState(): SpendState {
  const dailyCap = getDailyCapUsd()
  const today    = getTodaySpendUsd()
  return {
    day:           getConfig('spend_day') ?? utcDay(),
    today_usd:     Math.round(today * 10_000) / 10_000,
    daily_cap_usd: dailyCap,
    task_cap_usd:  getTaskCapUsd(),
    cap_reached:   dailyCap > 0 && today >= dailyCap,
  }
}

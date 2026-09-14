// Week bucketing shared by every Metrics chart. Weeks start Monday, local time.

export interface Week {
  start: Date
  end: Date
}

export function startOfWeek(date: Date): Date {
  const d = new Date(date)
  d.setDate(d.getDate() - ((d.getDay() + 6) % 7))
  d.setHours(0, 0, 0, 0)
  return d
}

// The last `n` weeks ending with the current one, oldest first.
export function lastNWeeks(n: number, now = new Date()): Week[] {
  const current = startOfWeek(now)
  return Array.from({ length: n }, (_, i) => {
    const start = new Date(current)
    start.setDate(start.getDate() - (n - 1 - i) * 7)
    const end = new Date(start)
    end.setDate(end.getDate() + 7)
    return { start, end }
  })
}

export function weekIndex(weeks: Week[], iso: string | undefined | null): number {
  if (!iso) return -1
  const t = new Date(iso).getTime()
  return weeks.findIndex((w) => t >= w.start.getTime() && t < w.end.getTime())
}

export function weekLabel(week: Week): string {
  return `${week.start.getMonth() + 1}/${week.start.getDate()}`
}

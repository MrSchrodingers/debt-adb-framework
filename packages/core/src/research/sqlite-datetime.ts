export function msToSqliteDatetime(ms: number): string {
  return new Date(ms).toISOString().replace('T', ' ').slice(0, 19)
}

export function sqliteDatetimeToMs(s: string): number {
  return new Date(s.replace(' ', 'T') + 'Z').getTime()
}

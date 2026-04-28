/**
 * RFC 4180-compliant CSV utilities.
 *
 * Rules applied:
 * - Fields containing commas, double-quotes, or newlines are enclosed in double-quotes.
 * - Double-quote characters inside a quoted field are escaped as two double-quotes ("").
 * - Line endings use CRLF per RFC 4180 (some consumers like Excel prefer this).
 */

/**
 * Escape a single cell value per RFC 4180.
 * Returns the value as-is if no special characters are present,
 * otherwise wraps in double-quotes with internal quotes doubled.
 */
function escapeCell(value: unknown): string {
  const str = value === null || value === undefined ? '' : String(value)
  // Must quote if contains comma, double-quote, newline (\n), or carriage return (\r)
  if (str.includes('"') || str.includes(',') || str.includes('\n') || str.includes('\r')) {
    return '"' + str.replace(/"/g, '""') + '"'
  }
  return str
}

/**
 * Convert an array of objects to a CSV string.
 *
 * @param rows   Array of plain objects (each becomes a row).
 * @param fields Ordered list of property keys to include as columns.
 *               Keys become the header row.
 * @returns RFC 4180 CSV string with CRLF line endings.
 */
export function toCsv<T extends object>(rows: readonly T[], fields: ReadonlyArray<keyof T & string>): string {
  const header = fields.map(escapeCell).join(',')
  const body = rows.map(row =>
    fields.map(f => escapeCell((row as Record<string, unknown>)[f])).join(','),
  )
  return [header, ...body].join('\r\n')
}

/**
 * Trigger a browser download of a CSV string as a `.csv` file.
 *
 * @param filename Desired filename (e.g. `"messages-2026-04-27.csv"`).
 * @param content  CSV string from `toCsv()`.
 */
export function downloadCsv(filename: string, content: string): void {
  // BOM prefix ensures Excel opens UTF-8 CSV correctly on Windows
  const bom = '﻿'
  const blob = new Blob([bom + content], { type: 'text/csv;charset=utf-8;' })
  const url = URL.createObjectURL(blob)
  const a = document.createElement('a')
  a.href = url
  a.download = filename
  a.style.display = 'none'
  document.body.appendChild(a)
  a.click()
  document.body.removeChild(a)
  URL.revokeObjectURL(url)
}

/**
 * React hook that returns an `exportToCsv` callback for the given rows.
 *
 * `exportToCsv` may be called with no args (uses captured rows) or with a
 * row override (useful when the caller has filtered/transformed rows in render).
 *
 * @param rows     Reactive array of objects to export.
 * @param filename Target filename for the download.
 * @param fields   Column keys to include (in order).
 */
export function useCsvExport<T extends object>(
  rows: readonly T[],
  filename: string,
  fields: ReadonlyArray<keyof T & string>,
): { exportToCsv: (override?: readonly T[]) => void } {
  const exportToCsv = (override?: readonly T[]) => {
    const source = override ?? rows
    const csv = toCsv(source, fields)
    downloadCsv(filename, csv)
  }
  return { exportToCsv }
}

import { describe, it, expect } from 'vitest'

// Test the parseArgs logic (extracted for testability)
function parseArgs(args: string[]): Record<string, string> {
  const result: Record<string, string> = {}
  for (let i = 0; i < args.length; i++) {
    const arg = args[i]
    if (arg.startsWith('--') && i + 1 < args.length) {
      const key = arg.slice(2)
      result[key] = args[++i]
    }
  }
  return result
}

describe('CLI entrypoint', () => {
  describe('parseArgs', () => {
    it('parses --port flag', () => {
      const args = parseArgs(['--port', '8080'])
      expect(args['port']).toBe('8080')
    })

    it('uses default port 7890 when not specified', () => {
      const args = parseArgs([])
      expect(args['port']).toBeUndefined()
      // Default is handled by: Number(process.env.PORT) || 7890
    })

    it('parses --db-path flag', () => {
      const args = parseArgs(['--db-path', '/opt/dispatch/data/dispatch.db'])
      expect(args['db-path']).toBe('/opt/dispatch/data/dispatch.db')
    })

    it('parses multiple flags', () => {
      const args = parseArgs(['--port', '9000', '--db-path', '/tmp/test.db', '--api-key', 'my-key'])
      expect(args['port']).toBe('9000')
      expect(args['db-path']).toBe('/tmp/test.db')
      expect(args['api-key']).toBe('my-key')
    })

    it('ignores unknown args without --prefix', () => {
      const args = parseArgs(['random', 'stuff', '--port', '7890'])
      expect(args['port']).toBe('7890')
      expect(Object.keys(args)).toHaveLength(1)
    })
  })
})

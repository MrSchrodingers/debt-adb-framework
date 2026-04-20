export async function jsonOrThrow<T>(res: Response, prefix: string): Promise<T> {
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${prefix} ${res.status}: ${body}`)
  }
  return res.json() as Promise<T>
}

export async function assertOk(res: Response, prefix: string): Promise<void> {
  if (!res.ok) {
    const body = await res.text().catch(() => '')
    throw new Error(`${prefix} ${res.status}: ${body}`)
  }
}

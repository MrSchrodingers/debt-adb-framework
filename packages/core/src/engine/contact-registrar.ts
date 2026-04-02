import type { AdbShellAdapter } from '../monitor/types.js'

export interface ContactRegistration {
  phone: string
  name: string
  registered: boolean
}

/**
 * Background contact pre-registration via Android intents.
 * Registers contacts on the target device before the send flow,
 * so the send engine doesn't need to wait.
 * Fallback: wa.me intent works without saved contacts.
 */
export class ContactRegistrar {
  private registeredCache = new Set<string>()

  constructor(
    private adb: AdbShellAdapter,
    private delay: (ms: number) => Promise<void> = (ms) => new Promise(r => setTimeout(r, ms)),
  ) {}

  /** Check if contact is already registered (cached) */
  isRegistered(phone: string): boolean {
    return this.registeredCache.has(phone)
  }

  /** Register a contact on the device via ACTION_INSERT intent */
  async register(
    deviceSerial: string,
    phone: string,
    name?: string,
  ): Promise<ContactRegistration> {
    if (this.registeredCache.has(phone)) {
      return { phone, name: name ?? '', registered: true }
    }

    const contactName = name ?? `Contato ${phone.slice(-4)}`

    try {
      // Open contact editor with pre-filled phone and name
      await this.adb.shell(
        deviceSerial,
        `am start -a android.intent.action.INSERT -t vnd.android.cursor.dir/contact --es phone "${phone}" --es name "${contactName}"`,
      )
      await this.delay(2000)

      // Dismiss contact editor (save prompt + editor) with BACK×2
      for (let i = 0; i < 2; i++) {
        await this.adb.shell(deviceSerial, 'input keyevent 4')
        await this.delay(500)
      }

      // Go HOME to clean state
      await this.adb.shell(deviceSerial, 'input keyevent 3')
      await this.delay(300)

      this.registeredCache.add(phone)
      return { phone, name: contactName, registered: true }
    } catch {
      // Registration failed — not critical, wa.me fallback works
      return { phone, name: contactName, registered: false }
    }
  }

  /** Batch register multiple contacts in background */
  async registerBatch(
    deviceSerial: string,
    contacts: Array<{ phone: string; name?: string }>,
  ): Promise<ContactRegistration[]> {
    const results: ContactRegistration[] = []
    for (const contact of contacts) {
      const result = await this.register(deviceSerial, contact.phone, contact.name)
      results.push(result)
    }
    return results
  }
}

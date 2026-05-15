// Placeholder — full Zod schema lands in Task 12 (B12).
// This stub keeps Task 11 scaffolding type-correct so the plugin
// constructor compiles before the validator is written.

export interface SdrTenantConfig {
  name: string
  devices: string[]
  senders: { phone: string; app: 'com.whatsapp' | 'com.whatsapp.w4b' }[]
}

export interface SdrPluginConfig {
  tenants: SdrTenantConfig[]
}

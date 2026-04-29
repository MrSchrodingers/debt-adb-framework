export { DeviceManager } from './device-manager.js'
export { HealthCollector } from './health-collector.js'
export { WaAccountMapper } from './wa-account-mapper.js'
export { AlertSystem } from './alert-system.js'
export { normalizeBrPhone } from './phone-normalizer.js'
export type { PhoneNormalizerLogger, NormalizeResult } from './phone-normalizer.js'
export {
  extractPhonesViaRoot,
  isDeviceRooted,
  listUserProfiles,
  parsePhoneFromSharedPrefs,
  parsePhoneFromMeFile,
} from './wa-phone-extractor-root.js'
export type { RootExtractionResult, RootExtractionSource } from './wa-phone-extractor-root.js'
export type { HealthSnapshot, Alert, AlertType, AlertSeverity, WhatsAppAccount, DeviceRecord, AdbShellAdapter } from './types.js'

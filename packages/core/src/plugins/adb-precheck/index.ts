export { PipeboardPg } from './postgres-client.js'
export { PipeboardRest, PipeboardRestError } from './pipeboard-rest.js'
export type { PipeboardRestOpts } from './pipeboard-rest.js'
export { PipeboardRawRest, NotSupportedByRawBackendError } from './pipeboard-raw-rest.js'
export type { PipeboardRawRestOpts } from './pipeboard-raw-rest.js'
export { PendingWritebacks } from './pending-writebacks.js'
export type { PendingWritebacksOpts } from './pending-writebacks.js'
export {
  PHONE_COLUMNS,
  resolvePipeboardBackend,
  NotSupportedByRestBackendError,
  NotSupportedBySqlBackendError,
} from './pipeboard-client.js'
export type {
  IPipeboardClient,
  HealthcheckResult,
  InvalidPhoneRecord,
  PhoneColumn,
  PipeboardBackend,
  DealInvalidationRequest,
  DealInvalidationResponse,
  DealLocalizationRequest,
  DealLocalizationResponse,
  DealLookupResult,
  DealLookupStatus,
  DealLookupInvalidatedPhone,
  AppliedPhone,
  AppliedPhoneStatus,
  BatchInvalidPhone,
  InvalidationFonte,
} from './pipeboard-client.js'
export { PrecheckJobStore } from './job-store.js'
export { PrecheckScanner } from './scanner.js'
export { extractPhones, normalizeBrPhone } from './phone-extractor.js'
export { PipedriveClient, TokenBucket } from './pipedrive-client.js'
export { PipedrivePublisher } from './pipedrive-publisher.js'
export {
  PipedriveActivityStore,
} from './pipedrive-activity-store.js'
export type {
  PipedriveActivityRow,
  PipedriveActivityInsert,
  PipedriveListFilters,
  PipedriveStatsRow,
  PipedriveScenario,
  PipedriveStatus,
} from './pipedrive-activity-store.js'
export {
  buildPhoneFailActivity,
  buildDealAllFailActivity,
  buildPastaSummaryNote,
  buildDealUrl,
  buildActivityUrl,
  formatBrPhonePretty,
  strategyLabel,
} from './pipedrive-formatter.js'
export {
  buildPipedriveRoutes,
  registerPipedrivePluginRoutes,
} from './pipedrive-api.js'
export type { PipedrivePluginApiDeps } from './pipedrive-api.js'
export type {
  ProvConsultaRow,
  DealKey,
  DealResult,
  PhoneOutcome,
  PhoneResult,
  PrecheckJob,
  PrecheckJobStatus,
  PrecheckScanParams,
  PipedriveActivityIntent,
  PipedriveNoteIntent,
  PipedriveOutgoingIntent,
  PipedrivePhoneEntry,
  PipedrivePhoneFailIntent,
  PipedriveDealAllFailIntent,
  PipedrivePastaSummaryIntent,
} from './types.js'
export {
  TenantRegistry,
  TenantConfigError,
  type TenantId,
  type TenantMode,
  type TenantConfig,
  type TenantWriteback,
} from './tenant-registry.js'

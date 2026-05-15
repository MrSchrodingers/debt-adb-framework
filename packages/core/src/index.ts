export { createServer } from './server.js'
export type { DispatchCore } from './server.js'
export { AdbBridge } from './adb/index.js'
export { MessageQueue } from './queue/index.js'
export { SendEngine } from './engine/index.js'
export { DispatchEmitter } from './events/index.js'
export type { DeviceInfo } from './adb/index.js'
export type { EnqueueParams, Message, MessageStatus } from './queue/index.js'
export type { SendResult } from './engine/index.js'
export type { DispatchEventMap, DispatchEventName } from './events/index.js'
export { SessionManager, WebhookHandler, MessageHistory, AckHistory } from './waha/index.js'
export type { WahaSessionInfo, WahaWebhookPayload, MessageHistoryRecord, WahaApiClient, AckHistoryRecord } from './waha/index.js'
export { calibrateAckRate } from './research/ack-rate-calibrator.js'
export type { AckEvent, CalibrationInput, CalibrationOutput, SenderCalibration } from './research/ack-rate-calibrator.js'
export { AckRateThresholds } from './research/ack-rate-thresholds.js'
export type { AckRateThresholdRecord, ApplyThresholdParams } from './research/ack-rate-thresholds.js'
export { AckPersistFailures } from './waha/ack-persist-failures.js'
export type { AckPersistFailureRecord } from './waha/ack-persist-failures.js'

// Engine surfaces required by external SDR-aware plugins for race-condition
// tests + integration tests. Not part of the steady-state plugin API, but
// exported so plugin authors can stand up realistic in-memory fixtures.
export { DeviceTenantAssignment } from './engine/device-tenant-assignment.js'
export type { DeviceAssignment, ClaimResult, ReleaseResult } from './engine/device-tenant-assignment.js'
export { SenderMapping } from './engine/sender-mapping.js'
export type { SenderMappingRecord, SenderConfig, ResolvedSender } from './engine/sender-mapping.js'
export { routeResponse } from './api/response-router.js'
export type { RouteResponseInput, RouteResponseDecision } from './api/response-router.js'

// Prometheus registry + SDR metric instruments (Task 40). Plugins can
// import these to attach to the same /metrics endpoint exposed by the
// dispatch core server. Other dispatch metrics stay internal.
export {
  metricsRegistry,
  sdrInvariantViolations,
  sdrQueueBlockedByTenant,
  sdrResponseDroppedMismatch,
  sdrClassifierCalls,
  sdrClassifierLatency,
  sdrSequenceLeads,
  sdrLlmCostUsdTotal,
} from './config/metrics.js'

// Plugin SDK surface — types only. External plugins (packages/plugins/*)
// import these to implement DispatchPlugin without reaching into core internals.
export type {
  DispatchPlugin,
  PluginContext,
  PluginEnqueueParams,
  PluginMessage,
  PluginLogger,
  QueueStats,
  HttpMethod,
  RouteHandler,
  CallbackType,
  ResultCallback,
  AckCallback,
  ResponseCallback,
  InterimFailureCallback,
  ExpiredCallback,
  NumberInvalidCallback,
  HygieneItemCallback,
  HygieneCompletedCallback,
  AssignmentResult,
  AssertTenantResult,
} from './plugins/types.js'

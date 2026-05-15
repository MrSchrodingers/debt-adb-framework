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

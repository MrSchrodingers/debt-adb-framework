export { SendEngine } from './send-engine.js'
export { SendStrategy } from './send-strategy.js'
export type { ChatOpenMethod, SendStrategyConfig } from './send-strategy.js'
export { SenderMapping } from './sender-mapping.js'
export type { SenderMappingRecord, CreateSenderMappingParams, ResolvedSender } from './sender-mapping.js'
export { ReceiptTracker, normalizeBrPhoneForMatching } from './receipt-tracker.js'
export { AccountMutex } from './account-mutex.js'
export { WahaFallback } from './waha-fallback.js'
export type { WahaFallbackResult } from './waha-fallback.js'
export type { RegisterSentParams, CorrelateOutgoingParams, CorrelationResult } from './receipt-tracker.js'
export type { SendResult } from './send-engine.js'
export { RateLimiter } from './rate-limiter.js'
export { Dispatcher, selectDevice, computeHealthScore } from './dispatcher.js'
export type { DispatchDecision } from './dispatcher.js'
export { BanDetector } from './ban-detector.js'
export { RetryManager } from './retry-manager.js'
export type { RetryDecision } from './retry-manager.js'
export { AutoRecovery } from './auto-recovery.js'
export { SenderHealth } from './sender-health.js'
export type { SenderHealthConfig } from './sender-health.js'
export { ContactRegistrar } from './contact-registrar.js'
export type { ContactRegistration } from './contact-registrar.js'
export { escapeForAdbContent } from './contact-utils.js'
export type {
  RateLimitConfig,
  RetryConfig,
  BanDetectionConfig,
  SendPhase,
  CanSendResult,
  OcrAnalysis,
  BehavioralProbeResult,
  BanCountdown,
  CrashDetection,
  RecoveryResult,
  SenderState,
  RateLimitStore,
} from './types.js'
export {
  DEFAULT_RATE_LIMIT_CONFIG,
  DEFAULT_RETRY_CONFIG,
  DEFAULT_BAN_DETECTION_CONFIG,
} from './types.js'

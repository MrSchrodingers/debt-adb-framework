// Phase 3 types — Send Engine Robusto + Anti-Ban

export interface RateLimitConfig {
  baseMinDelayS: number
  baseMaxDelayS: number
  volumeWindowMinutes: number
  volumeScaleThreshold: number
  volumeScaleFactor: number
  volumeMaxDelayS: number
  pairRateLimitS: number
  jitterMin: number
  jitterMax: number
  finalDelayFloorS: number
  finalDelayCapS: number
}

export interface RetryConfig {
  maxAttempts: number
  backoffBaseS: number
  backoffMultiplier: number
}

export interface BanDetectionConfig {
  ocrConfidenceThreshold: number
  banStrings: string[]
  probeIntervalMinutes: number
  unpauseBufferMinutes: number
}

export type SendPhase =
  | 'idle'
  | 'registering_contact'
  | 'opening_chat'
  | 'typing'
  | 'sending'
  | 'screenshotting'
  | 'recovering'

export interface CanSendResult {
  canSend: boolean
  waitMs: number
}

export interface OcrAnalysis {
  isSuspect: boolean
  confidence: number
  matchedStrings: string[]
}

export interface BehavioralProbeResult {
  isBanned: boolean
  hasInputField: boolean
}

export interface BanCountdown {
  durationMs: number
  rawText: string
}

export interface CrashDetection {
  crashed: boolean
  hasPid: boolean
}

export interface RecoveryResult {
  recovered: boolean
  action: 'force_stop' | 'back_reopen' | 'none'
}

export interface SenderState {
  senderNumber: string
  banned: boolean
  banExpiresAt: string | null
  sendCountInWindow: number
  lastSendAt: number | null
  cooldownExpiresAt: number | null
}

/** Abstraction over rate limit storage (Redis in prod, Map in tests) */
export interface RateLimitStore {
  getSendTimestamps(senderNumber: string): Promise<number[]>
  addSendTimestamp(senderNumber: string, timestamp: number): Promise<void>
  cleanExpiredTimestamps(senderNumber: string, windowMs: number): Promise<void>
  getLastPairSend(senderNumber: string, toNumber: string): Promise<number | null>
  setLastPairSend(senderNumber: string, toNumber: string, timestamp: number): Promise<void>
  getSendCount(senderNumber: string): Promise<number>
}

export const DEFAULT_RATE_LIMIT_CONFIG: RateLimitConfig = {
  baseMinDelayS: 20.0,
  baseMaxDelayS: 35.0,
  volumeWindowMinutes: 60,
  volumeScaleThreshold: 10,
  volumeScaleFactor: 1.5,
  volumeMaxDelayS: 120.0,
  pairRateLimitS: 6.0,
  jitterMin: 0.8,
  jitterMax: 1.5,
  finalDelayFloorS: 20.0,
  finalDelayCapS: 300.0,
}

export const DEFAULT_RETRY_CONFIG: RetryConfig = {
  maxAttempts: 5,
  backoffBaseS: 30,
  backoffMultiplier: 2.0,
}

export const DEFAULT_BAN_DETECTION_CONFIG: BanDetectionConfig = {
  ocrConfidenceThreshold: 0.6,
  banStrings: [
    'banned', 'suspended', 'verify your phone', 'verify your number',
    'unusual activity', 'captcha', 'confirm your identity',
    'banido', 'suspenso', 'verificar seu telefone', 'atividade incomum',
  ],
  probeIntervalMinutes: 5,
  unpauseBufferMinutes: 5,
}

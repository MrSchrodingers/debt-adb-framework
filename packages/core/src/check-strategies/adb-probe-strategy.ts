import type { AdbShellAdapter } from '../monitor/types.js'
import type { CheckStrategy, StrategyResult, CheckContext } from './types.js'
import { classifyUiState, type UiState } from './ui-state-classifier.js'

/**
 * Optional shared lock taker for the device. Injected from `engine`
 * (DeviceMutex) so the probe waits for the WorkerOrchestrator to
 * finish whatever it is sending before issuing a new wa.me intent on
 * the same screen — without this coordination the intent fires
 * mid-typing and WhatsApp moves the half-typed message into the
 * previous chat's draft.
 */
export interface DeviceLockTaker {
  acquire(deviceSerial: string): Promise<() => void>
}

/**
 * ADB UIAutomator probe — primary source of truth per grill D2.
 * Opens wa.me/<variant> via intent; checks UI dump for presence of
 * WhatsApp chat EditText (exists) vs invite-CTA (not_exists).
 * Never queries WhatsApp server → zero ban risk.
 */
export class AdbProbeStrategy implements CheckStrategy {
  readonly source = 'adb_probe' as const

  constructor(
    private adb: AdbShellAdapter,
    private delay: (ms: number) => Promise<void> = (ms) =>
      new Promise((r) => setTimeout(r, ms)),
    /**
     * Pass the same DeviceMutex instance the WorkerOrchestrator uses.
     * Optional — when omitted the probe runs without device-level
     * coordination (legacy behaviour, kept for tests).
     */
    private deviceMutex?: DeviceLockTaker,
  ) {}

  available(): boolean {
    return true
  }

  async probe(variant: string, ctx: CheckContext = {}): Promise<StrategyResult> {
    const deviceSerial = ctx.deviceSerial
    if (!deviceSerial) {
      throw new Error('AdbProbeStrategy: deviceSerial is required in context')
    }
    if (!/^\d{12,13}$/.test(variant)) {
      throw new Error(`AdbProbeStrategy: unsafe variant "${variant}"`)
    }
    if (ctx.profileId !== undefined && (!Number.isInteger(ctx.profileId) || ctx.profileId < 0)) {
      throw new Error(`AdbProbeStrategy: invalid profileId "${ctx.profileId}"`)
    }

    const started = Date.now()
    const timeoutMs = ctx.timeoutMs ?? 15_000
    const deadline = started + timeoutMs

    // Acquire the shared device lock BEFORE issuing the intent.
    // Without it a probe can fire `am start ... wa.me/X` while the
    // worker is mid-`input text`, and WhatsApp moves the half-typed
    // body into the previous chat's draft — that is the source of
    // the dozens of "rascunho" Oralsin messages reported in the
    // field. The release is in a finally so a thrown probe always
    // unblocks the worker.
    const release = this.deviceMutex
      ? await this.deviceMutex.acquire(deviceSerial)
      : () => {}
    try {
      // When the caller pinned a specific Android user we must move
      // it to foreground before dumping UIAutomator — `am start
      // --user N` only routes the intent, the dump always reads
      // whichever user is in foreground. Without an explicit switch
      // the probe answered for whoever happened to be on screen
      // (typically profile 0 / "Main Oralsin 2") and selecting a
      // different sender in the UI had no effect.
      if (ctx.profileId !== undefined) {
        const currentRaw = await this.adb.shell(deviceSerial, 'am get-current-user')
        const current = parseInt(currentRaw.trim(), 10)
        if (Number.isFinite(current) && current !== ctx.profileId) {
          await this.adb.shell(deviceSerial, `am switch-user ${ctx.profileId}`)
          // Poll `am get-current-user` until convergence — switch-user
          // returns immediately but the actual user transition is
          // async (Android stops the previous user, starts the new
          // one, focuses launcher). Without polling, the next intent
          // races the transition and lands on the wrong user.
          const switchDeadline = Date.now() + 10_000
          let converged = false
          while (Date.now() < switchDeadline) {
            await this.delay(1000)
            const probedRaw = await this.adb.shell(deviceSerial, 'am get-current-user')
            const probed = parseInt(probedRaw.trim(), 10)
            if (probed === ctx.profileId) {
              converged = true
              break
            }
          }
          if (!converged) {
            return {
              source: this.source,
              result: 'inconclusive',
              confidence: null,
              evidence: {
                switch_user_failed: true,
                requested_profile: ctx.profileId,
                last_seen_profile: current,
              },
              latency_ms: Date.now() - started,
              variant_tried: variant,
              device_serial: deviceSerial,
            }
          }
          // Allow the launcher / WA cold start to settle before the
          // intent. Mirrors WorkerOrchestrator.switchToUser.
          await this.delay(2000)
        }
      }
      // `--user N` is kept as a defence-in-depth: even though the user
      // is now in foreground, an explicit user routes the intent
      // unambiguously. The numeric guard above prevents shell
      // injection.
      const userArg = ctx.profileId !== undefined ? `--user ${ctx.profileId} ` : ''
      await this.adb.shell(
        deviceSerial,
        `am start ${userArg}-a android.intent.action.VIEW -d "https://wa.me/${variant}" -p com.whatsapp`,
      )
      // Give WA a moment to render the intent result before the first UI dump.
      await this.delay(1500)

      let xml = ''
      let pollCount = 0
      let sawSearching = false
      const pollIntervalMs = 1000
      let lastClassifierResult: ReturnType<typeof classifyUiState> | null = null

      // Poll until the classifier yields a decisive state (chat_open / invite_modal)
      // or a retryable state (returned immediately so Phase C's wrapper can recover
      // and retry), or the timeout fires. The `searching` state is the only one
      // that continues polling — all other non-decisive states exit immediately,
      // which is a deliberate behaviour change vs the old inline-regex loop (which
      // would continue polling on any non-matching state until the deadline).
      // Phase C's recover-and-retry wrapper is responsible for handling retryable
      // states; keeping the probe simple is the design intent.
      while (Date.now() < deadline) {
        await this.adb.shell(deviceSerial, 'uiautomator dump /sdcard/dispatch-probe.xml')
        xml = await this.adb.shell(deviceSerial, 'cat /sdcard/dispatch-probe.xml')
        pollCount++

        const result = classifyUiState({ xml })
        lastClassifierResult = result

        if (result.state === 'chat_open') {
          return {
            source: this.source,
            result: 'exists',
            confidence: 0.95,
            evidence: {
              ...result.evidence,
              ui_state: result.state,
              polls: pollCount,
              saw_searching: sawSearching,
            },
            latency_ms: Date.now() - started,
            variant_tried: variant,
            device_serial: deviceSerial,
          }
        }
        if (result.state === 'invite_modal') {
          return {
            source: this.source,
            result: 'not_exists',
            confidence: 0.95,
            evidence: {
              ...result.evidence,
              ui_state: result.state,
              polls: pollCount,
              saw_searching: sawSearching,
            },
            latency_ms: Date.now() - started,
            variant_tried: variant,
            device_serial: deviceSerial,
          }
        }
        if (result.state === 'searching') {
          sawSearching = true
          await this.delay(pollIntervalMs)
          continue
        }
        // result.state is one of: chat_list, contact_picker, disappearing_msg_dialog,
        // unknown_dialog, unknown — all retryable. Return immediately so Phase C's
        // wrapper can recover + retry. ui_state is preserved in evidence so the
        // wrapper knows which recovery action to take.
        return {
          source: this.source,
          result: 'inconclusive',
          confidence: null,
          evidence: {
            ...result.evidence,
            ui_state: result.state,
            polls: pollCount,
            saw_searching: sawSearching,
          },
          latency_ms: Date.now() - started,
          variant_tried: variant,
          device_serial: deviceSerial,
        }
      }

      // Deadline elapsed without classifier yielding a non-searching answer.
      return {
        source: this.source,
        result: 'inconclusive',
        confidence: null,
        evidence: {
          ...(lastClassifierResult?.evidence ?? {
            matched_rule: 'never_classified',
            dump_length: 0,
            has_modal_buttons: false,
            has_message_box: false,
          }),
          ui_state: lastClassifierResult?.state ?? 'unknown',
          polls: pollCount,
          saw_searching: sawSearching,
          timed_out: true,
        },
        latency_ms: Date.now() - started,
        variant_tried: variant,
        device_serial: deviceSerial,
      }
    } finally {
      release()
    }
  }

  /**
   * Recovery action for retryable UI states (Phase C — Level 1 retry).
   * Called between two `probe` attempts to bring WhatsApp back to a known
   * state before the second `am start wa.me/...` intent.
   *
   * - `disappearing_msg_dialog` and `unknown_dialog` are dismissable modals,
   *   so two BACK keyevents typically clear them with minimal disruption.
   * - All other retryable states (chat_list, contact_picker, unknown) require
   *   the heavier hammer of `am force-stop com.whatsapp`, which guarantees a
   *   cold start on the next intent.
   *
   * The wrapper that decides WHEN to call `recover` is added in C3.
   */
  private async recover(state: UiState, deviceSerial: string): Promise<void> {
    if (state === 'disappearing_msg_dialog' || state === 'unknown_dialog') {
      await this.adb.shell(deviceSerial, 'input keyevent 4')
      await this.delay(250)
      await this.adb.shell(deviceSerial, 'input keyevent 4')
      await this.delay(500)
      return
    }
    // chat_list, contact_picker, unknown — force-stop is the safe hammer.
    await this.adb.shell(deviceSerial, 'am force-stop com.whatsapp')
    await this.delay(1500)
  }
}

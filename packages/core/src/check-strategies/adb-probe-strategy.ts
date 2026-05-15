import type { AdbShellAdapter } from '../monitor/types.js'
import type { CheckStrategy, StrategyResult, CheckContext } from './types.js'
import { classifyUiState, type UiState } from './ui-state-classifier.js'
import type { ProbeSnapshotWriter } from '../snapshots/probe-snapshot-writer.js'
import { xmlContainsVariantDigits } from './probe-sanity.js'
import type { DeviceMutexCtx } from '../engine/device-mutex.js'

/**
 * Optional shared lock taker for the device. Injected from `engine`
 * (DeviceMutex) so the probe waits for the WorkerOrchestrator to
 * finish whatever it is sending before issuing a new wa.me intent on
 * the same screen — without this coordination the intent fires
 * mid-typing and WhatsApp moves the half-typed message into the
 * previous chat's draft.
 *
 * `ctx` carries the optional `{ tenant, jobId }` holder description
 * propagated from `CheckContext`. It is observational only — the
 * mutex uses it to label the holder for debug/monitoring.
 */
export interface DeviceLockTaker {
  acquire(deviceSerial: string, ctx?: DeviceMutexCtx): Promise<() => void>
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
    /**
     * Optional snapshot writer — when provided, persists the raw XML dump
     * to disk whenever the classifier returns `unknown` or `unknown_dialog`.
     * Omit to disable snapshot capture (e.g. in unit tests).
     */
    private snapshotWriter?: ProbeSnapshotWriter,
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

    // Acquire the shared device lock ONCE before either attempt.
    // Both probeOnce() calls share this lock — it is released in the
    // finally block regardless of outcome.
    const release = this.deviceMutex
      ? await this.deviceMutex.acquire(deviceSerial, {
          tenant: ctx.tenant ?? '(unknown)',
          jobId: ctx.jobId ?? '(unknown)',
        })
      : () => {}
    try {
      // Attempt 1
      const r1 = await this.probeOnce(variant, ctx, 'probe_initial')
      if (r1.result !== 'inconclusive') return r1

      const uiState = (r1.evidence as Record<string, unknown> | undefined)?.ui_state as UiState | 'stale_ui' | undefined
      if (!uiState || !this.isRetryableUiState(uiState)) return r1

      // Recover and retry once — each probeOnce() has its own time budget.
      await this.recover(uiState, deviceSerial)
      return await this.probeOnce(variant, ctx, 'probe_recover')
    } finally {
      release()
    }
  }

  /**
   * Returns true for UI states that are safe to recover-and-retry.
   * `searching` is intentionally excluded: it keeps polling internally
   * inside probeOnce() and only surfaces as `searching` via the
   * deadline-elapsed path, which is not a recoverable condition.
   *
   * `'stale_ui'` is not a UiState enum value — it is a sentinel string
   * written into evidence.ui_state by Layer 2 (sanity check). Including
   * it here causes the probe wrapper to force-stop and retry, which is
   * the correct recovery action (the next probeOnce will start with a
   * fresh force-stop from Layer 1, giving WhatsApp a clean slate).
   */
  private isRetryableUiState(s: UiState | string): boolean {
    return (
      s === 'chat_list' ||
      s === 'contact_picker' ||
      s === 'disappearing_msg_dialog' ||
      s === 'unknown_dialog' ||
      s === 'unknown' ||
      s === 'stale_ui' // Layer 2 sentinel — detected stale XML from previous probe
    )
  }

  /**
   * Core probe logic — isolated from the device lock and retry wrapper.
   * Each call gets its own `started`/`deadline` so the retry has a full
   * independent time budget. Total worst-case = 2 × timeoutMs.
   *
   * `attemptPhase` is injected into every return path's evidence so
   * downstream validators can distinguish initial vs recovery attempts.
   */
  private async probeOnce(
    variant: string,
    ctx: CheckContext,
    attemptPhase: 'probe_initial' | 'probe_recover',
  ): Promise<StrategyResult> {
    const deviceSerial = ctx.deviceSerial!
    const started = Date.now()
    const timeoutMs = ctx.timeoutMs ?? 15_000
    const deadline = started + timeoutMs

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
              attempt_phase: attemptPhase,
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

    // Layer 1 defense — force-stop com.whatsapp before the intent so we always
    // boot from a clean state. Eliminates the entire class of "stale UI from
    // previous probe" bugs at the source. Cost: ~1.5s per probe (force-stop +
    // cold-start settle), acceptable for the correctness guarantee.
    await this.adb.shell(deviceSerial, 'am force-stop com.whatsapp')
    await this.delay(1000)

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

      // Layer 2 defense — verify the XML actually shows the probed number.
      //
      // Layer 2a (stricter, runs first): for decisive results from modal-text
      // rules that embed the phone number directly in matched_text, verify
      // that the matched_text ITSELF contains the probed variant's digits.
      // The whole-XML check below is insufficient for these rules because the
      // probed variant's digits can appear elsewhere in the dump (sidebar,
      // previous chat header) while the decisive signal came from a stale
      // modal about a completely different number.
      //
      // Production case: probed 5571988096378, modal text said "+55 71
      // 93233-6885 não está no WhatsApp", whole-XML still passed because
      // the probed variant appeared in a sidebar node.
      const STRICT_TEXT_RULES = new Set([
        'not_on_whatsapp_pt',
        'not_on_whatsapp_en',
        'not_on_whatsapp_es',
      ])

      if (
        result.decisive &&
        STRICT_TEXT_RULES.has(result.evidence.matched_rule) &&
        typeof result.evidence.matched_text === 'string'
      ) {
        if (!xmlContainsVariantDigits(result.evidence.matched_text, variant)) {
          return {
            source: this.source,
            result: 'inconclusive',
            confidence: null,
            evidence: {
              ...result.evidence,
              ui_state: 'stale_ui',
              suspected_state: result.state,
              suspected_rule: result.evidence.matched_rule,
              stale_layer: 'matched_text_mismatch',
              polls: pollCount,
              saw_searching: sawSearching,
              attempt_phase: attemptPhase,
            },
            latency_ms: Date.now() - started,
            variant_tried: variant,
            device_serial: deviceSerial,
          }
        }
      }

      // Layer 2b (backstop): for all decisive results, the full XML must
      // contain the probed variant's digits somewhere. This catches stale
      // UI for rules that do NOT embed a phone number in matched_text
      // (invite_cta_id, invite_button_localized, whatsapp_input_field).
      if (result.decisive && !xmlContainsVariantDigits(xml, variant)) {
        return {
          source: this.source,
          result: 'inconclusive',
          confidence: null,
          evidence: {
            ...result.evidence,
            ui_state: 'stale_ui',
            suspected_state: result.state,
            suspected_rule: result.evidence.matched_rule,
            stale_layer: 'whole_xml',
            polls: pollCount,
            saw_searching: sawSearching,
            attempt_phase: attemptPhase,
          },
          latency_ms: Date.now() - started,
          variant_tried: variant,
          device_serial: deviceSerial,
        }
      }

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
            attempt_phase: attemptPhase,
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
            attempt_phase: attemptPhase,
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
      let retryableSnapshotPath: string | undefined
      if ((result.state === 'unknown' || result.state === 'unknown_dialog') && this.snapshotWriter) {
        retryableSnapshotPath = this.snapshotWriter.write({
          xml,
          state: result.state,
          phone: variant,
          tenant: ctx.tenant ?? 'adb',
        }) ?? undefined
      }
      return {
        source: this.source,
        result: 'inconclusive',
        confidence: null,
        evidence: {
          ...result.evidence,
          ui_state: result.state,
          polls: pollCount,
          saw_searching: sawSearching,
          attempt_phase: attemptPhase,
          ...(retryableSnapshotPath ? { snapshot_path: retryableSnapshotPath } : {}),
        },
        latency_ms: Date.now() - started,
        variant_tried: variant,
        device_serial: deviceSerial,
      }
    }

    // Deadline elapsed without classifier yielding a non-searching answer.
    const deadlineUiState = lastClassifierResult?.state ?? 'unknown'
    let deadlineSnapshotPath: string | undefined
    if ((deadlineUiState === 'unknown' || deadlineUiState === 'unknown_dialog') && this.snapshotWriter) {
      deadlineSnapshotPath = this.snapshotWriter.write({
        xml,
        state: deadlineUiState,
        phone: variant,
        tenant: ctx.tenant ?? 'adb',
      }) ?? undefined
    }
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
        ui_state: deadlineUiState,
        polls: pollCount,
        saw_searching: sawSearching,
        timed_out: true,
        attempt_phase: attemptPhase,
        ...(deadlineSnapshotPath ? { snapshot_path: deadlineSnapshotPath } : {}),
      },
      latency_ms: Date.now() - started,
      variant_tried: variant,
      device_serial: deviceSerial,
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
   */
  private async recover(state: UiState | string, deviceSerial: string): Promise<void> {
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

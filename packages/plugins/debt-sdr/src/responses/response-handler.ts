import type Database from 'better-sqlite3'
import type { ClassifierContext } from '../classifier/llm-client.js'
import type { Classification } from '../classifier/classifier.js'
import type { ResponseClassifier } from '../classifier/classifier.js'
import type { ClassifierLog } from '../classifier/classifier-log.js'
import type { IdentityGate } from '../identity-gate/identity-gate.js'
import type { Sequencer } from '../sequences/sequencer.js'
import type { TenantPipedriveClient } from '../pipedrive/tenant-pipedrive-client.js'
import type { OperatorAlerts } from '../operator-alerts.js'
import type { PendingWritebacks } from './pending-writebacks.js'
import type { SdrTenantConfig } from '../config/tenant-config.js'
import { recordClassification } from '../metrics.js'

export interface ResponsePayload {
  leadId: string
  /** Plugin-correlated dispatch message id (the outbound that received this reply). */
  outboundMessageId: string
  /** Reply text from the patient. */
  responseText: string
  /** Sender phone that originally sent the outbound (sticky per lead). */
  senderPhone: string
  /** Contact phone (the patient). */
  contactPhone: string
  /** Pipedrive deal id (for writeback). */
  dealId: number
}

export interface ResponseHandlerDeps {
  classifier: ResponseClassifier
  classifierLog: ClassifierLog
  identityGate: IdentityGate
  sequencer: Sequencer
  pipedrive: (tenantName: string) => TenantPipedriveClient
  operatorAlerts: OperatorAlerts
  pendingWritebacks: PendingWritebacks
  /** Provider tag for cost attribution metrics (e.g. 'stub', 'anthropic', 'gemini'). */
  llmProviderName?: string
  logger?: { info(msg: string, data?: Record<string, unknown>): void; warn(msg: string, data?: Record<string, unknown>): void }
}

export interface HandleResult {
  classification: Classification
  state: 'verified' | 'qualified' | 'disqualified' | 'opted_out' | 'wrong_number' | 'needs_human' | 'ambiguous'
}

/**
 * Wires the patient_response callback flow:
 *   1. Run cascade classifier (regex → LLM → ambiguous).
 *   2. Persist to classifier_log.
 *   3. Branch on category and (a) advance identity gate or sequencer,
 *      (b) write back to Pipedrive (qualified/disqualified/needs_human),
 *      (c) raise operator alert on ambiguous.
 *   4. Pipedrive failures fall through to the pending_writebacks queue.
 *
 * The handler never enqueues new outbound messages — that's the
 * sequencer's job. Here we only update state + writeback.
 */
export class ResponseHandler {
  constructor(private readonly db: Database.Database, private readonly deps: ResponseHandlerDeps) {}

  async handle(tenant: SdrTenantConfig, payload: ResponsePayload): Promise<HandleResult> {
    // Decide phase: identity_gate if we still have a pending identity row.
    const identityRow = this.deps.identityGate.fetchRow(tenant.name, payload.senderPhone, payload.contactPhone)
    const phase: ClassifierContext['phase'] =
      identityRow && identityRow.state === 'pending' ? 'identity_gate' : 'response_handling'

    const classification = await this.deps.classifier.classify(payload.responseText, {
      phase,
      tenant: tenant.name,
      leadId: payload.leadId,
    })

    this.deps.classifierLog.record({
      lead_id: payload.leadId,
      message_id: payload.outboundMessageId,
      response_text: payload.responseText,
      classification,
    })
    recordClassification(tenant.name, this.deps.llmProviderName ?? 'unknown', classification)

    // Identity phase routes through the gate (already implemented).
    if (phase === 'identity_gate') {
      const result = this.deps.identityGate.handleClassification(
        tenant.name,
        payload.senderPhone,
        { phone: payload.contactPhone, name: '' },
        payload.leadId,
        payload.outboundMessageId,
        payload.responseText,
        classification,
      )
      if (result === 'verified') {
        return { classification, state: 'verified' }
      }
      if (result === 'opted_out' || result === 'wrong_number') {
        await this.writeback(tenant, payload, classification, result)
        return { classification, state: result }
      }
      // 'unchanged' (ambiguous or out-of-phase) — alert already raised.
      return { classification, state: 'ambiguous' }
    }

    // Response-handling phase.
    switch (classification.category) {
      case 'interested': {
        this.deps.sequencer.terminateSequence(payload.leadId, 'qualified', 'classifier:interested')
        await this.writeback(tenant, payload, classification, 'qualified')
        return { classification, state: 'qualified' }
      }
      case 'not_interested': {
        this.deps.sequencer.terminateSequence(payload.leadId, 'disqualified', 'classifier:not_interested')
        await this.writeback(tenant, payload, classification, 'disqualified')
        return { classification, state: 'disqualified' }
      }
      case 'question': {
        // Needs human — sequence stays active so operator can intervene.
        await this.writeback(tenant, payload, classification, 'needs_human')
        return { classification, state: 'needs_human' }
      }
      case 'opted_out': {
        this.deps.sequencer.terminateSequence(payload.leadId, 'opted_out', 'classifier:opted_out')
        await this.writeback(tenant, payload, classification, 'opted_out')
        return { classification, state: 'opted_out' }
      }
      case 'ambiguous':
      default: {
        this.deps.operatorAlerts.raise({
          tenant: tenant.name,
          leadId: payload.leadId,
          messageId: payload.outboundMessageId,
          responseText: payload.responseText,
          reason: 'response_handling_ambiguous',
          llmReason: classification.reason,
        })
        return { classification, state: 'ambiguous' }
      }
    }
  }

  /** Per-outcome Pipedrive writeback. Pipedrive failures enqueue to the retry table. */
  private async writeback(
    tenant: SdrTenantConfig,
    payload: ResponsePayload,
    classification: Classification,
    outcome: 'qualified' | 'disqualified' | 'needs_human' | 'opted_out' | 'wrong_number',
  ): Promise<void> {
    const stageMap: Record<typeof outcome, number> = {
      qualified: tenant.pipedrive.writeback.stage_qualified_id,
      disqualified: tenant.pipedrive.writeback.stage_disqualified_id,
      needs_human: tenant.pipedrive.writeback.stage_needs_human_id,
      opted_out: tenant.pipedrive.writeback.stage_disqualified_id,
      wrong_number: tenant.pipedrive.writeback.stage_disqualified_id,
    }
    const stageId = stageMap[outcome]
    const subject = tenant.pipedrive.writeback.activity_subject_template.replace('{{outcome}}', outcome)
    const note = `Classifier: ${classification.category} (${classification.source}, conf=${classification.confidence.toFixed(2)})\n` +
      `Response: ${payload.responseText}`

    const client = this.deps.pipedrive(tenant.name)
    try {
      await client.updateDealStage(payload.dealId, stageId)
      await client.createActivity({ dealId: payload.dealId, subject, note })
    } catch (err) {
      const errMsg = err instanceof Error ? err.message : String(err)
      this.deps.logger?.warn?.('pipedrive writeback failed; enqueuing retry', {
        tenant: tenant.name,
        deal_id: payload.dealId,
        outcome,
        error: errMsg,
      })
      this.deps.pendingWritebacks.enqueue({
        tenant: tenant.name,
        leadId: payload.leadId,
        action: 'update_stage',
        payload: { dealId: payload.dealId, stageId, outcome, subject, note },
      })
    }
  }
}

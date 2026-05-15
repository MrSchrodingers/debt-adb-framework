/**
 * Sequence definition — declarative, immutable, versioned.
 *
 * The shape lives in code (TS) rather than DB so each version is
 * auditable in git. Add a v2 by creating `<tenant>-cold-v2.ts` and
 * pointing the tenant config's `sequence_id` at it; never edit an
 * already-shipped sequence in place.
 *
 * Each step declares:
 *   - day_offset: days from sequence kickoff (0 = same day)
 *   - template_pool: array of pt-BR templates; deterministic select
 *     by sha256(lead_id) keeps the same lead on the same wording
 *   - terminal: true on the last step — sequencer stops on completion
 *     and writes back stage_no_response unless a response arrived earlier
 */

export interface SequenceStep {
  index: number
  /** Days after kickoff. 0 = day 0 (immediate). */
  day_offset: number
  /** Deterministic template pool, rendered with {nome} / {empresa}. */
  template_pool: readonly string[]
  /** Last step in the sequence — sequencer halts after delivery. */
  terminal: boolean
  /** Human-friendly label for the admin UI / logs. */
  label: string
}

export interface SequenceDefinition {
  id: string
  version: number
  description: string
  steps: readonly SequenceStep[]
}

/**
 * Lookup table of all known sequences. Plugin init validates the
 * tenant config's `sequence_id` against this map and fails loud when
 * unrecognized (operator misspelled the id).
 */
export const SEQUENCES: Record<string, SequenceDefinition> = {}

/** Registration helper — used by the per-tenant sequence files. */
export function registerSequence(def: SequenceDefinition): void {
  if (SEQUENCES[def.id]) {
    throw new Error(`sequence ${def.id} is already registered`)
  }
  SEQUENCES[def.id] = def
}

export function getSequence(id: string): SequenceDefinition {
  const def = SEQUENCES[id]
  if (!def) throw new Error(`unknown sequence: ${id} (registered: ${Object.keys(SEQUENCES).join(', ')})`)
  return def
}

// Side-effect imports register each sequence with the global lookup
// table. Importing this module loads every shipped sequence.
import './oralsin-cold-v1.js'
import './sicoob-cold-v1.js'

export {
  SEQUENCES,
  getSequence,
  registerSequence,
  type SequenceDefinition,
  type SequenceStep,
} from './sequence-definition.js'

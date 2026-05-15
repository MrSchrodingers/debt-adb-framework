import { useTenant } from './tenant-context'

interface Props {
  pipelineId: number | undefined
  stageId: number | undefined
  onChange: (p: { pipelineId?: number; stageId?: number }) => void
}

export function PipelineStagePicker({ pipelineId, stageId, onChange }: Props) {
  const { tenant } = useTenant()
  if (!tenant || tenant.mode !== 'raw') return null

  return (
    <div className="grid grid-cols-2 gap-3 text-xs">
      <label className="flex flex-col gap-1">
        <span className="text-zinc-400">Pipeline ID</span>
        <input
          type="number"
          value={pipelineId ?? tenant.defaultPipelineId ?? ''}
          onChange={(e) =>
            onChange({
              pipelineId: e.target.value ? Number(e.target.value) : undefined,
              stageId,
            })
          }
          className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-zinc-200 font-mono"
          placeholder={String(tenant.defaultPipelineId ?? '')}
        />
      </label>
      <label className="flex flex-col gap-1">
        <span className="text-zinc-400">Stage ID (opcional)</span>
        <input
          type="number"
          value={stageId ?? tenant.defaultStageId ?? ''}
          onChange={(e) =>
            onChange({
              pipelineId,
              stageId: e.target.value ? Number(e.target.value) : undefined,
            })
          }
          className="bg-zinc-900 border border-zinc-800 rounded px-2 py-1 text-zinc-200 font-mono"
          placeholder={String(tenant.defaultStageId ?? '')}
        />
      </label>
    </div>
  )
}

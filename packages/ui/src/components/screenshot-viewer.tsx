/**
 * ScreenshotViewer — rich fallback UX for screenshot lifecycle states.
 *
 * Renders the screenshot image when available, or a structured placeholder
 * that explains exactly why the screenshot is absent (6 possible states).
 */
import { useState, useEffect } from 'react'
import { Camera } from 'lucide-react'
import { CORE_URL, authHeaders } from '../config'

// ── Types ──

type ScreenshotCode =
  | 'persisted'
  | 'never_persisted'
  | 'skipped_by_policy'
  | 'persistence_failed'
  | 'file_missing_on_disk'
  | 'deleted_by_retention'

type ScreenshotMeta =
  | { code: 'persisted'; url: string }
  | {
      code: Exclude<ScreenshotCode, 'persisted'>
      reason?: string | null
      deleted_at?: string | null
      message_sent_at?: string | null
    }

interface ScreenshotViewerProps {
  messageId: string
}

// ── Hook ──

function useScreenshotMeta(messageId: string): { data: ScreenshotMeta | null; loading: boolean } {
  const [data, setData] = useState<ScreenshotMeta | null>(null)
  const [loading, setLoading] = useState(true)

  useEffect(() => {
    let cancelled = false
    setLoading(true)

    // Attempt to load the screenshot image first
    const imageUrl = `${CORE_URL}/api/v1/messages/${messageId}/screenshot`
    fetch(imageUrl, { headers: authHeaders() })
      .then(res => {
        if (cancelled) return
        if (res.ok) {
          // Screenshot is available — expose the URL for rendering
          setData({ code: 'persisted', url: imageUrl })
        } else {
          // Parse structured 404 body
          return res.json().then((body: {
            code?: string
            reason?: string | null
            deleted_at?: string | null
            message_sent_at?: string | null
          }) => {
            if (cancelled) return
            const code = (body.code ?? 'never_persisted') as Exclude<ScreenshotCode, 'persisted'>
            setData({
              code,
              reason: body.reason ?? null,
              deleted_at: body.deleted_at ?? null,
              message_sent_at: body.message_sent_at ?? null,
            })
          })
        }
      })
      .catch(() => {
        if (!cancelled) {
          setData({ code: 'never_persisted', reason: null, deleted_at: null, message_sent_at: null })
        }
      })
      .finally(() => {
        if (!cancelled) setLoading(false)
      })

    return () => { cancelled = true }
  }, [messageId])

  return { data, loading }
}

// ── Label / description helpers ──

function labelFor(code?: ScreenshotCode | string): string {
  switch (code) {
    case 'never_persisted':      return 'Screenshot nao capturada'
    case 'skipped_by_policy':    return 'Captura ignorada pela politica'
    case 'persistence_failed':   return 'Falha ao salvar'
    case 'file_missing_on_disk': return 'Arquivo ausente no disco'
    case 'deleted_by_retention': return 'Excluida pela retencao'
    default:                     return 'Indisponivel'
  }
}

function descriptionFor(code?: ScreenshotCode | string): string {
  switch (code) {
    case 'never_persisted':
      return 'A mensagem foi processada antes da captura de screenshot ser implementada, ou o envio falhou antes do screenshot.'
    case 'skipped_by_policy':
      return 'A politica de amostragem configurada optou por nao capturar esta mensagem.'
    case 'persistence_failed':
      return 'O screenshot foi capturado mas houve um erro ao salvar o arquivo no disco.'
    case 'file_missing_on_disk':
      return 'O caminho do arquivo esta registrado no banco de dados mas o arquivo foi removido do disco.'
    case 'deleted_by_retention':
      return 'O arquivo foi automaticamente removido pela politica de retencao configurada.'
    default:
      return 'O screenshot desta mensagem nao esta disponivel.'
  }
}

// ── Component ──

export function ScreenshotViewer({ messageId }: ScreenshotViewerProps) {
  const { data, loading } = useScreenshotMeta(messageId)
  const [imgError, setImgError] = useState(false)

  if (loading) {
    return (
      <div className="flex items-center gap-2 rounded-md border border-zinc-800 bg-zinc-900/40 p-4 text-sm text-zinc-500">
        <Camera className="h-4 w-4 animate-pulse" />
        <span>Carregando screenshot...</span>
      </div>
    )
  }

  if (data?.code === 'persisted' && !imgError) {
    return (
      <img
        src={data.url}
        alt={`Screenshot da mensagem ${messageId}`}
        onError={() => setImgError(true)}
        className="max-w-full rounded-md border border-zinc-700/40 shadow-lg"
        style={{ maxHeight: 300 }}
      />
    )
  }

  // Derive effective code when image failed to load despite 'persisted' status
  const effectiveCode: ScreenshotCode = imgError ? 'file_missing_on_disk' : (data?.code ?? 'never_persisted')
  const meta = data?.code !== 'persisted' ? data : null

  return (
    <div className="rounded-md border border-zinc-800 bg-zinc-900/40 p-4 space-y-2">
      <div className="flex items-center gap-2">
        <Camera className="h-4 w-4 text-zinc-500" />
        <span className="font-medium text-zinc-200">{labelFor(effectiveCode)}</span>
      </div>
      <p className="text-sm text-zinc-400">{descriptionFor(effectiveCode)}</p>
      {meta?.deleted_at && (
        <p className="text-xs text-zinc-500">
          Removida em {new Date(meta.deleted_at).toLocaleString('pt-BR')}
        </p>
      )}
      {meta?.message_sent_at && (
        <p className="text-xs text-zinc-500">
          Mensagem enviada em {new Date(meta.message_sent_at).toLocaleString('pt-BR')}
        </p>
      )}
      {meta?.reason && (
        <details className="text-xs">
          <summary className="cursor-pointer text-zinc-500 hover:text-zinc-400">Detalhes tecnicos</summary>
          <code className="block mt-1 text-zinc-400 bg-zinc-950 rounded p-2 overflow-x-auto">
            {meta.reason}
          </code>
        </details>
      )}
    </div>
  )
}

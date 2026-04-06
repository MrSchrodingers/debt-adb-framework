import { useEffect, useRef } from 'react'
import { CheckCircle, XCircle, AlertTriangle, X } from 'lucide-react'

export interface Toast {
  id: string
  type: 'success' | 'error' | 'warning'
  message: string
  timestamp: number
}

const MAX_VISIBLE = 3
const AUTO_DISMISS_MS = 5000

const iconMap = {
  success: CheckCircle,
  error: XCircle,
  warning: AlertTriangle,
} as const

const styleMap = {
  success: {
    border: 'border-emerald-500/60',
    icon: 'text-emerald-400',
    bg: 'bg-zinc-900/95',
  },
  error: {
    border: 'border-red-500/60',
    icon: 'text-red-400',
    bg: 'bg-zinc-900/95',
  },
  warning: {
    border: 'border-amber-500/60',
    icon: 'text-amber-400',
    bg: 'bg-zinc-900/95',
  },
} as const

interface ToastItemProps {
  toast: Toast
  onDismiss: (id: string) => void
}

function ToastItem({ toast, onDismiss }: ToastItemProps) {
  const Icon = iconMap[toast.type]
  const styles = styleMap[toast.type]
  const timerRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  useEffect(() => {
    timerRef.current = setTimeout(() => {
      onDismiss(toast.id)
    }, AUTO_DISMISS_MS)

    return () => {
      if (timerRef.current) clearTimeout(timerRef.current)
    }
  }, [toast.id, onDismiss])

  return (
    <div
      className={`flex items-start gap-3 rounded-xl border ${styles.border} ${styles.bg} backdrop-blur-sm px-4 py-3 shadow-lg shadow-black/20 animate-slide-in-right`}
    >
      <Icon className={`h-5 w-5 shrink-0 mt-0.5 ${styles.icon}`} />
      <p className="flex-1 text-sm text-zinc-100 leading-snug">{toast.message}</p>
      <button
        onClick={() => onDismiss(toast.id)}
        className="shrink-0 text-zinc-500 hover:text-zinc-200 transition-colors"
      >
        <X className="h-4 w-4" />
      </button>
    </div>
  )
}

interface ToastContainerProps {
  toasts: Toast[]
  onDismiss: (id: string) => void
}

export function ToastContainer({ toasts, onDismiss }: ToastContainerProps) {
  const visible = toasts.slice(-MAX_VISIBLE)

  if (visible.length === 0) return null

  return (
    <div className="fixed bottom-6 right-6 z-50 flex flex-col gap-2 w-96 max-w-[calc(100vw-3rem)]">
      {visible.map((toast) => (
        <ToastItem key={toast.id} toast={toast} onDismiss={onDismiss} />
      ))}
    </div>
  )
}

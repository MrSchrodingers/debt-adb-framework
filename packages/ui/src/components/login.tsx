import { useState, type FormEvent } from 'react'
import { useAuth } from '../auth/auth-context'
import { BrandMark } from './brand-mark'

export function Login() {
  const { login, error } = useAuth()
  const [username, setUsername] = useState('')
  const [password, setPassword] = useState('')
  const [submitting, setSubmitting] = useState(false)
  const [shake, setShake] = useState(false)

  const onSubmit = async (e: FormEvent) => {
    e.preventDefault()
    if (submitting) return
    setSubmitting(true)
    try {
      await login(username, password)
    } catch {
      setShake(true)
      window.setTimeout(() => setShake(false), 380)
    } finally {
      setSubmitting(false)
    }
  }

  return (
    <div className="brand-aurora min-h-screen flex items-center justify-center px-4 py-10">
      {/* Decorative grid + scanlines for "operator console" vibe */}
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 opacity-[0.06]"
        style={{
          backgroundImage:
            'linear-gradient(rgba(255,255,255,0.7) 1px, transparent 1px), linear-gradient(90deg, rgba(255,255,255,0.7) 1px, transparent 1px)',
          backgroundSize: '64px 64px',
        }}
      />
      <div
        aria-hidden
        className="pointer-events-none fixed inset-0 opacity-[0.04] mix-blend-overlay"
        style={{
          backgroundImage:
            'repeating-linear-gradient(0deg, rgba(255,255,255,0.6) 0 1px, transparent 1px 3px)',
        }}
      />

      <div
        className={`relative w-full max-w-[420px] ${shake ? 'animate-[shake_0.38s_ease-in-out]' : ''}`}
        style={{
          // shake keyframes are inline-defined so this component owns its
          // micro-interaction without bloating the global CSS.
          ['--shake' as never]: 'translateX(0)',
        }}
      >
        <style>{`
          @keyframes shake {
            10%, 90% { transform: translateX(-2px); }
            20%, 80% { transform: translateX(3px); }
            30%, 50%, 70% { transform: translateX(-6px); }
            40%, 60% { transform: translateX(6px); }
          }
        `}</style>

        {/* Card */}
        <div className="relative rounded-2xl border border-white/10 bg-ink-900/70 backdrop-blur-xl shadow-[0_30px_80px_-20px_rgba(0,30,15,0.6)]">
          {/* Brand glow halo */}
          <div
            aria-hidden
            className="absolute -top-12 left-1/2 -translate-x-1/2 h-24 w-24 rounded-full bg-brand-400/30 blur-3xl"
          />

          <div className="relative px-8 pt-10 pb-8">
            <div className="flex flex-col items-center text-center">
              <BrandMark size={48} layout="col" />
              <h1 className="mt-6 font-display text-[1.6rem] font-semibold text-white">
                Bem-vindo de volta
              </h1>
              <p className="mt-2 max-w-xs text-sm text-white/55">
                Entre com suas credenciais operacionais para acessar o console.
              </p>
            </div>

            <form onSubmit={onSubmit} className="mt-8 space-y-4" noValidate>
              <Field
                id="login-user"
                label="Usuário"
                type="text"
                value={username}
                onChange={setUsername}
                autoComplete="username"
                disabled={submitting}
              />
              <Field
                id="login-pass"
                label="Senha"
                type="password"
                value={password}
                onChange={setPassword}
                autoComplete="current-password"
                disabled={submitting}
              />

              {error && (
                <div
                  role="alert"
                  className="rounded-lg border border-red-500/30 bg-red-500/10 px-3 py-2 text-sm text-red-200"
                >
                  {error}
                </div>
              )}

              <button
                type="submit"
                disabled={submitting || !username || !password}
                className="
                  group relative w-full overflow-hidden rounded-xl
                  bg-gradient-to-r from-brand-500 via-brand-400 to-brand-500
                  bg-[length:200%_100%] bg-left
                  px-4 py-3 text-sm font-semibold text-ink-950
                  transition-all duration-300
                  hover:bg-right
                  disabled:opacity-50 disabled:cursor-not-allowed
                  shadow-[0_8px_30px_-8px_rgba(60,194,92,0.55)]
                "
              >
                <span className="relative z-10 inline-flex items-center justify-center gap-2">
                  {submitting ? (
                    <>
                      <span className="h-3.5 w-3.5 animate-spin rounded-full border-2 border-ink-950/40 border-t-ink-950" />
                      Autenticando…
                    </>
                  ) : (
                    <>
                      Entrar
                      <svg
                        className="h-4 w-4 transition-transform group-hover:translate-x-0.5"
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="2.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                      >
                        <path d="M5 12h14M13 5l7 7-7 7" />
                      </svg>
                    </>
                  )}
                </span>
              </button>
            </form>
          </div>

          <div className="border-t border-white/5 px-8 py-4">
            <p className="text-center font-mono text-[0.65rem] uppercase tracking-[0.25em] text-white/30">
              DEBT · Cobrança Empresarial · Recuperação de Crédito
            </p>
          </div>
        </div>

        <p className="mt-6 text-center text-xs text-white/25">
          Acesso restrito · sessão expira em 8 horas
        </p>
      </div>
    </div>
  )
}

interface FieldProps {
  id: string
  label: string
  type: 'text' | 'password'
  value: string
  onChange: (v: string) => void
  autoComplete: string
  disabled?: boolean
}

function Field({ id, label, type, value, onChange, autoComplete, disabled }: FieldProps) {
  const hasValue = value.length > 0
  return (
    <div className="relative">
      <input
        id={id}
        type={type}
        value={value}
        autoComplete={autoComplete}
        disabled={disabled}
        onChange={(e) => onChange(e.target.value)}
        placeholder=" "
        className="
          peer block w-full rounded-xl border border-white/10
          bg-white/[0.03] px-3.5 pt-5 pb-2 text-[15px] text-white
          font-sans
          outline-none transition
          placeholder-shown:pt-3.5 placeholder-shown:pb-3.5
          focus:border-brand-400/60 focus:bg-white/[0.05]
          focus:ring-2 focus:ring-brand-400/20
          disabled:opacity-60
        "
      />
      <label
        htmlFor={id}
        className={`
          pointer-events-none absolute left-3.5 top-2 text-[0.7rem] font-medium uppercase
          tracking-[0.18em] text-brand-300/80 transition-all
          ${hasValue ? 'opacity-100' : 'peer-placeholder-shown:top-3.5 peer-placeholder-shown:text-sm peer-placeholder-shown:tracking-normal peer-placeholder-shown:normal-case peer-placeholder-shown:text-white/40 peer-focus:top-2 peer-focus:text-[0.7rem] peer-focus:uppercase peer-focus:tracking-[0.18em] peer-focus:text-brand-300/80'}
        `}
      >
        {label}
      </label>
    </div>
  )
}

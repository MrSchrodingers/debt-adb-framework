import { StrictMode } from 'react'
import { createRoot } from 'react-dom/client'
import { App } from './App'
import { AuthProvider, useAuth } from './auth/auth-context'
import { Login } from './components/login'
import { BrandMark } from './components/brand-mark'
import './index.css'

function AppGate() {
  const { loading, mode, token } = useAuth()

  if (loading) {
    return (
      <div className="brand-aurora flex min-h-screen items-center justify-center">
        <div className="flex flex-col items-center gap-4">
          <BrandMark size={40} layout="col" />
          <span className="font-mono text-xs uppercase tracking-[0.3em] text-brand-300/70">
            Inicializando…
          </span>
        </div>
      </div>
    )
  }

  if (mode === 'closed' && !token) {
    return <Login />
  }

  return <App />
}

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <AuthProvider>
      <AppGate />
    </AuthProvider>
  </StrictMode>,
)

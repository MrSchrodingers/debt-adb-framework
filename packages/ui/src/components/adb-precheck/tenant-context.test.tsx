import { describe, it, expect, beforeEach } from 'vitest'
import { render, screen, act } from '@testing-library/react'
import { TenantProvider, useTenant } from './tenant-context'

function Probe() {
  const { tenant, setTenant } = useTenant()
  return (
    <div>
      <span data-testid="t">{tenant?.id ?? 'none'}</span>
      <button
        data-testid="setbtn"
        onClick={() => setTenant({ id: 'sicoob', label: 'Sicoob', mode: 'raw' })}
      >
        set
      </button>
      <button data-testid="clearbtn" onClick={() => setTenant(null)}>
        clear
      </button>
    </div>
  )
}

describe('TenantContext', () => {
  beforeEach(() => {
    if (typeof localStorage !== 'undefined') {
      localStorage.clear()
    }
  })

  it('starts with no tenant when no localStorage', () => {
    render(<TenantProvider><Probe /></TenantProvider>)
    expect(screen.getByTestId('t').textContent).toBe('none')
  })

  it('persists tenant to localStorage when set', () => {
    render(<TenantProvider><Probe /></TenantProvider>)
    act(() => {
      screen.getByTestId('setbtn').click()
    })
    expect(screen.getByTestId('t').textContent).toBe('sicoob')
    const raw = localStorage.getItem('adb-precheck.tenant')
    expect(raw).toBeTruthy()
    const parsed = JSON.parse(raw!)
    expect(parsed.id).toBe('sicoob')
  })

  it('removes from localStorage when cleared', () => {
    localStorage.setItem('adb-precheck.tenant', JSON.stringify({ id: 'sicoob', label: 'Sicoob', mode: 'raw' }))
    render(<TenantProvider><Probe /></TenantProvider>)
    act(() => {
      screen.getByTestId('clearbtn').click()
    })
    expect(screen.getByTestId('t').textContent).toBe('none')
    expect(localStorage.getItem('adb-precheck.tenant')).toBeNull()
  })

  it('useTenant throws when used outside provider', () => {
    function Inner() {
      useTenant()
      return null
    }
    // Silence the expected error log
    const origError = console.error
    console.error = () => {}
    try {
      expect(() => render(<Inner />)).toThrow(/useTenant must be used inside TenantProvider/)
    } finally {
      console.error = origError
    }
  })
})

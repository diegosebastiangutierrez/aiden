'use client'

import { useEffect, useRef, useState } from 'react'
import { getTrustMode, setTrustMode, type WorkbenchTrustMode } from '../lib/aidenClient'

export function AutoModeButton({ disabled }: { disabled: boolean }) {
  const [mode, setMode] = useState<WorkbenchTrustMode | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState('')
  const revision = useRef(0)
  const changing = useRef(false)
  useEffect(() => {
    let active = true
    const refresh = () => {
      if (changing.current) return
      const request = ++revision.current
      void getTrustMode().then(value => {
        if (active && request === revision.current) { setMode(value); setError('') }
      }).catch(() => { if (active && request === revision.current) { setMode(null); setError('Mode control unavailable. Update or reconnect the runtime.') } })
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => { active = false; window.removeEventListener('focus', refresh) }
  }, [])
  const auto = mode?.level === 'Partner'
  const toggle = async () => {
    if (!mode || busy || disabled) return
    changing.current = true
    revision.current += 1
    setBusy(true)
    setError('')
    try { setMode(await setTrustMode(auto ? 'Assistant' : 'Partner')) }
    catch { setMode(null); setError('Mode change could not be confirmed. Refocus this window to refresh.') }
    finally { changing.current = false; setBusy(false) }
  }
  return <div className="composer-mode-control">
    <button type="button" className="composer-auto-mode" aria-pressed={auto}
      disabled={disabled || busy || !mode} onClick={() => { void toggle() }}
      title="Auto acts within this workspace. Destructive actions, spending, sending and out-of-workspace changes still require approval. Applies to new chat tasks; running work is unchanged.">
      <span aria-hidden="true">{auto ? '●' : '○'}</span> {busy ? 'Saving…' : auto ? 'Auto on' : mode?.level === 'Observer' ? 'Observer · Enable Auto' : 'Auto off'}
    </button>
    <span className="composer-mode-hint">{error || 'New tasks only · required approvals stay on'}</span>
    {error && <span role="alert" className="sr-only">{error}</span>}
  </div>
}

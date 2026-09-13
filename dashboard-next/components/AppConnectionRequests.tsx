'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import * as aiden from '../lib/aidenClient'
import { AppBrandIcon } from './AppBrandIcon'
import { pendingConnectionRemoved } from '../lib/connectionPresentation'

type Pending = NonNullable<aiden.WorkbenchAppsSnapshot['pendingConnections']>[number]

function ConnectionRequest({ request, changed }: { request: Pending; changed: (message?: string) => void }) {
  const [connection, setConnection] = useState<aiden.WorkbenchAppConnection | null>(null)
  const [error, setError] = useState<string | null>(null)
  const [busy, setBusy] = useState(false)
  const occupied = useRef(false)
  const alive = useRef(true)
  const label = request.toolkitId === 'github' ? 'GitHub' : request.toolkitId === 'gmail' ? 'Gmail' : request.toolkitId
  const check = useCallback(async () => {
    if (occupied.current) return
    occupied.current = true; setBusy(true)
    try {
      const result = await aiden.checkAppConnection(request.connectionId)
      if (alive.current) {
        setError(null)
        if (result.state === 'completed' && result.account) changed(`${result.account.label}: ${result.account.status === 'active' ? 'Connected' : result.account.status}. Review permissions in Apps.`)
      }
    } catch {
      if (alive.current) {
        const notice = `${label} authorization could not be confirmed. Review Apps before retrying. A denied or expired request does not connect your account.`
        setError(notice); changed(notice)
      }
    }
    finally { occupied.current = false; if (alive.current) setBusy(false) }
  }, [request.connectionId, changed, label])
  useEffect(() => {
    alive.current = true
    void aiden.resumeAppConnection(request.connectionId).then(value => { if (alive.current) setConnection(value) })
      .catch(() => { if (alive.current) setError('The authorization link is unavailable or expired. Cancel this request and start again.') })
    return () => { alive.current = false }
  }, [request.connectionId])
  useEffect(() => {
    if (error || !connection) return
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void check() }, 5000)
    return () => clearInterval(timer)
  }, [check, connection, error])
  const cancel = async () => {
    if (occupied.current) return
    occupied.current = true; setBusy(true)
    try {
      await aiden.cancelAppConnection(request.connectionId)
      if (alive.current) changed('Connection request cancelled in Aiden. If you already allowed access at the provider, review its connected-app settings separately.')
    } catch { if (alive.current) setError('Cancellation could not be confirmed. Refresh and retry.') }
    finally { occupied.current = false; if (alive.current) setBusy(false) }
  }
  return <article className="app-connection-request" aria-label={`Connect ${label}`}>
    <div><span className="eyebrow">Your permission is needed</span><h3><AppBrandIcon app={request.toolkitId} size={20} /> Connect {label}</h3></div>
    <p>Review the account and requested permissions on the provider’s page. Only approve a request you started. Aiden will verify the result automatically.</p>
    {connection?.userCode && <p>Provider code: <strong>{connection.userCode}</strong></p>}
    <div className="onboarding-actions">
      {connection?.authorizationUrl && <a className="aiden-button aiden-button-primary" href={connection.authorizationUrl} target="_blank" rel="noopener noreferrer">Review permissions</a>}
      <button className="nav-btn" disabled={busy} onClick={() => void check()}>Check connection</button>
      <button className="nav-btn" disabled={busy} onClick={() => void cancel()}>Cancel request</button>
    </div>
    {error ? <p role="alert">{error}</p> : <p role="status">Waiting for authorization. Local work remains available.</p>}
  </article>
}

/** Live authorization controls are not conversation messages or execution telemetry. */
export function AppConnectionRequests({ onChanged, showConnect = false }: { onChanged?: () => void; showConnect?: boolean }) {
  const [requests, setRequests] = useState<Pending[]>([])
  const [message, setMessage] = useState<string | null>(null)
  const [starting, setStarting] = useState(false)
  const active = useRef(true)
  const refreshing = useRef(false)
  const previousRequests = useRef<string[]>([])
  const changedCallback = useRef(onChanged)
  changedCallback.current = onChanged
  const refresh = useCallback(async () => {
    if (refreshing.current) return
    refreshing.current = true
    try {
      const rows = await aiden.loadPendingAppConnections()
      if (active.current) {
        const ids = rows.map(row => row.connectionId)
        const settled = pendingConnectionRemoved(previousRequests.current, ids)
        previousRequests.current = ids
        setRequests(rows)
        // A completed request can disappear before its card receives readback.
        // Reconcile the account projection even when that card has unmounted.
        if (settled) changedCallback.current?.()
      }
    }
    catch { /* No fabricated pending state when connection management is unavailable. */ }
    finally { refreshing.current = false }
  }, [])
  const changed = useCallback((notice?: string) => {
    if (!active.current) return
    if (notice) setMessage(notice)
    void refresh(); changedCallback.current?.()
  }, [refresh])
  useEffect(() => {
    active.current = true; void refresh()
    const wake = () => { void refresh() }
    window.addEventListener('aiden-app-connections-changed', wake)
    const timer = setInterval(() => { if (document.visibilityState === 'visible') void refresh() }, 5000)
    return () => { active.current = false; clearInterval(timer); window.removeEventListener('aiden-app-connections-changed', wake) }
  }, [refresh])
  useEffect(() => { if (!message) return; const timer = setTimeout(() => setMessage(null), 15000); return () => clearTimeout(timer) }, [message])
  const start = async (toolkitId: string) => {
    if (starting) return
    setStarting(true); setMessage(null)
    try { await aiden.connectApp({ providerId: 'composio', toolkitId }); changed() }
    catch { if (active.current) setMessage('Connection could not start. Open Apps → Connection setup to review the service configuration. No account was connected.') }
    finally { if (active.current) setStarting(false) }
  }
  return <div className="app-connection-requests">
    {showConnect && <details><summary>Connect an app</summary><div className="onboarding-actions">
      <button className="nav-btn" disabled={starting} onClick={() => void start('github')}>Connect GitHub</button>
      <button className="nav-btn" disabled={starting} onClick={() => void start('gmail')}>Connect Gmail</button>
    </div><p>You choose permissions in the provider’s browser page. Connection-service setup may be required in Apps.</p></details>}
    {message && <p role="status">{message}</p>}
    {requests.map(request => <ConnectionRequest key={request.connectionId} request={request} changed={changed} />)}
  </div>
}

'use client'

import { useCallback, useEffect, useRef, useState } from 'react'
import { accountAction, loadCommercialStatus } from '../lib/aidenClient'
import { safeAccountPortal } from '../../core/v4/product/accountPortal'
import type { AccountClientState } from '../../core/v4/product/accountContract'

export function AccountSetupPanel() {
  const [portal, setPortal] = useState<string | null>(null)
  const [loaded, setLoaded] = useState(false)
  const [connection, setConnection] = useState<AccountClientState | null>(null)
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const alive = useRef(true)
  const pending = useRef(false)
  const run = useCallback(async (action: 'status' | 'begin' | 'disconnect') => {
    if (pending.current) return
    pending.current = true; setBusy(true); setError(null)
    try {
      const value = await accountAction(action)
      if (alive.current) { setConnection(value); const origin = safeAccountPortal(value.portal); if (origin) setPortal(origin) }
    } catch { if (alive.current) setError('Account connection could not be checked. Retry or use the account portal. Local use is unaffected.') }
    finally { pending.current = false; if (alive.current) setBusy(false) }
  }, [])
  useEffect(() => {
    alive.current = true
    let current = true
    void loadCommercialStatus().then(value => {
      if (current) setPortal(safeAccountPortal(value && typeof value === 'object' && 'accountUrl' in value ? value.accountUrl : null))
    }).catch(() => {}).finally(() => { if (current) setLoaded(true) })
    void run('status')
    return () => { current = false; alive.current = false }
  }, [run])
  useEffect(() => {
    if (connection?.state !== 'pending' || error || busy) return
    const timer = setTimeout(() => { void run('status') }, 5000)
    return () => clearTimeout(timer)
  }, [connection, error, busy, run])
  const userCode = connection?.state === 'pending' && /^[A-F0-9]{10}$/.test(connection.userCode ?? '') ? connection.userCode : null
  return <section className="account-setup-panel" aria-label="Aiden account">
    <h3>Your Aiden account <span className="onboarding-optional">Optional for local use</span></h3>
    <p>Use verified email for your account and hosted services. Product-news emails are a separate choice. Signing in does not upload your local conversations, files or model credentials.</p>
    {!loaded ? <p role="status">Checking account setup…</p> : portal ? <>
      <div className="onboarding-actions">
        {connection?.state === 'linked' ? <p role="status">{error ? 'Previously linked' : 'Account linked'}: {connection.account?.email}</p>
          : <button className="aiden-button aiden-button-primary" type="button" disabled={busy || connection?.state === 'pending'} onClick={() => void run('begin')}>Link this installation</button>}
        <a className="aiden-button aiden-button-secondary" href={userCode ? `${portal}/#connect=${userCode}` : portal} target="_blank" rel="noopener noreferrer">{userCode ? 'Review and allow in browser' : 'Sign in or create an account'}</a>
        <button className="aiden-button aiden-button-secondary" type="button" disabled={busy} onClick={() => void run('status')}>Refresh account status</button>
        {['pending','linked'].includes(connection?.state ?? '') && <button className="aiden-button aiden-button-secondary" type="button" disabled={busy} onClick={() => void run('disconnect')}>{connection?.state === 'pending' ? 'Cancel connection' : 'Disconnect account'}</button>}
      </div>
      {userCode && <p role="status">Confirm this code: <strong>{userCode}</strong>. Only approve the request you started. Waiting for your approval…</p>}
      {connection && ['denied','expired','revoked'].includes(connection.state) && <p role="status">Connection {connection.state}. You can start again.</p>}
      {error && <p role="alert">{error}</p>}
      <p className="onboarding-optional">Opens {new URL(portal).hostname}. Account sign-in does not activate Pro or change your selected model.</p>
      <p><a href={`${portal}/#privacy`} target="_blank" rel="noopener noreferrer">Manage email preferences, export or delete your hosted account</a>. Local Aiden conversations and files stay on this computer. Disconnecting an installation does not delete your account.</p>
    </> : <p role="status">Account sign-in is not enabled for this installation yet. You can continue locally; this does not block model setup or your work.</p>}
  </section>
}

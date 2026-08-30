'use client'

import React, { useEffect, useMemo, useState } from 'react'

export interface CommercialWorkbenchStatus {
  entitlement: {
    state: 'community' | 'trial' | 'active' | 'grace' | 'expired' | 'revoked' | 'unavailable'
    edition: string
    expiresAt?: string
    offlineUntil?: string
    reason?: string
  }
  billing?: {
    access: 'free' | 'active' | 'payment_unverified' | 'payment_needs_attention' | 'grace' | 'cancelled' | 'expired' | 'revoked'
    proAccess: boolean
    periodEnd?: number
    graceUntil?: number
    cancellationPending?: boolean
  }
  deviceId?: string
  accountUrl?: string
  accessMode?: 'FULL' | 'READ_ONLY' | 'DENIED'
  product: { id: 'content-studio'; activeVersion: string | null; previousVersion: string | null; running?: boolean }
}

interface PricingModalProps {
  onClose: () => void
  onActivate: (code: string) => Promise<{ success: boolean; error?: string }>
  onRefresh: () => Promise<{ success: boolean; error?: string }>
  onOpenProduct: () => Promise<{ success: boolean; error?: string }>
  onCloseProduct: () => Promise<{ success: boolean; error?: string }>
  currentStatus: CommercialWorkbenchStatus
}

const estimates: Record<string, { symbol: string; monthly: string }> = {
  USD: { symbol: '$', monthly: '19' }, INR: { symbol: '₹', monthly: '1,600' },
  EUR: { symbol: '€', monthly: '18' }, GBP: { symbol: '£', monthly: '15' },
  AED: { symbol: 'د.إ', monthly: '70' }, CAD: { symbol: 'C$', monthly: '26' },
  AUD: { symbol: 'A$', monthly: '29' }, SGD: { symbol: 'S$', monthly: '25' },
}

const accessLabels: Record<string, string> = {
  free: 'Aiden Free', active: 'Aiden Pro Beta · Active', payment_unverified: 'Payment not verified',
  payment_needs_attention: 'Payment needs attention', grace: 'Aiden Pro Beta · Grace period',
  cancelled: 'Cancelled · active until period end', expired: 'Aiden Pro Beta · Expired', revoked: 'Aiden Pro Beta · Revoked',
  community: 'Aiden Free', unavailable: 'Access status unavailable', trial: 'Aiden Pro Beta · Trial',
}

function formatDate(value?: number | string) {
  const time = typeof value === 'number' ? value : value ? Date.parse(value) : Number.NaN
  return Number.isFinite(time) ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium' }).format(new Date(time)) : null
}

export default function PricingModal({ onClose, onActivate, onRefresh, onOpenProduct, onCloseProduct, currentStatus }: PricingModalProps) {
  const [currency, setCurrency] = useState('USD')
  const [code, setCode] = useState('')
  const [busy, setBusy] = useState<'activate' | 'refresh' | 'open' | 'close' | null>(null)
  const [message, setMessage] = useState<{ type: 'success' | 'error'; text: string } | null>(null)
  useEffect(() => {
    const locale = typeof navigator === 'undefined' ? '' : navigator.language
    if (/\bIN\b/i.test(locale)) setCurrency('INR')
  }, [])
  const access = currentStatus.billing?.access ?? currentStatus.entitlement.state
  const end = formatDate(currentStatus.billing?.periodEnd ?? currentStatus.entitlement.expiresAt)
  const price = estimates[currency] ?? estimates.USD
  const accountUrl = useMemo(() => {
    try { return currentStatus.accountUrl ? new URL(currentStatus.accountUrl).origin : null } catch { return null }
  }, [currentStatus.accountUrl])

  const activate = async () => {
    if (!/^[A-Za-z0-9_-]{43}$/.test(code)) { setMessage({ type: 'error', text: 'Enter the complete one-use activation code.' }); return }
    setBusy('activate'); setMessage(null)
    const result = await onActivate(code)
    setCode(''); setBusy(null)
    setMessage(result.success ? { type: 'success', text: 'This device is activated.' }
      : { type: 'error', text: result.error ?? 'Activation could not be completed.' })
  }
  const refresh = async () => {
    setBusy('refresh'); setMessage(null)
    try {
      const result = await onRefresh()
      setMessage(result.success ? { type: 'success', text: 'Access refreshed from verified billing state.' }
        : { type: 'error', text: result.error ?? 'Access could not be refreshed.' })
    } catch {
      setMessage({ type: 'error', text: 'Access could not be refreshed.' })
    } finally { setBusy(null) }
  }
  const productAction = async (action: 'open' | 'close') => {
    setBusy(action); setMessage(null)
    const result = await (action === 'open' ? onOpenProduct() : onCloseProduct())
    setBusy(null)
    setMessage(result.success ? { type: 'success', text: action === 'open' ? 'Content Studio opened.' : 'Content Studio closed.' }
      : { type: 'error', text: result.error ?? `Content Studio could not be ${action === 'open' ? 'opened' : 'closed'}.` })
  }

  return <div className="commercial-modal-backdrop" role="presentation" onMouseDown={(event) => { if (event.target === event.currentTarget) onClose() }}>
    <section className="commercial-modal" role="dialog" aria-modal="true" aria-labelledby="commercial-title">
      <header><div><span className="eyebrow">Plan &amp; Billing</span><h2 id="commercial-title">Aiden access</h2></div>
        <button type="button" className="commercial-close" onClick={onClose} aria-label="Close">×</button></header>

      <div className="commercial-current" data-access={access}>
        <strong>{accessLabels[access] ?? 'Access status unavailable'}</strong>
        {end && <span>{access === 'cancelled' ? `Active until ${end}` : access === 'active' ? `Current period ends ${end}` : `Access date ${end}`}</span>}
        {currentStatus.deviceId && <span>Device: {currentStatus.deviceId}</span>}
      </div>

      <div className="commercial-plans">
        <article><span className="eyebrow">Free</span><h3>$0</h3><p>Core local Aiden remains available without an account or payment.</p></article>
        <article className="is-pro"><span className="eyebrow">Pro Beta</span><h3>$19 USD <small>/ month</small></h3>
          <p>Private Content Studio access on up to two active devices.</p>
          <label htmlFor="commercial-currency">Display estimate</label>
          <select id="commercial-currency" value={currency} onChange={(event) => setCurrency(event.target.value)}>
            {Object.keys(estimates).map((value) => <option key={value} value={value}>{value}</option>)}
          </select>
          <p className="commercial-estimate">Approx. {price.symbol}{price.monthly} / month. Estimate only; the secure account page shows the actual checkout currency and charge.</p>
        </article>
      </div>

      <div className="commercial-actions">
        {accountUrl && <a className="commercial-primary" href={accountUrl} target="_blank" rel="noopener noreferrer">Manage subscription &amp; devices</a>}
        <button type="button" onClick={() => void refresh()} disabled={busy !== null || !currentStatus.deviceId}>{busy === 'refresh' ? 'Refreshing…' : 'Refresh access'}</button>
      </div>

      <div className="commercial-product">
        <strong>Content Studio</strong>
        <span>{currentStatus.product.activeVersion ? `Installed ${currentStatus.product.activeVersion}` : 'Not installed'}</span>
        {currentStatus.product.previousVersion && <span>Rollback available: {currentStatus.product.previousVersion}</span>}
        {currentStatus.accessMode === 'READ_ONLY' && <span>Read and export access</span>}
        {currentStatus.product.activeVersion && currentStatus.accessMode !== 'DENIED' && !currentStatus.product.running
          && <button type="button" className="commercial-primary" disabled={busy !== null} onClick={() => void productAction('open')}>{busy === 'open' ? 'Opening…' : 'Open Content Studio'}</button>}
        {currentStatus.product.running && <button type="button" disabled={busy !== null} onClick={() => void productAction('close')}>{busy === 'close' ? 'Closing…' : 'Close Content Studio'}</button>}
      </div>

      {!currentStatus.deviceId && <form onSubmit={(event) => { event.preventDefault(); void activate() }}>
        <label htmlFor="commercial-code">One-use activation code</label>
        <div className="commercial-code-row"><input id="commercial-code" value={code} onChange={(event) => setCode(event.target.value.trim())}
          autoComplete="off" spellCheck={false} maxLength={128} placeholder="Enter code from your secure account" />
          <button className="commercial-primary" type="submit" disabled={busy !== null || !code}>{busy === 'activate' ? 'Activating…' : 'Activate Pro'}</button></div>
      </form>}
      {message && <p className={`commercial-message is-${message.type}`} role="status">{message.text}</p>}
    </section>
  </div>
}

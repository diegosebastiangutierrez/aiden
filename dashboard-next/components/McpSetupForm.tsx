'use client'

import { useId, useState, type FormEvent } from 'react'
import * as aiden from '../lib/aidenClient'

export function McpSetupForm({ disabled, onPreview }: { disabled: boolean; onPreview: (preview: aiden.McpManagementPreview) => void }) {
  const id = useId()
  const [transport, setTransport] = useState<'stdio' | 'http'>('http')
  const [busy, setBusy] = useState(false)
  const [error, setError] = useState<string | null>(null)
  const submit = async (event: FormEvent<HTMLFormElement>) => {
    event.preventDefault(); if (disabled || busy) return
    const form = new FormData(event.currentTarget)
    const name = String(form.get('name') ?? '').trim()
    const configuration: NonNullable<aiden.McpManagementPreview['configuration']> = transport === 'stdio'
      ? { type: 'stdio', stdio: { command: String(form.get('command') ?? '').trim(), args: String(form.get('args') ?? '').split(/\r?\n/).filter(value => value.length > 0) } }
      : { type: 'http', http: { baseUrl: String(form.get('endpoint') ?? '').trim(), transport: form.get('protocol') === 'sse' ? 'sse' : 'streamable' } }
    setBusy(true); setError(null)
    try { onPreview(await aiden.previewMcpSetup(name, configuration)) }
    catch (cause) { setError(cause instanceof Error ? cause.message : 'MCP setup could not be reviewed.') }
    finally { setBusy(false) }
  }
  return <details className="mcp-setup-form"><summary>Add an MCP server</summary>
    <p>Connect a server you trust. You will review the exact destination or command before anything is saved or started. Never enter API keys, passwords or tokens here.</p>
    <form onSubmit={event => void submit(event)}>
      <fieldset disabled={disabled || busy}>
        <label>Server name<input name="name" required maxLength={128} pattern="[A-Za-z0-9_]+" autoComplete="off" placeholder="my_server" /></label>
        <label htmlFor={`${id}-transport`}>Connection type</label><select id={`${id}-transport`} value={transport} onChange={event => setTransport(event.target.value as 'stdio' | 'http')}><option value="http">Remote · HTTPS</option><option value="stdio">Local · supervised server process</option></select>
        {transport === 'http' ? <>
          <label>Server endpoint<input name="endpoint" type="url" required maxLength={2048} placeholder="https://example.com/mcp" /></label>
          <label htmlFor={`${id}-protocol`}>Protocol</label><select id={`${id}-protocol`} name="protocol"><option value="streamable">Streamable HTTP</option><option value="sse">Legacy SSE</option></select>
          <p>Public HTTPS endpoints only. Authorization, if required, is separate from adding the connection.</p>
        </> : <>
          <label>Program<input name="command" required maxLength={2048} placeholder="Full executable path or installed command" autoComplete="off" /></label>
          <label>Arguments · one per line<textarea name="args" rows={4} maxLength={65536} placeholder="Server script or package arguments" /></label>
          <p>This program will run with your user permissions now and on future starts. Use explicit values, without credentials or environment placeholders.</p>
        </>}
        <button type="submit" className="nav-btn">{busy ? 'Preparing review…' : 'Review new server'}</button>
      </fieldset>
    </form>
    {error && <p role="alert">{error}</p>}
  </details>
}

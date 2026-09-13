'use client'

import { useState } from 'react'
import { searchProductFeatures, type ProductFeature } from '../../core/v4/product/featureCatalog'
import type { WorkbenchDestination } from '../lib/workbenchNavigation'
import { ProductIcon, type ProductIconName } from './ProductIcon'

const categories: Array<{ id: ProductFeature['category']; label: string; icon: ProductIconName }> = [
  { id: 'apps', label: 'Apps', icon: 'apps' },
  { id: 'messaging', label: 'Messaging', icon: 'mail' },
  { id: 'tools', label: 'MCP & tools', icon: 'code' },
  { id: 'workspace', label: 'Workspace', icon: 'work' },
  { id: 'developer', label: 'Developer', icon: 'branch' },
]

export function ConnectionsWorkspace({ onNavigate }: { onNavigate: (destination: WorkbenchDestination) => void }) {
  const [query, setQuery] = useState('')
  const [category, setCategory] = useState<ProductFeature['category']>()
  const features = searchProductFeatures(query, category)
  return <section className="workspace-surface connections-workspace" aria-labelledby="connections-heading">
    <header><span className="settings-section-label">Your Aiden workspace</span><h1 id="connections-heading">Connections & capabilities</h1>
      <p>Find what Aiden can use and where to set it up. Opening setup does not grant permissions or start a task.</p></header>
    <label className="connections-search"><ProductIcon name="search" /><span className="sr-only">Search connections and capabilities</span>
      <input type="search" value={query} onChange={event => setQuery(event.target.value)} placeholder="Search apps, Telegram, MCP, skills…" /></label>
    <div className="connections-filters" role="group" aria-label="Connection categories">
      <button type="button" aria-pressed={!category} onClick={() => setCategory(undefined)}>All</button>
      {categories.map(item => <button key={item.id} type="button" aria-pressed={category === item.id} onClick={() => setCategory(item.id)}><ProductIcon name={item.icon} size={16} />{item.label}</button>)}
    </div>
    <p className="connections-result-count" role="status">{features.length} {features.length === 1 ? 'capability' : 'capabilities'} · Live connection status is shown inside each setup page.</p>
    <div className="connections-grid">
      {features.map(feature => <article key={feature.id} className="connections-card">
        <ProductIcon name={categories.find(item => item.id === feature.category)?.icon ?? 'apps'} size={22} />
        <h2>{feature.title}</h2><p>{feature.description}</p><small>{feature.setupNote}</small>
        <button type="button" className="aiden-button aiden-button-secondary" onClick={() => onNavigate(feature.destination)} aria-label={`Open ${feature.title}`}>Open <ProductIcon name="external" size={14} /></button>
      </article>)}
    </div>
    {features.length === 0 && <p>No matching capabilities. Try a different name or choose All.</p>}
  </section>
}

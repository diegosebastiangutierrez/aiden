'use client'

import { PRODUCT_FEATURES } from '../../core/v4/product/featureCatalog'

export function MessagingSetupPanel() {
  return <section aria-labelledby="messaging-heading">
    <h2 id="messaging-heading">Messaging connections</h2>
    <p>These adapters let you talk to Aiden outside Workbench. Adapter availability is not proof that an account is connected.</p>
    <p>Secure Web setup is not available in this runtime yet. No bot token is requested by this page.</p>
    <div className="connections-grid">
      {PRODUCT_FEATURES.filter(feature => feature.category === 'messaging').map(feature => <article key={feature.id} className="connections-card">
        <h3>{feature.title}</h3><p>{feature.description}</p><small>{feature.setupNote}</small>
        {(feature.id === 'telegram' || feature.id === 'discord') && <p>In Aiden CLI, run <code>/channel {feature.id} add</code>. Enter the token only in its secure prompt, then check <code>/channel {feature.id} status</code>.</p>}
      </article>)}
    </div>
    <p>Use <code>/channel list</code> in Aiden CLI to inspect the actual channel runtime. Never paste bot tokens into a conversation.</p>
  </section>
}

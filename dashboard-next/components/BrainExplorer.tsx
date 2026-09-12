'use client'

import { useMemo, useState } from 'react';
import type { WorkbenchLearningEntry, WorkbenchLearningSnapshot } from '../lib/aidenClient';
import { filterKnowledge, knowledgeScopeLabel, type KnowledgeFilter } from '../lib/productExperience';
import { MemoryGraph } from './MemoryGraph';
import { ProductIcon } from './ProductIcon';

type Tab = 'overview' | 'knowledge' | 'sources' | 'relationships' | 'review';
export function BrainExplorer({ snapshot, busy, onReview, onRemember }: {
  snapshot: WorkbenchLearningSnapshot; busy: boolean; onReview: (id: string) => void; onRemember: () => void;
}) {
  const [tab, setTab] = useState<Tab>('relationships');
  const [search, setSearch] = useState('');
  const [filter, setFilter] = useState<KnowledgeFilter>('all');
  const all = useMemo(() => [...snapshot.trusted, ...snapshot.needsReview, ...snapshot.archived], [snapshot]);
  const visible = useMemo(() => filterKnowledge(all, search, tab === 'review' ? 'review' : filter), [all, search, filter, tab]);
  const counts = [
    ['Ready to use', filterKnowledge(all, '', 'ready').length, 'knowledge'],
    ['Needs review', filterKnowledge(all, '', 'review').length, 'review'],
    ['Source references', all.filter(entry => entry.lifecycle !== 'DELETED').reduce((sum, entry) => sum + entry.sourceCount, 0), 'sources'],
  ] as const;
  const card = (entry: WorkbenchLearningEntry) => <article className="knowledge-card" key={entry.id}>
    <div className="knowledge-card-meta"><span>{knowledgeScopeLabel(entry.scope.kind)}</span><span>{entry.eligible && entry.lifecycle === 'ACTIVE' && entry.confidence === 'TRUSTED' ? 'Ready to use' : entry.lifecycle === 'ARCHIVED' ? 'Archived' : 'Needs review'}</span></div>
    <h3>{entry.content}</h3>
    <div className="knowledge-card-footer"><small>{entry.sourceCount} source {entry.sourceCount === 1 ? 'reference' : 'references'} · Updated {new Date(entry.updatedAt).toLocaleDateString()}</small>
      <button type="button" className="nav-btn" disabled={busy} onClick={() => onReview(entry.id)}>Review</button></div>
  </article>;

  return <div className="brain-explorer">
    <nav className="product-tabs" aria-label="Brain sections">{([
      ['relationships', 'Graph'], ['overview', 'Overview'], ['knowledge', 'Knowledge'], ['sources', 'Sources'], ['review', 'Review'],
    ] as const).map(([id, label]) => <button type="button" key={id} aria-pressed={tab === id} onClick={() => setTab(id)}>{label}</button>)}</nav>
    {tab === 'overview' && <>
      <section className="product-intro-card"><div className="product-intro-icon"><ProductIcon name="sparkles" size={26} /></div><div><h3>A little context. Less explaining.</h3><p>Keep useful preferences and lessons close to your work. See where they came from, correct them, or stop using them whenever you choose.</p></div><button className="product-primary" type="button" onClick={onRemember} disabled={!snapshot.enabled || busy}>Remember something</button></section>
      <div className="product-stat-grid">{counts.map(([label, count, target]) => <button type="button" key={label} onClick={() => setTab(target)}><strong>{count}</strong><span>{label}</span></button>)}</div>
      <div className="product-section-heading"><h3>Recently remembered</h3><button type="button" className="nav-btn" onClick={() => setTab('knowledge')}>View all knowledge</button></div>
      <div className="knowledge-grid">{filterKnowledge(all, '', 'all').slice(0, 6).map(card)}</div>
      {all.length === 0 && <div className="product-empty"><ProductIcon name="file" size={30} /><h3>Start with one useful detail</h3><p>Your writing preference, a project convention, or a correction you do not want to repeat.</p><button className="nav-btn" type="button" onClick={onRemember} disabled={!snapshot.enabled}>Add your first memory</button></div>}
      <p className="product-footnote">Knowledge stays scoped to your work. Sources and changes are inspectable; remembered text never grants permission to act.</p>
    </>}
    {tab !== 'overview' && <>
      <div className="product-toolbar"><label className="product-search"><ProductIcon name="search" size={18} /><input type="search" aria-label="Search knowledge" value={search} onChange={event => setSearch(event.target.value)} placeholder="Search your knowledge…" /></label>
        {tab !== 'review' && <select aria-label="Knowledge status" value={filter} onChange={event => setFilter(event.target.value as KnowledgeFilter)}><option value="all">All knowledge</option><option value="ready">Ready to use</option><option value="review">Needs review</option><option value="archived">Archived</option></select>}</div>
      {tab === 'knowledge' && <div className="knowledge-grid">{visible.map(card)}</div>}
      {tab === 'review' && <><p className="product-footnote">Review uncertain, stale, or conflicting context before Aiden uses it again. Your confirmation records your statement; it does not verify an external claim.</p><div className="knowledge-grid">{visible.map(card)}</div>
        {snapshot.conflicts.length > 0 && <section className="product-panel"><h3>Conflicts</h3>{snapshot.conflicts.filter(conflict => conflict.state === 'OPEN').map(conflict => <button type="button" className="nav-btn" key={conflict.id} disabled={busy} onClick={() => onReview(conflict.leftEntryId)}>Review conflict · {conflict.reasonCode.replaceAll('_', ' ')}</button>)}</section>}</>}
      {tab === 'sources' && <><p className="product-footnote">These are the recorded sources behind your learned context—not an app-sync catalogue. Open an item to inspect its exact source, Evidence, and history.</p>
        <div className="product-source-list">{visible.map(entry => <button type="button" key={entry.id} disabled={busy} onClick={() => onReview(entry.id)}><ProductIcon name="file" /><span><strong>{entry.content}</strong><small>{entry.sourceCount} recorded source {entry.sourceCount === 1 ? 'reference' : 'references'} · {knowledgeScopeLabel(entry.scope.kind)}</small></span><ProductIcon name="external" size={16} /></button>)}</div></>}
      {tab === 'relationships' && <MemoryGraph entries={visible} conflicts={snapshot.conflicts} busy={busy} onReview={onReview} />}
      {visible.length === 0 && <div className="product-empty"><ProductIcon name={tab === 'review' ? 'check' : 'search'} size={30} /><h3>{tab === 'review' && !search ? 'Nothing waiting for review' : 'No matching knowledge'}</h3><p>{search ? 'Try a different search or status.' : 'Add context or complete work that produces an eligible learning record.'}</p></div>}
    </>}
  </div>;
}

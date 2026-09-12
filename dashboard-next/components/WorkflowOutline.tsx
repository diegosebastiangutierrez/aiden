import { workflowOutline } from '../lib/productExperience';
import { ProductIcon, type ProductIconName } from './ProductIcon';

export function WorkflowOutline({ prompt, schedule, allowWrite }: { prompt: string; schedule: string; allowWrite: boolean }) {
  const icons: Record<string, ProductIconName> = { trigger: 'clock', task: 'sparkles', review: 'check', result: 'artifact' };
  return <aside className="workflow-outline" aria-label="Workflow plan preview"><div className="product-section-heading"><h3>Your workflow</h3><span className="product-status">Draft · not running</span></div>
    <p className="product-footnote">A preview of the schedule and task—not a claim that any step has run.</p>
    <ol>{workflowOutline({ prompt, schedule, allowWrite }).map(step => <li key={step.kind}><div className={`workflow-outline-icon ${step.kind}`}><ProductIcon name={icons[step.kind]} /></div><div><strong>{step.title}</strong><p>{step.detail}</p></div></li>)}</ol>
  </aside>;
}

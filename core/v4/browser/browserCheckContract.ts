import { isIP } from 'node:net';
import type { JobEngine } from '../daemon/jobEngine';
import { currentJobExecutionContext } from '../daemon/jobExecutionContext';

export interface BrowserCheckObservation {
  id: string;
  flowId: string;
  selector: string;
  kind: 'text' | 'count';
  expected: string | number;
}
export interface BrowserCheckContract {
  version: 1;
  customerId: string;
  specDigest: string;
  origin: string;
  allowLoopback: boolean;
  mutationPaths: string[];
  observations: BrowserCheckObservation[];
}
const names = new Set(['browser_navigate', 'browser_snapshot', 'browser_extract', 'browser_get_url',
  'browser_click', 'browser_type', 'browser_fill', 'browser_control', 'browser_scroll', 'browser_close', 'browser_check_observe']);
const id = /^[A-Za-z0-9][A-Za-z0-9._-]{0,127}$/;
const selector = /^(?:#[A-Za-z][A-Za-z0-9_-]{0,100}|\[data-testid="[A-Za-z0-9._-]{1,100}"\])$/;
function requireValue(condition: unknown, message: string): asserts condition {
  if (!condition) throw new Error(message);
}
function object(value: unknown, allowed: string[]): Record<string, unknown> {
  requireValue(value && typeof value === 'object' && !Array.isArray(value), 'Invalid browser check object');
  const result = value as Record<string, unknown>;
  requireValue(Object.keys(result).every(key => allowed.includes(key)) && allowed.every(key => key in result), 'Invalid browser check fields');
  return result;
}
export function parseBrowserCheckContract(input: unknown): BrowserCheckContract {
  const value = object(input, ['version', 'customerId', 'specDigest', 'origin', 'allowLoopback', 'mutationPaths', 'observations']);
  requireValue(value.version === 1 && typeof value.customerId === 'string' && id.test(value.customerId)
    && typeof value.specDigest === 'string' && /^[a-f0-9]{64}$/.test(value.specDigest), 'Invalid browser check identity');
  requireValue(typeof value.origin === 'string' && typeof value.allowLoopback === 'boolean', 'Invalid browser target');
  const url = new URL(value.origin);
  requireValue(url.origin === value.origin && !url.username && !url.password, 'Exact credential-free origin required');
  const loopback = url.hostname === '127.0.0.1';
  requireValue(loopback ? value.allowLoopback && url.protocol === 'http:' :
    url.protocol === 'https:' && !isIP(url.hostname) && url.hostname.includes('.')
      && !/\.(?:local|localhost|internal)$/.test(url.hostname), 'Unsupported browser target');
  requireValue(Array.isArray(value.mutationPaths) && value.mutationPaths.length <= 20, 'Invalid mutation scope');
  requireValue(value.mutationPaths.every(p => typeof p === 'string' && /^\/[A-Za-z0-9/_-]*$/.test(p)
    && !p.includes('//')), 'Exact mutation paths required');
  requireValue(Array.isArray(value.observations) && value.observations.length > 0 && value.observations.length <= 100, 'Invalid observation scope');
  const seen = new Set<string>();
  for (const raw of value.observations) {
    const item = object(raw, ['id', 'flowId', 'selector', 'kind', 'expected']);
    requireValue(typeof item.id === 'string' && id.test(item.id) && !seen.has(item.id)
      && typeof item.flowId === 'string' && id.test(item.flowId), 'Invalid or duplicate observation identity');
    seen.add(item.id);
    requireValue(typeof item.selector === 'string' && selector.test(item.selector)
      && !/password|secret|token|credential/i.test(item.selector), 'Observation requires a nonsensitive exact element identity');
    requireValue(item.kind === 'text' || item.kind === 'count', 'Unsupported observation');
    requireValue(item.kind === 'text' ? typeof item.expected === 'string' && item.expected.length <= 2000
      : Number.isSafeInteger(item.expected) && Number(item.expected) >= 0, 'Invalid observation expectation');
  }
  const result = structuredClone(value) as unknown as BrowserCheckContract;
  result.observations.forEach(Object.freeze); Object.freeze(result.observations); Object.freeze(result.mutationPaths);
  return Object.freeze(result);
}
export function browserCheckRequestAllowed(contract: BrowserCheckContract, rawUrl: string, method: string): boolean {
  try {
    const url = new URL(rawUrl);
    if (url.origin !== contract.origin || url.username || url.password) return false;
    if (method === 'GET' || method === 'HEAD') return true;
    return method === 'POST' && !url.search && contract.mutationPaths.includes(url.pathname);
  } catch { return false; }
}
export function browserCheckToolAllowed(name: string): boolean { return names.has(name); }
export function readBrowserCheckContract(engine: Pick<JobEngine, 'listEvents'>, jobId: string): BrowserCheckContract | null {
  const events = engine.listEvents(jobId).filter(event => event.type === 'browser.check.bound' && event.producer === 'workbench');
  if (!events.length) return null;
  if (events.length !== 1) throw new Error('Browser check authority is ambiguous');
  return parseBrowserCheckContract(events[0].payload);
}
export function currentBrowserCheckContract(): BrowserCheckContract | null {
  const context = currentJobExecutionContext();
  return context ? readBrowserCheckContract(context.engine, context.jobId) : null;
}

/** Called inside the admission transaction, before the trigger is acknowledged. */
export function bindBrowserCheckContract(engine: JobEngine, jobId: string, attemptId: string, contract: BrowserCheckContract): void {
  const attempt = engine.getAttempt(attemptId);
  if (!attempt || attempt.jobId !== jobId) throw new Error('Browser check Attempt is unavailable');
  const bound = engine.appendJobEvent({ jobId, attemptId, generation: attempt.generation,
    type: 'browser.check.bound', payload: contract as unknown as Record<string, unknown>, producer: 'workbench',
    idempotencyKey: `browser-check:${jobId}` });
  if (!bound.applied && !bound.duplicate) throw new Error('Browser check binding failed');
  if (bound.applied) for (const observation of contract.observations) {
    engine.proof.createClaim({ jobId, attemptId, generation: attempt.generation, category: 'contract', required: true,
      statement: `browser-check:${contract.specDigest}:${observation.id}`, requiredEvidenceCategories: ['browser.check'] });
  }
}

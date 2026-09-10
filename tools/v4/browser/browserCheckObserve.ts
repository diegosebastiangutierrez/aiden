import type { ToolHandler } from '../../../core/v4/toolRegistry';
import { currentJobExecutionContext } from '../../../core/v4/daemon/jobExecutionContext';
import { currentBrowserCheckContract, browserCheckRequestAllowed } from '../../../core/v4/browser/browserCheckContract';
import { pwObserveBrowserCheck } from '../../../core/playwrightBridge';
import { withBrowserState } from './_observer';
import { redactBrowserContent } from './redactContent';

const tool: ToolHandler = {
  schema: { name: 'browser_check_observe',
    description: 'Observe one pre-approved browser check by observation_id. Reads the actual page and records canonical Evidence and Verification. Available only in an approved browser-check Job. Never supply a claimed result.',
    inputSchema: { type: 'object', properties: { observation_id: { type: 'string' } },
      required: ['observation_id'], additionalProperties: false } },
  category: 'browser', toolset: 'browser', riskTier: 'safe', mutates: false,
  async execute(args) {
    const context = currentJobExecutionContext();
    const contract = currentBrowserCheckContract();
    const observation = contract?.observations.find(item => item.id === args.observation_id);
    if (!context || !contract || !observation) return { success: false, error: 'Approved browser observation is unavailable' };
    const claim = context.engine.proof.listClaims(context.jobId).find(item =>
      item.statement === `browser-check:${contract.specDigest}:${observation.id}`);
    if (!claim) return { success: false, error: 'Required browser claim is unavailable' };
    const observed = await pwObserveBrowserCheck(observation.id);
    if (context.signal?.aborted) throw new Error('Browser observation cancelled');
    if (!browserCheckRequestAllowed(contract, observed.url, 'GET')) throw new Error('Browser observation is outside approved scope');
    const parsedUrl = new URL(observed.url);
    const evidenceUrl = parsedUrl.origin + parsedUrl.pathname;
    if (redactBrowserContent(evidenceUrl) !== evidenceUrl || typeof observed.value === 'string'
      && redactBrowserContent(observed.value) !== observed.value) throw new Error('Browser observation contains sensitive content');
    const passed = observed.value === observation.expected;
    const evidence = context.engine.proof.recordEvidence({ ...context, source: 'browser.check',
      producer: 'browser-check-observer', observedAt: observed.observedAt, coverage: 'full', verificationResult: 'verified',
      payload: { customerId: contract.customerId, specDigest: contract.specDigest, flowId: observation.flowId,
        observationId: observation.id, selector: observation.selector, kind: observation.kind,
        expected: observation.expected, observed: observed.value, url: evidenceUrl, passed } });
      if (evidence.late) return { success: false, error: 'Late observation cannot change terminal verification' };
      context.engine.proof.checkClaim({ claimId: claim.claimId, attemptId: context.attemptId,
        generation: context.generation, evidenceIds: [evidence.evidenceId], state: passed ? 'verified' : 'failed' });
      return { success: true, check_passed: passed, evidence_id: evidence.evidenceId,
        observation_id: observation.id, expected: observation.expected, observed: observed.value };
  },
};
export const browserCheckObserveTool = withBrowserState(tool);

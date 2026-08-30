import { readFileSync } from 'node:fs';
import path from 'node:path';

import { describe, expect, it } from 'vitest';

const root = path.resolve(__dirname, '../../..');
const page = readFileSync(path.join(root, 'dashboard-next/app/page.tsx'), 'utf8');
const modal = readFileSync(path.join(root, 'dashboard-next/components/PricingModal.tsx'), 'utf8');
const css = readFileSync(path.join(root, 'dashboard-next/app/globals.css'), 'utf8');
const client = readFileSync(path.join(root, 'dashboard-next/lib/aidenClient.ts'), 'utf8');
const bridge = readFileSync(path.join(root, 'core/v4/workbench/bridgeServer.ts'), 'utf8');

describe('Workbench commercial access source contract', () => {
  it('uses the verified commercial projection for status, activation, and refresh', () => {
    expect(page).toContain('aiden.loadCommercialStatus<CommercialWorkbenchStatus>()');
    expect(page).toContain('aiden.activateCommercial<CommercialWorkbenchStatus>(key)');
    expect(page).toContain('aiden.refreshCommercial<CommercialWorkbenchStatus>()');
    expect(page).toContain("aiden.openCommercialProduct('content-studio')");
    expect(client).toContain("fetch('/api/commercial/status'");
    expect(client).toContain("fetch('/api/commercial/activate'");
    expect(client).toContain("fetch('/api/commercial/refresh'");
    expect(client).toContain('x-workbench-token');
    expect(bridge).toContain("url.pathname === '/api/commercial/status'");
    expect(bridge).toContain("url.pathname === '/api/commercial/activate'");
    expect(bridge).toContain('commercialProductMatch');
    expect(client).not.toMatch(/localhost:4200\/api\/commercial/u);
  });

  it('presents the runtime-only Free and Pro Beta offer without stale checkout claims', () => {
    expect(modal).toContain('Aiden Free');
    expect(modal).toContain('Aiden Pro Beta');
    expect(modal).toContain('$19 USD');
    expect(modal).toContain('up to two active devices');
    expect(modal).toContain('Manage subscription &amp; devices');
    expect(modal).toContain('Refresh access');
    expect(modal).not.toMatch(/stripe|annual|YOUR_/iu);
    expect(page).not.toMatch(/PRO ANNUAL|PRO LAUNCH|All limits removed/iu);
  });

  it('keeps the billing surface responsive without changing the Workbench shell', () => {
    expect(css).toContain('.commercial-modal { width: min(720px, 100%)');
    expect(css).toContain('@media (max-width: 620px)');
    expect(css).toContain('.commercial-plans { grid-template-columns: minmax(0, 1fr); }');
    expect(css).toContain('.commercial-actions > *, .commercial-code-row > * { width: 100%; }');
  });
});

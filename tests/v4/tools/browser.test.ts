import { describe, it, expect, vi, afterEach } from 'vitest';

vi.mock('../../../core/playwrightBridge', () => ({
  pwScreenshot: vi.fn(),
  pwSnapshot: vi.fn(),
  pwGetUrl: vi.fn(),
  pwNavigate: vi.fn(),
  pwClick: vi.fn(),
  pwClickFirstResult: vi.fn(),
  pwType: vi.fn(),
  pwScroll: vi.fn(),
  pwClose: vi.fn(),
  pwListTabs: vi.fn(),
  pwOpenTab: vi.fn(),
  pwRehydrateCurrentDurableSession: vi.fn(),
  pwSwitchControl: vi.fn(),
  pwCloseTab: vi.fn(),
}));

import {
  pwScreenshot,
  pwSnapshot,
  pwGetUrl,
  pwNavigate,
  pwClick,
  pwType,
  pwScroll,
  pwClose,
  pwListTabs,
  pwOpenTab,
  pwSwitchControl,
  pwCloseTab,
} from '../../../core/playwrightBridge';
import { browserScreenshotTool } from '../../../tools/v4/browser/browserScreenshot';
import { browserExtractTool } from '../../../tools/v4/browser/browserExtract';
import { browserGetUrlTool } from '../../../tools/v4/browser/browserGetUrl';
import { browserNavigateTool } from '../../../tools/v4/browser/browserNavigate';
import { browserClickTool } from '../../../tools/v4/browser/browserClick';
import { browserTypeTool } from '../../../tools/v4/browser/browserType';
import { browserFillTool } from '../../../tools/v4/browser/browserFill';
import { browserScrollTool } from '../../../tools/v4/browser/browserScroll';
import { browserCloseTool } from '../../../tools/v4/browser/browserClose';
import { browserTabTool, browserTabsTool } from '../../../tools/v4/browser/browserTabs';
import { resolveAidenPaths } from '../../../core/v4/paths';
import type { ToolContext } from '../../../core/v4/toolRegistry';

const ctx: ToolContext = {
  cwd: process.cwd(),
  paths: resolveAidenPaths({ rootOverride: '/tmp/aiden-test-root' }),
};

afterEach(() => {
  vi.clearAllMocks();
});

describe('browser tools', () => {
  it('1. persists screenshot artifacts while extract and URL inspection remain read-only', () => {
    expect(browserScreenshotTool.category).toBe('browser');
    expect(browserScreenshotTool.mutates).toBe(true);
    expect(browserScreenshotTool.toolset).toBe('browser');
    for (const tool of [browserExtractTool, browserGetUrlTool]) {
      expect(tool.category).toBe('browser');
      expect(tool.mutates).toBe(false);
      expect(tool.toolset).toBe('browser');
    }
  });

  it('2. browser_screenshot returns the bridge file path on success', async () => {
    (pwScreenshot as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      path: '/tmp/screenshot_123.png',
    });
    const result = (await browserScreenshotTool.execute({}, ctx)) as {
      success: boolean;
      path: string;
    };
    expect(result.success).toBe(true);
    expect(result.path).toBe('/tmp/screenshot_123.png');
  });

  it('3. browser_screenshot surfaces bridge errors', async () => {
    (pwScreenshot as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: 'no active page',
    });
    const result = (await browserScreenshotTool.execute({}, ctx)) as {
      success: boolean;
      error: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe('no active page');
  });

  it('4. browser_extract returns visible text', async () => {
    (pwSnapshot as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      text: 'page body',
    });
    const result = (await browserExtractTool.execute({}, ctx)) as {
      success: boolean;
      text: string;
    };
    expect(result.success).toBe(true);
    // B5.1 — extracted text is redacted + fenced as untrusted before the model.
    expect(result.text).toContain('page body');
    expect(result.text).toMatch(/untrusted page content/i);
  });

  it('5. browser_extract returns empty string when bridge gives no text', async () => {
    (pwSnapshot as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
    });
    const result = (await browserExtractTool.execute({}, ctx)) as {
      success: boolean;
      text: string;
    };
    expect(result.success).toBe(true);
    // B5.1 — empty page text still comes back fenced (no raw content to leak).
    expect(result.text).toMatch(/untrusted page content/i);
  });

  it('6. browser_get_url returns the current URL', async () => {
    (pwGetUrl as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      url: 'https://example.com/page',
    });
    const result = (await browserGetUrlTool.execute({}, ctx)) as {
      success: boolean;
      url: string;
    };
    expect(result.success).toBe(true);
    expect(result.url).toBe('https://example.com/page');
  });

  it('7. browser_get_url surfaces bridge error', async () => {
    (pwGetUrl as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: false,
      error: 'no page',
    });
    const result = (await browserGetUrlTool.execute({}, ctx)) as {
      success: boolean;
      error: string;
    };
    expect(result.success).toBe(false);
    expect(result.error).toBe('no page');
  });

  it('8. browser_navigate calls pwNavigate and reports new url', async () => {
    (pwNavigate as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      url: 'https://example.com/landed',
    });
    const r = (await browserNavigateTool.execute(
      { url: 'https://example.com' },
      ctx,
    )) as { success: boolean; url: string };
    expect(r.success).toBe(true);
    expect(r.url).toBe('https://example.com/landed');
    expect(pwNavigate).toHaveBeenCalledWith('https://example.com');
  });

  it('9. browser_click forwards selector to pwClick', async () => {
    (pwClick as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });
    const r = (await browserClickTool.execute(
      { target: 'button.submit' },
      ctx,
    )) as { success: boolean };
    expect(r.success).toBe(true);
    expect(pwClick).toHaveBeenCalledWith('button.submit');
  });

  it('10. browser_type fills the selector', async () => {
    (pwType as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });
    const r = (await browserTypeTool.execute(
      { selector: 'input[name=q]', text: 'aiden' },
      ctx,
    )) as { success: boolean };
    expect(r.success).toBe(true);
    expect(pwType).toHaveBeenCalledWith('input[name=q]', 'aiden');
  });

  it('11. browser_fill iterates over fields', async () => {
    (pwType as ReturnType<typeof vi.fn>)
      .mockResolvedValueOnce({ ok: true })
      .mockResolvedValueOnce({ ok: true });
    const r = (await browserFillTool.execute(
      { fields: { '#email': 'a@b.c', '#name': 'Aiden' } },
      ctx,
    )) as { success: boolean; count: number };
    expect(r.success).toBe(true);
    expect(r.count).toBe(2);
    expect(pwType).toHaveBeenCalledTimes(2);
  });

  it('12. browser_scroll forwards direction and amount', async () => {
    (pwScroll as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });
    const r = (await browserScrollTool.execute(
      { direction: 'down', amount: 800 },
      ctx,
    )) as { success: boolean };
    expect(r.success).toBe(true);
    expect(pwScroll).toHaveBeenCalledWith('down', 800, undefined);
  });

  it('13. browser_close calls pwClose', async () => {
    (pwClose as ReturnType<typeof vi.fn>).mockResolvedValueOnce(undefined);
    const r = (await browserCloseTool.execute({}, ctx)) as { success: boolean };
    expect(r.success).toBe(true);
    expect(pwClose).toHaveBeenCalled();
  });

  it('14. all six write tools are mutates=true, browser-category', () => {
    for (const tool of [
      browserNavigateTool,
      browserClickTool,
      browserTypeTool,
      browserFillTool,
      browserScrollTool,
      browserCloseTool,
    ]) {
      expect(tool.category).toBe('browser');
      expect(tool.mutates).toBe(true);
      expect(tool.toolset).toBe('browser');
    }
  });

  it('15. browser_tabs exposes stable semantic tab identity as read-only state', async () => {
    (pwListTabs as ReturnType<typeof vi.fn>).mockResolvedValueOnce({
      ok: true,
      tabs: [{
        tab_id: 'tab-1', url: 'https://example.com/', title: 'Example Domain',
        origin: 'https://example.com', opener_id: null, createdBy: 'aiden',
        controlled: true, lastSnapshotHash: null, dirtyForm: false, browserSessionId: null,
      }],
    });
    const result = await browserTabsTool.execute({}, ctx) as Record<string, any>;
    expect(browserTabsTool.mutates).toBe(false);
    expect(result).toMatchObject({ success: true, browser_session_id: null, tabs: [{
      tab_id: 'tab-1', name: 'Example Domain', controlled: true, closeable: true,
    }] });
  });

  it('16. browser_tab opens a named tab and makes that exact tab active', async () => {
    (pwOpenTab as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, tab_id: 'tab-2' });
    (pwSwitchControl as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });
    (pwListTabs as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true, tabs: [] });
    const result = await browserTabTool.execute({
      action: 'open', name: 'Source 2', url: 'https://www.iana.org/help/example-domains',
    }, ctx) as Record<string, any>;
    expect(result).toMatchObject({ success: true, tab_id: 'tab-2', name: 'Source 2', verified: true });
    expect(pwOpenTab).toHaveBeenCalledWith('https://www.iana.org/help/example-domains', 'Source 2');
    expect(pwSwitchControl).toHaveBeenCalledWith('tab-2');
  });

  it('17. browser_tab switches and closes only the requested exact tab', async () => {
    (pwSwitchControl as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });
    (pwListTabs as ReturnType<typeof vi.fn>).mockResolvedValue({ ok: true, tabs: [] });
    expect(await browserTabTool.execute({ action: 'switch', tab_id: 'tab-1' }, ctx))
      .toMatchObject({ success: true, tab_id: 'tab-1', verified: true });
    (pwCloseTab as ReturnType<typeof vi.fn>).mockResolvedValueOnce({ ok: true });
    expect(await browserTabTool.execute({ action: 'close', tab_id: 'tab-2' }, ctx))
      .toMatchObject({ success: true, tab_id: 'tab-2', verified: true });
    expect(pwCloseTab).toHaveBeenCalledWith('tab-2');
  });
});

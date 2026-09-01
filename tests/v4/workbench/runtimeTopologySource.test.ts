import fs from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

const dashboardRoot = path.resolve(process.cwd(), 'dashboard-next');

function sourceFiles(root: string): string[] {
  const entries = fs.readdirSync(root, { withFileTypes: true });
  return entries.flatMap((entry) => {
    const candidate = path.join(root, entry.name);
    if (entry.isDirectory()) return sourceFiles(candidate);
    return /\.(?:ts|tsx|js|jsx)$/u.test(entry.name) ? [candidate] : [];
  });
}

describe('Workbench runtime topology source contract', () => {
  it('uses the same-origin Workbench bridge instead of a second fixed localhost control plane', () => {
    const violations = sourceFiles(path.join(dashboardRoot, 'app'))
      .concat(sourceFiles(path.join(dashboardRoot, 'components')))
      .flatMap((file) => {
        const source = fs.readFileSync(file, 'utf8');
        return source.includes('localhost:4200') ? [path.relative(process.cwd(), file)] : [];
      });

    expect(violations).toEqual([]);
  });

  it('mounts no retired control-plane poller or unsupported root WebSocket', () => {
    const page = fs.readFileSync(path.join(dashboardRoot, 'app', 'page.tsx'), 'utf8');
    const homeStart = page.indexOf('export default function Home()');
    expect(homeStart).toBeGreaterThan(0);
    const mountedHome = page.slice(homeStart);

    expect(mountedHome).not.toContain('<LiveViewPanel />');
    expect(mountedHome).not.toMatch(
      /fetch\(['"]\/api\/(?:cognition\/suggestions|voice(?:\/|['"]|\?)|memory(?:\/|['"]|\?)|tasks['"]|update\/check)/u,
    );
    expect(mountedHome).not.toMatch(/fetch\(['"]\/api\/(?:chat|screenshot)(?:\/|['"]|\?)/u);
  });

  it('does not mount a Memory panel backed by the retired memory control plane', () => {
    const page = fs.readFileSync(path.join(dashboardRoot, 'app', 'page.tsx'), 'utf8');
    const start = page.indexOf('function MemoryView()');
    const end = page.indexOf('// ── SkillsManager', start);
    expect(start).toBeGreaterThan(0);
    expect(end).toBeGreaterThan(start);
    expect(page.slice(start, end)).not.toContain("fetch('/api/memory");
  });
});

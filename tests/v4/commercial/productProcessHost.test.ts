import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { afterEach, expect, it } from 'vitest';

import { ProductProcessHost } from '../../../core/v4/commercial/productProcessHost';

const roots: string[] = [];
afterEach(() => { for (const root of roots.splice(0)) fs.rmSync(root, { recursive: true, force: true }); });

it('keeps private product authority behind authenticated inherited pipes', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-product-process-')); roots.push(root);
  const host = new ProductProcessHost({ aidenRoot: root, ownerId: 'fixture-product-host' });
  const handle = host.launch({ productId: 'fixture-product', executable: process.execPath,
    args: [path.resolve('tests/v4/fixtures/productHostClientFixture.cjs')], cwd: process.cwd(), environment: process.env });
  let stdout = ''; handle.child.stdout?.setEncoding('utf8'); handle.child.stdout?.on('data', (chunk) => { stdout += chunk; });
  const exit = await new Promise<number | null>((resolve, reject) => { handle.child.once('error', reject); handle.child.once('exit', resolve); });
  expect(exit).toBe(0);
  const result = JSON.parse(stdout) as { admission: { jobId: string; attemptId: string }; attempt: { status: string; leaseOwner: null } };
  expect(result.admission.jobId).toMatch(/^task_/); expect(result.admission.attemptId).toMatch(/^attempt_/);
  expect(result.attempt).toMatchObject({ status: 'waiting', leaseOwner: null });
});

it('routes exact publication authorization through the public host callback', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-product-process-')); roots.push(root);
  const authorized: unknown[] = [];
  const host = new ProductProcessHost({ aidenRoot: root, ownerId: 'fixture-product-host',
    authorizePublication: (input) => { authorized.push(input); } });
  const handle = host.launch({ productId: 'fixture-product', executable: process.execPath,
    args: [path.resolve('tests/v4/fixtures/productHostClientFixture.cjs')], cwd: process.cwd(),
    environment: { ...process.env, AIDEN_FIXTURE_PUBLICATION: '1' } });
  let stdout = ''; handle.child.stdout?.setEncoding('utf8'); handle.child.stdout?.on('data', (chunk) => { stdout += chunk; });
  const exit = await new Promise<number | null>((resolve, reject) => { handle.child.once('error', reject); handle.child.once('exit', resolve); });
  expect(exit).toBe(0);
  const result = JSON.parse(stdout) as { admission: Record<string, unknown>; publication: Record<string, unknown> };
  expect(result.publication).toEqual(result.admission);
  expect(authorized).toEqual([expect.objectContaining({ intentId: 'intent-fixture', intentDigest: 'd'.repeat(64),
    artifactId: 'artifact-fixture', artifactSha256: 'e'.repeat(64), accountId: 'account-fixture', targetId: 'target-fixture',
    binding: expect.objectContaining(result.admission) })]);
});

it('resolves dynamic product access through the authenticated host boundary', async () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'aiden-product-process-')); roots.push(root);
  let mode: 'FULL' | 'READ_ONLY' = 'FULL';
  const host = new ProductProcessHost({ aidenRoot: root, ownerId: 'fixture-product-host',
    accessMode: async () => { mode = 'READ_ONLY'; return mode; } });
  const handle = host.launch({ productId: 'fixture-product', executable: process.execPath,
    args: [path.resolve('tests/v4/fixtures/productHostClientFixture.cjs')], cwd: process.cwd(),
    environment: { ...process.env, AIDEN_FIXTURE_ACCESS: '1' } });
  let stdout = ''; handle.child.stdout?.setEncoding('utf8'); handle.child.stdout?.on('data', (chunk) => { stdout += chunk; });
  const exit = await new Promise<number | null>((resolve, reject) => { handle.child.once('error', reject); handle.child.once('exit', resolve); });
  expect(exit).toBe(0);
  expect(JSON.parse(stdout)).toMatchObject({ access: { accessMode: 'READ_ONLY' } });
});

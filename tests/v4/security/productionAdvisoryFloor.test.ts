import { readFileSync } from 'node:fs';
import path from 'node:path';
import { describe, expect, it } from 'vitest';

interface LockPackage { version?: string; dev?: boolean }
interface PackageLock { packages?: Record<string, LockPackage> }

const root = path.resolve(__dirname, '../../..');
const lock = JSON.parse(readFileSync(path.join(root, 'package-lock.json'), 'utf8')) as PackageLock;

function tuple(value: string): [number, number, number] {
  const match = /^(\d+)\.(\d+)\.(\d+)/.exec(value);
  if (!match) throw new Error(`Unsupported version: ${value}`);
  return [Number(match[1]), Number(match[2]), Number(match[3])];
}

function atLeast(actual: string, minimum: string): boolean {
  const a = tuple(actual);
  const b = tuple(minimum);
  for (let index = 0; index < 3; index += 1) {
    if (a[index] !== b[index]) return a[index] > b[index];
  }
  return true;
}

function installedVersions(name: string, includeDevelopment = false): string[] {
  const suffix = `node_modules/${name}`;
  return Object.entries(lock.packages ?? {})
    .filter(([key]) => key === suffix || key.endsWith(`/${suffix}`))
    .filter(([, value]) => includeDevelopment || value.dev !== true)
    .map(([, value]) => value.version)
    .filter((value): value is string => typeof value === 'string');
}

describe('production dependency security floors', () => {
  const floors: Record<string, string> = {
    '@hono/node-server': '1.19.15',
    'axios': '1.18.0',
    'body-parser': '1.20.6',
    'brace-expansion': '2.1.4',
    'builder-util-runtime': '9.7.0',
    'deepmerge-ts': '8.0.0',
    'electron-updater': '6.8.9',
    'fast-uri': '3.1.5',
    'hono': '4.12.34',
    'html-to-text': '10.0.1',
    'ip-address': '10.4.0',
    'js-yaml': '4.3.1',
    'linkify-it': '5.0.2',
    'mailparser': '3.9.20',
    'multer': '2.3.0',
    'nodemailer': '9.1.1',
    'protobufjs': '8.6.6',
    'undici': '6.28.0',
  };

  for (const [name, minimum] of Object.entries(floors)) {
    it(`keeps every shipped ${name} instance at or above ${minimum}`, () => {
      const versions = installedVersions(name);
      expect(versions.length, `${name} must remain present in the production lock graph`).toBeGreaterThan(0);
      expect(versions, `${name} contains a vulnerable production version`).toSatisfy(
        (values: string[]) => values.every((value) => atLeast(value, minimum)),
      );
    });
  }
});

describe('development and packaging dependency security floors', () => {
  it('removes the obsolete EPUB archive chain from every installed scope', () => {
    expect(installedVersions('epub2', true)).toEqual([]);
    expect(installedVersions('adm-zip', true)).toEqual([]);
  });
  const floors: Record<string, string> = {
    '@electron-internal/extract-zip': '1.0.1',
    'app-builder-lib': '26.15.0',
    'builder-util': '26.15.0',
    'builder-util-runtime': '9.7.0',
    'dmg-builder': '26.15.0',
    'electron': '41.10.3',
    'electron-builder': '26.15.0',
    'electron-builder-squirrel-windows': '26.15.0',
    'electron-publish': '26.15.0',
    'nanoid': '3.3.18',
    'postcss': '8.5.23',
    'tar': '7.5.21',
  };

  for (const [name, minimum] of Object.entries(floors)) {
    it(`keeps every installed ${name} instance at or above ${minimum}`, () => {
      const versions = installedVersions(name, true);
      expect(versions.length, `${name} must remain present in the development lock graph`).toBeGreaterThan(0);
      expect(versions, `${name} contains a vulnerable development version`).toSatisfy(
        (values: string[]) => values.every((value) => atLeast(value, minimum)),
      );
    });
  }

  it('keeps the vulnerable legacy extract-zip package out of the lock graph', () => {
    expect(installedVersions('extract-zip', true)).toEqual([]);
  });
});

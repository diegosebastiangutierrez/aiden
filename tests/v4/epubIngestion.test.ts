import { afterEach, describe, expect, it, vi } from 'vitest';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import archiver from 'archiver';
import { extractEPUB, extractFile } from '../../core/fileIngestion';

const roots: string[] = [];
afterEach(async () => { vi.unstubAllGlobals(); await Promise.all(roots.splice(0).map(root => rm(root, { recursive: true, force: true }))); });
const container = '<container xmlns="urn:oasis:names:tc:opendocument:xmlns:container"><rootfiles><rootfile full-path="OPS/book.opf" media-type="application/oebps-package+xml"/></rootfiles></container>';
const opf = '<package xmlns="http://www.idpf.org/2007/opf" version="3.0" unique-identifier="book"><metadata xmlns:dc="http://purl.org/dc/elements/1.1/"><dc:identifier id="book">book</dc:identifier><dc:title>Example</dc:title><dc:language>en</dc:language></metadata><manifest><item id="two" href="two.xhtml" media-type="application/xhtml+xml"/><item id="one" href="one.xhtml" media-type="application/xhtml+xml"/></manifest><spine><itemref idref="one"/><itemref idref="two"/></spine></package>';
const chapter = (text: string) => `<html xmlns="http://www.w3.org/1999/xhtml"><head><title>Not chapter text</title></head><body><p>${text}</p></body></html>`;
function entries(): Record<string, string> { return { mimetype: 'application/epub+zip', 'META-INF/container.xml': container, 'OPS/book.opf': opf, 'OPS/two.xhtml': chapter('Second chapter'), 'OPS/one.xhtml': chapter('First chapter') }; }
async function fixture(files = entries(), mutate?: (zip: Buffer) => void): Promise<string> {
  const root = await mkdtemp(path.join(tmpdir(), 'aiden-epub-')); roots.push(root);
  const zip = archiver('zip', { zlib: { level: 1 } });
  const parts: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => { zip.on('data', chunk => parts.push(chunk)); zip.on('error', reject); zip.on('end', () => resolve(Buffer.concat(parts))); });
  for (const [name, value] of Object.entries(files)) zip.append(value, { name });
  await zip.finalize(); const bytes = await done; mutate?.(bytes);
  const file = path.join(root, 'book.epub'); await writeFile(file, bytes); return file;
}
function centralFlag(zip: Buffer, offset: number, value: number): void {
  const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]);
  const at = zip.indexOf(signature); if (at < 0) throw new Error('Fixture lacks central entry');
  zip.writeUInt16LE(value, at + offset);
}

describe('bounded local EPUB ingestion', () => {
  it('preserves spine order, chapter text and extraction metadata', async () => {
    const file = await fixture(); const result = await extractFile(file);
    expect(result).toMatchObject({ text: 'First chapter \n Second chapter', wordCount: 4, pageCount: 0, format: 'epub' });
    expect(result.fileSizeMB).toBe(Number(((await readFile(file)).length / 1024 / 1024).toFixed(2)));
  });
  it('reads Unicode names and content in declared spine order', async () => {
    const files = entries(); files['OPS/book.opf'] = opf.replace('one.xhtml', '章.xhtml');
    delete files['OPS/one.xhtml']; files['OPS/章.xhtml'] = chapter('नमस्ते 世界');
    expect((await extractEPUB(await fixture(files))).text).toContain('नमस्ते 世界');
  });
  it.each(['META-INF/container.xml', 'OPS/book.opf'])('rejects missing required metadata: %s', async name => {
    const files = entries(); delete files[name]; await expect(extractEPUB(await fixture(files))).rejects.toThrow();
  });
  it.each(['<container/>', '<container><rootfiles></container>'])('rejects invalid container metadata: %s', async xml => {
    const files = entries(); files['META-INF/container.xml'] = xml; await expect(extractEPUB(await fixture(files))).rejects.toThrow();
  });
  it('rejects a missing spine target instead of silently reporting partial success', async () => {
    const files = entries(); files['OPS/book.opf'] = opf.replace('idref="one"', 'idref="missing"');
    await expect(extractEPUB(await fixture(files))).rejects.toThrow(/spine|missing/i);
  });
  it('rejects malformed archives', async () => { const file = await fixture(); await writeFile(file, 'not a zip'); await expect(extractEPUB(file)).rejects.toThrow(); });
  it('rejects encrypted entries truthfully', async () => { await expect(extractEPUB(await fixture(entries(), zip => centralFlag(zip, 8, 1)))).rejects.toThrow(/encrypt/i); });
  it('rejects unsupported compression truthfully', async () => { await expect(extractEPUB(await fixture(entries(), zip => centralFlag(zip, 10, 99)))).rejects.toThrow(/unsupported|compression/i); });
  it('bounds the entry count before extracting chapters', async () => {
    const files = entries(); for (let i = 0; i < 4096; i++) files[`extra/${i}`] = '';
    await expect(extractEPUB(await fixture(files))).rejects.toThrow(/limit|entries/i);
  });
  it('bounds decompressed entry bytes', async () => {
    const files = entries(); files['OPS/one.xhtml'] = chapter('x'.repeat(16 * 1024 * 1024));
    await expect(extractEPUB(await fixture(files)).then(() => undefined)).rejects.toThrow(/limit|size/i);
  });
  it('rejects custom entities without fetching or reading their target', async () => {
    const files = entries(); files['META-INF/container.xml'] = '<!DOCTYPE container [<!ENTITY x SYSTEM "https://invalid.example/entity">]>' + container;
    const fetch = vi.fn(() => { throw new Error('Unexpected request'); }); vi.stubGlobal('fetch', fetch);
    await expect(extractEPUB(await fixture(files))).rejects.toThrow(/DTD|entity|doctype/i); expect(fetch).not.toHaveBeenCalled();
  });
  it('rejects remote package references', async () => {
    const files = entries(); files['META-INF/container.xml'] = container.replace('OPS/book.opf', 'https://invalid.example/book.opf');
    await expect(extractEPUB(await fixture(files))).rejects.toThrow();
  });
  it.each(['<package/>', opf.replace('<metadata ', '<missing ').replace('</metadata>', '</missing>')])('rejects invalid package structure', async xml => {
    const files = entries(); files['OPS/book.opf'] = xml; await expect(extractEPUB(await fixture(files))).rejects.toThrow();
  });
  it('rejects missing chapter bytes instead of returning partial text', async () => {
    const files = entries(); delete files['OPS/one.xhtml']; await expect(extractEPUB(await fixture(files))).rejects.toThrow(/missing/i);
  });
  it('bounds total declared decompressed bytes before opening entry streams', async () => {
    const files = entries(); for (let i = 0; i < 9; i++) files[`padding/${i}`] = 'data';
    const file = await fixture(files, zip => {
      const signature = Buffer.from([0x50, 0x4b, 0x01, 0x02]); let at = 0;
      while ((at = zip.indexOf(signature, at)) >= 0) { zip.writeUInt32LE(15 * 1024 * 1024, at + 24); at += 4; }
    });
    await expect(extractEPUB(file)).rejects.toThrow(/limit|size/i);
  });
  it('rejects inconsistent decompressed byte declarations', async () => {
    const file = await fixture(entries(), zip => { const at = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); zip.writeUInt32LE(0, at + 24); });
    await expect(extractEPUB(file)).rejects.toThrow(/size|bytes/i);
  });
  it('supports conventional XHTML doctypes without fetching DTDs', async () => {
    const files = entries(); files['OPS/one.xhtml'] = '<!DOCTYPE html PUBLIC "-//W3C//DTD XHTML 1.1//EN" "http://www.w3.org/TR/xhtml11/DTD/xhtml11.dtd">' + chapter('First &amp; second');
    expect((await extractEPUB(await fixture(files))).text).toContain('First &amp; second');
  });
  it('rejects symlink entries without extracting them', async () => {
    const file = await fixture(entries(), zip => { const at = zip.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02])); zip.writeUInt32LE((0xa1ff << 16) >>> 0, at + 38); });
    await expect(extractEPUB(file)).rejects.toThrow(/symbolic/i);
  });
  it.each(['../outside.xhtml', '/outside.xhtml', 'file:///outside.xhtml', '%2e%2e/%2e%2e/outside.xhtml'])('rejects a chapter reference outside the archive: %s', async href => {
    const files = entries(); files['OPS/book.opf'] = opf.replace('one.xhtml', href); await expect(extractEPUB(await fixture(files))).rejects.toThrow();
  });
  it('rejects archive-declared content encryption', async () => {
    const files = entries(); files['META-INF/encryption.xml'] = '<encryption><EncryptionMethod Algorithm="http://www.w3.org/2001/04/xmlenc#aes256-cbc"/></encryption>';
    await expect(extractEPUB(await fixture(files))).rejects.toThrow(/encrypt/i);
  });
  it('bounds XML structure depth', async () => {
    const files = entries(); files['META-INF/container.xml'] = '<a>'.repeat(65) + '</a>'.repeat(65);
    await expect(extractEPUB(await fixture(files))).rejects.toThrow(/limit/i);
  });
  it('does not execute scripts, fetch resources or write beside the original', async () => {
    const files = entries(); files['OPS/one.xhtml'] = chapter('Visible<script>throw new Error("executed")</script><style>hidden</style><img src="https://invalid.example/image"/>');
    const file = await fixture(files); const original = await readFile(file); const fetch = vi.fn(); vi.stubGlobal('fetch', fetch);
    const result = await extractEPUB(file); expect(result.text).toContain('Visible'); expect(result.text).not.toMatch(/executed|hidden|Not chapter text/);
    expect(fetch).not.toHaveBeenCalled(); expect(await readdir(path.dirname(file))).toEqual(['book.epub']); expect(await readFile(file)).toEqual(original);
  });
});

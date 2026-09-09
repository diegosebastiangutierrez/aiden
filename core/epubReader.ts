import path from 'node:path';
import { once } from 'node:events';

const MAX_ARCHIVE = 256 * 1024 * 1024;
const MAX_ENTRIES = 4096;
const MAX_ENTRY = 16 * 1024 * 1024;
const MAX_TOTAL = 128 * 1024 * 1024;
const MAX_XML = 2 * 1024 * 1024;
const CONTAINER_NS = 'urn:oasis:names:tc:opendocument:xmlns:container';
const OPF_NS = 'http://www.idpf.org/2007/opf';

interface XmlNode { name: string; uri: string; attributes: Record<string, string>; children: XmlNode[] }

function parseXml(source: string): XmlNode {
  const sax = require('sax');
  const parser = sax.parser(true, { xmlns: true, strictEntities: true });
  const stack: XmlNode[] = [];
  let root: XmlNode | undefined;
  let nodes = 0;
  parser.ondoctype = () => { throw new Error('EPUB metadata DTD/entity declarations are unsupported'); };
  parser.onopentag = (tag: any) => {
    if (++nodes > 20000 || stack.length >= 64) throw new Error('EPUB XML structure limit exceeded');
    const node: XmlNode = { name: tag.local, uri: tag.uri, attributes: {}, children: [] };
    for (const [key, attribute] of Object.entries(tag.attributes)) node.attributes[key] = (attribute as any).value;
    if (stack.length) stack[stack.length - 1].children.push(node); else root = node;
    stack.push(node);
  };
  parser.onclosetag = () => stack.pop();
  parser.write(source).close();
  if (!root) throw new Error('EPUB metadata is empty');
  return root;
}

function child(node: XmlNode, name: string, uri: string): XmlNode {
  const matches = node.children.filter(item => item.name === name && item.uri === uri);
  if (matches.length !== 1) throw new Error(`EPUB requires one ${name} element`);
  return matches[0];
}

function localReference(base: string, value: string): string {
  // Resolve archive-relative URI references only. No filesystem extraction or URL fetching.
  if (!value || /[\\\u0000-\u001f]/.test(value) || /^[a-z][a-z\d+.-]*:|^\//i.test(value)) throw new Error('EPUB reference must be local');
  let decoded: string;
  try { decoded = decodeURIComponent(value.split('#')[0]); } catch { throw new Error('EPUB reference has invalid encoding'); }
  if (/[\\\u0000-\u001f?:]/.test(decoded) || decoded.startsWith('/')) throw new Error('EPUB reference must be local');
  const resolved = path.posix.normalize(path.posix.join(base, decoded));
  if (!decoded || resolved === '..' || resolved.startsWith('../')) throw new Error('EPUB reference escapes archive');
  return resolved;
}

function chapterText(source: string): string {
  // Validate well-formed XHTML/SVG without executing content or resolving external DTDs.
  const parser = require('sax').parser(true, { xmlns: true });
  let depth = 0;
  parser.ondoctype = (declaration: string) => {
    if (!/^\s*html(?:\s|$)/i.test(declaration) || /\[|<!ENTITY/i.test(declaration)) throw new Error('EPUB chapter entity declarations are unsupported');
  };
  parser.onopentag = () => { if (++depth > 128) throw new Error('EPUB chapter nesting limit exceeded'); };
  parser.onclosetag = () => { depth--; };
  parser.write(source).close();
  // Preserve the existing whitespace/entity output contract of chapter extraction.
  const body = /<body\b[^>]*>([\s\S]*?)<\/body\s*>/i.exec(source)?.[1] ?? source;
  return body.replace(/<script\b[^>]*>[\s\S]*?<\/script\s*>/gi, '')
    .replace(/<style\b[^>]*>[\s\S]*?<\/style\s*>/gi, '')
    .replace(/<[^>]+>/g, ' ');
}

/** Bounded, read-only EPUB projection. No files are extracted to disk. */
export async function readEpubText(filePath: string): Promise<{ text: string; bytes: number }> {
  let zip: any;
  try {
    zip = await require('yauzl').openPromise(filePath, { autoClose: false, lazyEntries: true, strictFileNames: true, validateEntrySizes: true });
    if (zip.fileSize > MAX_ARCHIVE) throw new Error('EPUB archive size limit exceeded');
    if (zip.entryCount > MAX_ENTRIES) throw new Error('EPUB entry count limit exceeded');
    const entries = new Map<string, any>();
    let total = 0;
    for await (const entry of zip.eachEntry()) {
      if (entries.size >= MAX_ENTRIES) throw new Error('EPUB entry count limit exceeded');
      if (entry.isEncrypted()) throw new Error('Encrypted EPUB entries are unsupported');
      if (![0, 8].includes(entry.compressionMethod)) throw new Error('Unsupported EPUB compression');
      if (entry.uncompressedSize > MAX_ENTRY || (total += entry.uncompressedSize) > MAX_TOTAL) throw new Error('EPUB decompressed size limit exceeded');
      if (entry.fileName.includes('\0') || entries.has(entry.fileName)) throw new Error('EPUB duplicate or invalid entry name');
      if (((entry.externalFileAttributes >>> 16) & 0xf000) === 0xa000) throw new Error('EPUB symbolic-link entries are unsupported');
      entries.set(entry.fileName, entry);
    }
    let consumed = 0;
    const read = async (name: string, limit: number): Promise<string> => {
      const entry = entries.get(name);
      if (!entry || name.endsWith('/')) throw new Error(`EPUB missing entry: ${name}`);
      if (entry.uncompressedSize > limit) throw new Error('EPUB metadata size limit exceeded');
      const stream = await zip.openReadStreamPromise(entry);
      const chunks: Buffer[] = []; let length = 0;
      try {
        for await (const chunk of stream) {
          length += chunk.length; consumed += chunk.length;
          if (length > limit || consumed > MAX_TOTAL) throw new Error('EPUB decompressed size limit exceeded');
          chunks.push(chunk);
        }
      } finally { stream.destroy(); }
      const data = Buffer.concat(chunks);
      // OCF metadata is UTF-8; reject invalid byte sequences rather than fabricate text.
      return new TextDecoder('utf-8', { fatal: true }).decode(data);
    };
    if ((await read('mimetype', 64)).trim() !== 'application/epub+zip') throw new Error('Invalid EPUB mimetype');
    const container = parseXml(await read('META-INF/container.xml', MAX_XML));
    if (container.name !== 'container' || container.uri !== CONTAINER_NS) throw new Error('Invalid EPUB container');
    const roots = child(container, 'rootfiles', CONTAINER_NS).children.filter(item => item.name === 'rootfile' && item.uri === CONTAINER_NS && item.attributes['media-type'] === 'application/oebps-package+xml');
    if (!roots.length) throw new Error('EPUB package reference missing');
    const packageName = localReference('', roots[0].attributes['full-path']);
    const packageXml = parseXml(await read(packageName, MAX_XML));
    if (packageXml.name !== 'package' || packageXml.uri !== OPF_NS || !/^[23]\.\d+$/.test(packageXml.attributes.version ?? '')) throw new Error('Invalid or unsupported EPUB package');
    child(packageXml, 'metadata', OPF_NS);
    const manifest = child(packageXml, 'manifest', OPF_NS);
    const items = new Map<string, XmlNode>();
    for (const item of manifest.children.filter(item => item.name === 'item' && item.uri === OPF_NS)) {
      if (!item.attributes.id || items.has(item.attributes.id)) throw new Error('EPUB invalid duplicate manifest identity');
      items.set(item.attributes.id, item);
    }
    const spine = child(packageXml, 'spine', OPF_NS).children.filter(item => item.name === 'itemref' && item.uri === OPF_NS);
    if (!spine.length) throw new Error('EPUB spine is empty');
    const text: string[] = [];
    if (entries.has('META-INF/encryption.xml')) {
      // Font obfuscation does not encrypt chapter text and remains supported.
      const encryption = parseXml(await read('META-INF/encryption.xml', MAX_XML));
      const descendants = (node: XmlNode): XmlNode[] => [node, ...node.children.flatMap(descendants)];
      const methods = descendants(encryption).filter(node => node.name === 'EncryptionMethod');
      if (!methods.length || methods.some(node => !['http://www.idpf.org/2008/embedding', 'http://ns.adobe.com/pdf/enc#RC'].includes(node.attributes.Algorithm))) throw new Error('Encrypted EPUB content is unsupported');
    }
    for (const reference of spine) {
      const item = items.get(reference.attributes.idref);
      if (!item) throw new Error('EPUB spine target missing');
      if (!['application/xhtml+xml', 'image/svg+xml'].includes(item.attributes['media-type'])) throw new Error('Unsupported EPUB spine media type');
      text.push(chapterText(await read(localReference(path.posix.dirname(packageName), item.attributes.href), MAX_ENTRY)));
    }
    return { text: text.join('\n'), bytes: zip.fileSize };
  } catch (error) {
    throw new Error(`EPUB parse failed: ${error instanceof Error ? error.message : String(error)}`);
  } finally {
    // Await descriptor release on success and every validation failure.
    if (zip?.isOpen) { const closed = once(zip, 'close'); zip.close(); await closed; }
  }
}

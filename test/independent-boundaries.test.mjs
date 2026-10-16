import test from 'node:test';
import assert from 'node:assert/strict';
import * as nodeModule from 'node:module';
import { existsSync } from 'node:fs';
import { win32, posix } from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { temporary } from './helpers.mjs';
const registerHooks = nodeModule.registerHooks;

// Execute the actual compiled dataDir. Only OS path operations and the filesystem
// boundary are modeled; the ancestry algorithm is neither copied nor replaced.
async function modeledDataDir(product, path, configured, { symlink = false, race } = {}) {
  const artifactRoot = product === 'duplicate-invoice-check' ? process.env.R37_INDEPENDENT_ARTIFACT_ROOT : process.env.R37_COMPANION_ARTIFACT_ROOT;
  const moduleURL = artifactRoot
    ? pathToFileURL(artifactRoot + '/store.js')
    : product === 'duplicate-invoice-check'
      ? new URL('../dist/store.js', import.meta.url)
      : new URL('../../three-way-match/dist/store.js', import.meta.url);
  const target = path.resolve(configured, 'mcp-servers', product);
  const root = path.parse(target).root;
  const nodes = new Map([[root, 'directory']]);
  const inspected = [];
  const created = [];
  if (symlink) {
    let cursor = target;
    while (cursor !== root) { nodes.set(cursor, 'directory'); cursor = path.dirname(cursor); }
    nodes.set(configured, 'symlink');
  }
  const racePath = path.dirname(target);
  const filesystem = {
    existsSync: (value) => nodes.has(value),
    lstatSync(value) {
      inspected.push(value);
      const kind = nodes.get(value);
      if (!kind) throw Object.assign(new Error('missing modeled path'), { code: 'ENOENT' });
      return { isDirectory: () => kind === 'directory', isSymbolicLink: () => kind === 'symlink' };
    },
    mkdirSync(value, options) {
      assert.notEqual(options?.recursive, true, 'bounded creation must not use recursive mkdir');
      assert.equal(nodes.get(path.dirname(value)), 'directory', 'mkdir must visit the parent first');
      if (race && value === racePath) {
        nodes.set(value, race);
        throw Object.assign(new Error('another process created the path'), { code: 'EEXIST' });
      }
      if (nodes.has(value)) throw Object.assign(new Error('path exists'), { code: 'EEXIST' });
      nodes.set(value, 'directory');
      created.push(value);
    },
  };
  for (const name of ['readFileSync', 'readdirSync', 'renameSync', 'unlinkSync', 'writeFileSync']) {
    filesystem[name] = () => { throw new Error('unexpected file operation in directory-only control'); };
  }
  const key = '__independentDirectoryBoundary';
  globalThis[key] = { path, filesystem };
  const code = (value) => 'data:text/javascript,' + encodeURIComponent(value);
  const suffix = `${product}-${path === win32 ? 'win' : 'posix'}-${Date.now()}-${Math.random()}`;
  const hooks = registerHooks({ resolve(specifier, context, next) {
    if (context.parentURL?.startsWith(moduleURL.href)) {
      if (specifier === 'node:path') return { url: code(`export const { dirname,isAbsolute,join,parse,resolve,sep }=globalThis.${key}.path; // ${suffix}`), shortCircuit: true };
      if (specifier === 'node:fs') return { url: code(`export const { existsSync,lstatSync,mkdirSync,readFileSync,readdirSync,renameSync,unlinkSync,writeFileSync }=globalThis.${key}.filesystem; // ${suffix}`), shortCircuit: true };
    }
    return next(specifier, context);
  } });
  const prior = process.env.XDG_DATA_HOME;
  process.env.XDG_DATA_HOME = configured;
  try {
    const actual = await import(moduleURL.href + '?independent=' + encodeURIComponent(suffix));
    if (symlink || race === 'symlink') {
      assert.throws(() => actual.dataDir(), /real directory|symlink/i);
      if (symlink) assert.equal(created.length, 0, 'symlink ancestry must be rejected before writes');
    } else {
      assert.equal(actual.dataDir(), target);
      assert.equal(nodes.get(target), 'directory');
      for (const value of nodes.keys()) assert.ok(inspected.includes(value), 'every ancestor including root must be inspected');
    }
  } finally {
    hooks.deregister();
    delete globalThis[key];
    if (prior === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = prior;
  }
}

for (const product of ['duplicate-invoice-check', 'three-way-match']) {
  const options = { skip: typeof registerHooks !== 'function' ? 'OS-boundary controls need Node 22.15+ module hooks; runtime and stdio test support Node 18'
    : product === 'three-way-match' && !process.env.R37_COMPANION_ARTIFACT_ROOT && !existsSync(new URL('../../three-way-match/dist/store.js', import.meta.url)) ? 'companion product is absent from standalone checkout' : false };
  test(`${product}: actual compiled storage creates every POSIX, drive and UNC ancestor`, options, async () => {
    for (const [path, configured] of [[win32, 'C:\\Users\\review\\data'], [win32, '\\\\server\\share\\review\\data'], [posix, '/review/data']]) {
      await modeledDataDir(product, path, configured);
    }
  });
  test(`${product}: actual compiled storage rejects existing symlink ancestry on every platform`, options, async () => {
    for (const [path, configured] of [[posix, '/review/data'], [win32, 'C:\\Users\\review\\data'], [win32, '\\\\server\\share\\review\\data']]) {
      await modeledDataDir(product, path, configured, { symlink: true });
    }
  });
  test(`${product}: EEXIST directory races are accepted only after lstat rejects symlink replacements`, options, async () => {
    for (const race of ['directory', 'symlink']) {
      await modeledDataDir(product, win32, 'C:\\Users\\review\\data', { race });
    }
  });
}

test('actual stdio quote-heavy CSV respects the escaped 8 MiB budget and pages every source row', async () => {
  const temp = temporary();
  const client = new Client({ name: 'independent-csv-boundary', version: '1' });
  const transport = new StdioClientTransport({ command: process.execPath,
    args: [process.env.R37_INDEPENDENT_ARTIFACT_ROOT ? process.env.R37_INDEPENDENT_ARTIFACT_ROOT + '/index.js' : fileURLToPath(new URL('../dist/index.js', import.meta.url))],
    env: { ...process.env, XDG_DATA_HOME: temp.dir, XDG_CONFIG_HOME: temp.dir, MCP_LICENSE_KEY: '' }, stderr: 'pipe' });
  const records = Array.from({ length: 1000 }, (_, i) => ({
    record_id: '"'.repeat(156) + String(i).padStart(4, '0'), entity_id: '"'.repeat(160), supplier_id: '"'.repeat(160),
    document_type: 'invoice', invoice_number: '"'.repeat(160), invoice_date: '2026-10-16', currency: 'USD', total_minor: 1,
    entity_label: '"'.repeat(200), supplier_label: '"'.repeat(200),
  }));
  const call = async (name, args) => {
    const result = await client.callTool({ name, arguments: args });
    assert.equal(result.isError, undefined, 'valid boundary input must remain usable');
    const bytes = Buffer.byteLength(JSON.stringify({ jsonrpc: '2.0', id: 1, result }), 'utf8');
    assert.ok(bytes <= 8 * 1024 * 1024, `${name} emitted ${bytes} bytes`);
    return JSON.parse(result.content[0].text);
  };
  try {
    await client.connect(transport);
    const checked = await call('duplicate_invoice_check', { records });
    assert.equal(checked.report.summary.candidate_record_count, 1000);
    let offset = 0, total = 0, pages = 0;
    const ids = new Set();
    do {
      const page = await call('report_export_csv', { id: checked.report.retrieval.report_id, offset, limit: 1000 });
      assert.equal(page.offset, offset);
      assert.ok(page.returned > 0 && page.returned <= 1000);
      assert.equal(page.total_rows, 1000);
      const lines = page.csv.split('\r\n').filter(Boolean);
      assert.equal(lines.length, page.returned + 1);
      for (const line of lines.slice(1)) {
        const first = line.match(/^"((?:[^"]|"")*)",/);
        assert.ok(first, 'CSV record id is quoted and complete');
        const id = first[1].replaceAll('""', '"');
        assert.equal(ids.has(id), false, 'CSV pages must not repeat records');
        ids.add(id);
      }
      total += page.returned;
      if (page.next_offset !== null) assert.equal(page.next_offset, offset + page.returned);
      offset = page.next_offset;
      assert.ok(++pages <= 1000, 'paging must make bounded progress');
    } while (offset !== null);
    assert.equal(total, 1000);
    assert.deepEqual([...ids].sort(), records.map((row) => row.record_id).sort());
  } finally { await client.close(); temp.cleanup(); }
});

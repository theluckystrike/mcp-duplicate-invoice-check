import { randomUUID } from 'node:crypto';
import { existsSync, lstatSync, mkdirSync, readFileSync, readdirSync, renameSync, unlinkSync, writeFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { dirname, isAbsolute, join, parse, resolve } from 'node:path';
import { withFileLock } from '@theluckystrike/mcp-license';
import { check, type DuplicateReport } from './core.js';

export interface SavedReport { id: string; created_at: string; report: DuplicateReport }
export const FREE_REPORT_CAP = 3;
export const MAX_STORAGE_BYTES = 64 * 1024 * 1024;
export function assertStorageBudget(used: number, incoming: number) {
  if (!Number.isSafeInteger(used) || !Number.isSafeInteger(incoming) || used < 0 || incoming < 0 || used + incoming > MAX_STORAGE_BYTES) throw new Error('Saved reports exceed the 64 MiB total storage limit; delete reports before saving. The free diagnostic remains available.');
}
const idPattern = /^[0-9a-f]{8}-[0-9a-f]{4}-4[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/;
/** Bounded parent walk; no recursive mkdir on caller-configured virtual paths. */
export function dataDir(): string {
  const configured = process.env.XDG_DATA_HOME || join(homedir(), '.local', 'share');
  if (!isAbsolute(configured)) throw new Error('XDG_DATA_HOME must be an absolute path.');
  const target = resolve(configured, 'mcp-servers', 'duplicate-invoice-check');
  const root = parse(target).root;
  const ancestors: string[] = [];
  let current = target;
  // dirname understands POSIX, Windows drive and UNC roots on the host platform.
  // Bound the walk even if a malformed path implementation never reaches its root.
  while (current !== root) {
    if (ancestors.length >= 256) throw new Error('Storage directory ancestry exceeds the 256-directory safety limit.');
    ancestors.push(current);
    const parent = dirname(current);
    if (parent === current) throw new Error('Storage directory ancestry did not reach its filesystem root.');
    current = parent;
  }
  ancestors.push(root);
  for (const path of ancestors.reverse()) {
    let st;
    try { st = lstatSync(path); }
    catch (e) {
      if ((e as NodeJS.ErrnoException).code !== 'ENOENT' || path === root) throw e;
      try { mkdirSync(path, { mode: 0o700 }); }
      catch (e) { if ((e as NodeJS.ErrnoException).code !== 'EEXIST') throw e; }
      // An EEXIST race is safe only when the resulting object is a real directory.
      st = lstatSync(path);
    }
    if (!st.isDirectory() || st.isSymbolicLink()) throw new Error(`Storage directory must be a real directory: ${path}`);
  }
  return target;
}
function pathFor(id: string): string {
  if (!idPattern.test(id)) throw new Error('Invalid report id; use a report_list id.');
  return join(dataDir(), `${id}.json`);
}
function safeRead(path: string): SavedReport {
  const st = lstatSync(path);
  if (!st.isFile() || st.isSymbolicLink() || st.size > 64 * 1024 * 1024) throw new Error('Invalid saved report file.');
  const stored = JSON.parse(readFileSync(path, 'utf8'));
  if (!idPattern.test(stored.id) || path !== pathFor(stored.id) || typeof stored.created_at !== 'string' || !Number.isFinite(Date.parse(stored.created_at))) throw new Error('Invalid saved report metadata.');
  // Validate persisted documents and derive the evidence anew rather than trusting edited output.
  return { id: stored.id, created_at: stored.created_at, report: check({ records: stored.report.records }) };
}
function ids(): string[] { return readdirSync(dataDir()).filter(n => idPattern.test(n.slice(0, -5)) && n.endsWith('.json')).sort(); }
export async function saveReport(report: DuplicateReport, pro: boolean): Promise<SavedReport | null> {
  const dir = dataDir();
  return withFileLock(join(dir, '.reports.lock'), () => {
    if (!pro && ids().length >= FREE_REPORT_CAP) return null;
    const saved = { id: randomUUID(), created_at: new Date().toISOString(), report };
    const dest = pathFor(saved.id), temp = join(dir, `.${saved.id}.${randomUUID()}.tmp`);
    const serialized = JSON.stringify(saved);
    const used = ids().reduce((n, name) => { const st = lstatSync(join(dir, name)); if (!st.isFile() || st.isSymbolicLink()) throw new Error('Invalid saved report file.'); return n + st.size; }, 0);
    assertStorageBudget(used, Buffer.byteLength(serialized, 'utf8'));
    if (Buffer.byteLength(serialized, 'utf8') > 64 * 1024 * 1024) throw new Error('Saved report exceeds the 64 MiB file integrity limit; the diagnostic report is still available.');
    try { writeFileSync(temp, serialized, { mode: 0o600, flag: 'wx' }); renameSync(temp, dest); }
    finally { if (existsSync(temp)) unlinkSync(temp); }
    return saved;
  });
}
export function getReport(id: string): SavedReport { return safeRead(pathFor(id)); }
export function listReports(offset = 0, limit = 20) {
  const all = ids();
  return { total: all.length, offset, limit, reports: all.slice(offset, offset + limit).map(n => { const r = safeRead(join(dataDir(), n)); return { id: r.id, created_at: r.created_at, status: r.report.status, record_count: r.report.summary.record_count, candidate_record_count: r.report.summary.candidate_record_count, group_count: r.report.groups.length }; }) };
}
export async function deleteReport(id: string): Promise<{ deleted: string }> {
  const path = pathFor(id);
  return withFileLock(join(dirname(path), '.reports.lock'), () => {
    const st = lstatSync(path);
    if (!st.isFile() || st.isSymbolicLink()) throw new Error('Invalid saved report file.');
    unlinkSync(path); return { deleted: id };
  });
}

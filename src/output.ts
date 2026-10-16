import { randomUUID } from 'node:crypto';
import { exportCsv, type DuplicateReport } from './core.js';
import { getReport } from './store.js';
export const PREVIEW_TTL_MS = 30 * 60 * 1000;
export const PREVIEW_CAP = 2;
export const INLINE_LIMIT = 8 * 1024 * 1024;
const previews = new Map<string, { report: DuplicateReport; expires: number }>();
export const pageSections = ['records', 'groups', 'record_summaries', 'group_members'] as const;
export type PageSection = typeof pageSections[number];
function clean() { for (const [id, p] of previews) if (p.expires <= Date.now()) previews.delete(id); }
export function fitsInline(value: unknown) { const text = JSON.stringify(value); return Buffer.byteLength(JSON.stringify({ content: [{ type: 'text', text }] }), 'utf8') <= INLINE_LIMIT - 1024; }
export function resolveReport(id: string): DuplicateReport { clean(); if (!id.startsWith('preview:')) return getReport(id).report; const p = previews.get(id); if (!p) throw new Error('Preview expired, was evicted, or belongs to another process. Resubmit the free diagnostic.'); return p.report; }
export function boundedReport(report: DuplicateReport, savedId?: string) {
  clean(); let id = savedId; let expires: number | undefined;
  if (!id) { id = `preview:${randomUUID()}`; expires = Date.now() + PREVIEW_TTL_MS; while (previews.size >= PREVIEW_CAP) previews.delete(previews.keys().next().value!); previews.set(id, { report, expires }); }
  const retrieval = { report_id: id, page_tool: 'report_page', export_tool: 'report_export_csv', sections: pageSections, ...(expires === undefined ? {} : { expires_at: new Date(expires).toISOString(), preview_policy: 'Last two checks in this process for 30 minutes; resubmit after eviction, expiry or restart.' }) };
  const full = { ...report, retrieval };
  if (fitsInline({ report: full })) return full;
  return { schema_version: report.schema_version, status: report.status, scope: report.scope, summary: report.summary, policy: report.policy, paginated: true, retrieval };
}
export function reportPage(args: { id: string; section: PageSection; offset: number; limit: number; group_id?: string }) {
  const r = resolveReport(args.id); let rows: unknown[];
  if (args.section === 'group_members') { const group = r.groups.find(g => g.group_id === args.group_id); if (!group) throw new Error('group_members requires an existing group_id.'); const ids = new Set(group.record_ids); rows = r.records.filter(row => ids.has(row.record_id)); }
  else if (args.section === 'groups') rows = r.groups.map(({ record_ids, ...g }) => ({ ...g, member_count: record_ids.length }));
  else rows = r[args.section];
  const page = rows.slice(args.offset, args.offset + args.limit); const next = args.offset + page.length;
  return { id: args.id, section: args.section, ...(args.group_id ? { group_id: args.group_id } : {}), offset: args.offset, limit: args.limit, total: rows.length, next_offset: next < rows.length ? next : null, rows: page };
}

/** Shorten a CSV page against its escaped MCP result envelope, never drop source rows. */
export function csvPage(report: DuplicateReport, id: string, offset: number, limit: number) {
  const remaining = Math.max(0, report.records.length - offset);
  const wanted = Math.min(limit, remaining);
  const build = (count: number) => ({ id, csv: exportCsv(report, offset, count), offset, returned: count, total_rows: report.records.length, next_offset: offset + count < report.records.length ? offset + count : null });
  const full = build(wanted);
  if (fitsInline(full)) return full;
  let low = 0, high = wanted - 1;
  let best = build(0);
  while (low <= high) {
    const count = Math.floor((low + high) / 2), candidate = build(count);
    if (fitsInline(candidate)) { best = candidate; low = count + 1; }
    else high = count - 1;
  }
  if (remaining > 0 && best.returned === 0) throw new Error('One CSV record exceeds the response budget; use report_page to retrieve source fields.');
  return best;
}

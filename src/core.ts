import { z } from 'zod';

const token = z.string().min(1).max(160).refine(s => s === s.trim() && !/[\x00-\x1f\x7f]/.test(s), 'Use exact nonblank text without surrounding whitespace or control characters');
const label = z.string().min(1).max(200).refine(s => !/[\x00-\x1f\x7f]/.test(s), 'No control characters');
const date = z.string().regex(/^\d{4}-\d{2}-\d{2}$/).refine(s => { const d = new Date(`${s}T00:00:00.000Z`); return s.slice(0, 4) !== '0000' && Number.isFinite(d.getTime()) && d.toISOString().slice(0, 10) === s; }, 'Use a real ISO calendar date (year 0001-9999)');
export const recordSchema = z.object({ record_id: token, entity_id: token, supplier_id: token, document_type: z.enum(['invoice', 'credit_note']), invoice_number: token, invoice_date: date, currency: z.string().regex(/^[A-Z]{3}$/), total_minor: z.number().int().min(1).max(Number.MAX_SAFE_INTEGER), entity_label: label.optional(), supplier_label: label.optional() }).strict();
export const checkSchema = z.object({ records: z.array(recordSchema).min(1).max(1000).superRefine((rows, ctx) => { const seen = new Set<string>(); rows.forEach((r, i) => { if (seen.has(r.record_id)) ctx.addIssue({ code: 'custom', path: [i, 'record_id'], message: 'record_id must be unique within the supplied batch' }); seen.add(r.record_id); }); }), save: z.boolean().default(false) }).strict();
export type CheckInput = z.infer<typeof checkSchema>;
export type InvoiceRecord = z.infer<typeof recordSchema>;
export const rules = ['exact_reference', 'normalized_reference', 'same_amount_date'] as const;
export type Rule = typeof rules[number];
export interface CandidateGroup { group_id: string; rule: Rule; scope: { entity_id: string; supplier_id: string; document_type: InvoiceRecord['document_type']; currency: string }; match_key: string | { total_minor: number; invoice_date: string }; record_ids: string[]; conflicting_fields: string[]; explanation: string }
export interface DuplicateReport { schema_version: 1; status: 'candidates_for_review' | 'no_candidates_in_supplied_batch'; scope: string; summary: { record_count: number; candidate_record_count: number; unflagged_record_count: number; group_count: number; group_memberships: number }; records: InvoiceRecord[]; groups: CandidateGroup[]; record_summaries: { record_id: string; candidate: boolean; group_ids: string[]; reasons: Rule[] }[]; policy: { normalization: string; scope_fields: string[]; limitations: string[] } }
const compare = (a: string, b: string) => a < b ? -1 : a > b ? 1 : 0;
/** Only ASCII lowercase and four explicit ASCII separators change. No Unicode folding or numeric conversion. */
export function normalizeReference(value: string): string { return value.replace(/[a-z]/g, s => s.toUpperCase()).replace(/[ \-/.]/g, ''); }
/** O(N log N) grouping: at most three memberships per input record, no pair expansion. */
export function check(raw: CheckInput | unknown): DuplicateReport {
  const input = checkSchema.parse(raw);
  const records = input.records.slice().sort((a, b) => compare(a.record_id, b.record_id));
  const buckets = new Map<string, { rule: Rule; key: CandidateGroup['match_key']; records: InvoiceRecord[] }>();
  for (const r of records) {
    const scope = [r.entity_id, r.supplier_id, r.document_type, r.currency];
    const keys: [Rule, CandidateGroup['match_key']][] = [['exact_reference', r.invoice_number], ['normalized_reference', normalizeReference(r.invoice_number)], ['same_amount_date', { total_minor: r.total_minor, invoice_date: r.invoice_date }]];
    for (const [rule, key] of keys) {
      if (key === '') continue;
      const bucketKey = JSON.stringify([scope, rule, key]);
      const bucket = buckets.get(bucketKey) ?? { rule, key, records: [] };
      bucket.records.push(r); buckets.set(bucketKey, bucket);
    }
  }
  const groups: CandidateGroup[] = [...buckets].filter(([, b]) => b.records.length > 1).sort(([a], [b]) => compare(a, b)).map(([, b], i) => {
    const first = b.records[0];
    const fields = ['invoice_number', 'invoice_date', 'total_minor'] as const;
    return { group_id: `G${String(i + 1).padStart(4, '0')}`, rule: b.rule, scope: { entity_id: first.entity_id, supplier_id: first.supplier_id, document_type: first.document_type, currency: first.currency }, match_key: b.key, record_ids: b.records.map(r => r.record_id), conflicting_fields: fields.filter(f => new Set(b.records.map(r => r[f])).size > 1), explanation: b.rule === 'exact_reference' ? 'Identical invoice references in the same exact scope. Amount/date conflicts remain visible and do not suppress this candidate.' : b.rule === 'normalized_reference' ? 'References collide after ASCII case and space/hyphen/slash/dot normalization only. This may be a legitimate reference distinction.' : 'Exact total and invoice date in the same scope. Recurring or distinct legitimate invoices can share both; review source documents.' };
  });
  const byRecord = new Map(records.map(r => [r.record_id, { record_id: r.record_id, candidate: false, group_ids: [] as string[], reasons: [] as Rule[] }]));
  for (const g of groups) for (const id of g.record_ids) { const row = byRecord.get(id)!; row.candidate = true; row.group_ids.push(g.group_id); if (!row.reasons.includes(g.rule)) row.reasons.push(g.rule); }
  const summaries = [...byRecord.values()]; const flagged = summaries.filter(r => r.candidate).length;
  return { schema_version: 1, status: flagged ? 'candidates_for_review' : 'no_candidates_in_supplied_batch', scope: 'Candidate review of supplied records only. No payment approval, fraud verdict, duplicate confirmation, ERP access, or completeness guarantee.', summary: { record_count: records.length, candidate_record_count: flagged, unflagged_record_count: records.length - flagged, group_count: groups.length, group_memberships: groups.reduce((n, g) => n + g.record_ids.length, 0) }, records, groups, record_summaries: summaries, policy: { normalization: 'ASCII a-z to A-Z; remove only ASCII space, hyphen, slash and dot. Preserve leading zeros, all other characters and all Unicode.', scope_fields: ['entity_id', 'supplier_id', 'document_type', 'currency'], limitations: ['Exact supplied identifiers only; no fuzzy supplier/entity joins or currency conversion.', 'Overlapping groups are independent reasons, not confirmed duplicate clusters. Candidate records are counted once; no recoverable amount is calculated.', 'Unflagged records are not safe-to-pay decisions. Missing history, altered dates/amounts and other reference variations can be missed.', 'Credit notes use positive absolute minor-unit totals and are compared only with credit notes.', 'Display labels never affect matching. ISO-like currency codes are syntax checked, not checked against a currency registry.'] } };
}
export function exportCsv(report: DuplicateReport, offset = 0, limit = 1000): string {
  const fields = ['record_id', 'entity_id', 'supplier_id', 'document_type', 'invoice_number', 'invoice_date', 'currency', 'total_minor', 'entity_label', 'supplier_label', 'candidate', 'reasons', 'group_ids'] as const;
  const escape = (v: unknown) => { let s = Array.isArray(v) ? v.join(';') : v == null ? '' : String(v); if (/^[\s]*[=+@\-]/.test(s) || /^[\t\r\n]/.test(s)) s = `'${s}`; return `"${s.replace(/"/g, '""')}"`; };
  const byId = new Map(report.record_summaries.map(r => [r.record_id, r]));
  return [fields.map(escape).join(','), ...report.records.slice(offset, offset + limit).map(r => { const row = { ...r, ...byId.get(r.record_id)! }; return fields.map(f => escape(row[f])).join(','); })].join('\r\n') + '\r\n';
}

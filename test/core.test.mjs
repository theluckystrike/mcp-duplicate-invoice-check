import test from 'node:test';
import assert from 'node:assert/strict';
import { check, checkSchema, normalizeReference, exportCsv } from '../dist/core.js';
import { record, fixture } from './helpers.mjs';
test('complete grouped reasons preserve conflicting evidence and count overlapping candidates once', () => {
  const r = check(fixture()); assert.equal(r.summary.candidate_record_count, 4); assert.equal(r.groups.length, 3); assert.equal(r.summary.group_memberships, 8);
  const exact = r.groups.find(g => g.rule === 'exact_reference'); assert.deepEqual(exact.record_ids, ['R1', 'R2']);
  const norm = r.groups.find(g => g.rule === 'normalized_reference'); assert.deepEqual(norm.record_ids, ['R1', 'R2', 'R3']); assert.deepEqual(norm.conflicting_fields, ['invoice_number', 'invoice_date', 'total_minor']);
  assert.deepEqual(r.groups.find(g => g.rule === 'same_amount_date').record_ids, ['R1', 'R2', 'R4']);
  assert.deepEqual(check({ records: fixture().records.reverse() }), r);
  const differing = check({ records: [record('A'), record('B', { total_minor: 99, invoice_date: '2026-01-01' })] }); assert.equal(differing.groups.length, 2); assert(differing.groups.every(g => g.conflicting_fields.includes('total_minor')));
});
test('normalization preserves leading zeros, Unicode case, accents, lookalikes, other separators and empty keys', () => {
  assert.equal(normalizeReference('inv -/ .001'), 'INV001');
  for (const [a, b] of [['INV001','INV1'], ['é01','É01'], ['O01','001'], ['A_1','A1'], ['A–1','A1'], ['Ａ1','A1'], ['A\u00a01','A1']]) {
    assert.notEqual(normalizeReference(a), normalizeReference(b)); const r = check({ records: [record('A',{invoice_number:a}),record('B',{invoice_number:b,total_minor:99,invoice_date:'2026-01-01'})] }); assert.equal(r.summary.candidate_record_count,0,`${a} vs ${b}`);
  }
  assert.equal(check({ records: [record('A',{invoice_number:'---'}),record('B',{invoice_number:'///',total_minor:99})] }).groups.length,0);
});
test('exact identifiers, tuple-safe scopes, type, currency, amount and date never fuzzily join', () => {
  for (const change of [{entity_id:'ENTITY-2'},{supplier_id:'supplier-1'},{document_type:'credit_note'},{currency:'EUR'}]) assert.equal(check({records:[record('A'),record('B',change)]}).groups.length,0);
  const amountOnly=check({records:[record('A'),record('B',{invoice_number:'OTHER',invoice_date:'2026-10-17'})]}); assert.equal(amountOnly.groups.length,0);
  const dateOnly=check({records:[record('A'),record('B',{invoice_number:'OTHER',total_minor:9999})]}); assert.equal(dateOnly.groups.length,0);
  const collision=check({records:[record('A',{entity_id:'a|b',supplier_id:'c'}),record('B',{entity_id:'a',supplier_id:'b|c'})]}); assert.equal(collision.groups.length,0);
  assert.equal(check({records:[record('A',{entity_label:'One'}),record('B',{entity_label:'Other'})]}).summary.candidate_record_count,2);
});
test('strict schema rejects duplicate ids, unsafe money, bad dates, controls, unknown fields and oversized batches', () => {
  for (const change of [{total_minor:0},{total_minor:-1},{total_minor:0.5},{total_minor:Number.MAX_SAFE_INTEGER+1},{invoice_date:'2026-02-29'},{invoice_date:'2024-02-30'},{invoice_date:'0000-01-01'},{currency:'usd'},{invoice_number:' A'},{supplier_id:'A\nB'},{tax_minor:10},{document_type:'refund'}]) assert.equal(checkSchema.safeParse({records:[record('A',change)]}).success,false,JSON.stringify(change));
  assert.equal(checkSchema.safeParse({records:[record('A'),record('A')]}).success,false);
  assert.equal(checkSchema.safeParse({records:[record()],tax_minor:1}).success,false);
  assert.equal(checkSchema.safeParse({records:[]}).success,false);
  assert.equal(checkSchema.safeParse({records:Array.from({length:1001},(_,i)=>record(String(i)))}).success,false);
  assert.equal(checkSchema.safeParse({records:[record('A',{invoice_date:'2024-02-29',total_minor:Number.MAX_SAFE_INTEGER})]}).success,true);
});
test('independent pairwise oracle agrees with group membership across 2000 deterministic synthetic batches', () => {
  let state=720315; const rand=n=>{state=(Math.imul(state,1664525)+1013904223)>>>0;return state%n;};
  const norm=s=>Array.from(s).filter(c=>![' ','-','/','.'].includes(c)).map(c=>c>='a'&&c<='z'?String.fromCharCode(c.charCodeAt(0)-32):c).join('');
  for(let trial=0;trial<2000;trial++){
    const rows=Array.from({length:2+rand(15)},(_,i)=>record(`R${i}`,{entity_id:`E${rand(2)}`,supplier_id:`S${rand(2)}`,document_type:rand(4)?'invoice':'credit_note',currency:rand(4)?'USD':'EUR',invoice_number:['INV-01','inv /01','INV1','é01','É01','A_B','AB'][rand(7)],total_minor:1+rand(3),invoice_date:`2026-10-${String(1+rand(3)).padStart(2,'0')}`}));
    const expected=new Set(); const pairs=new Set();
    for(let a=0;a<rows.length;a++)for(let b=a+1;b<rows.length;b++){
      const x=rows[a],y=rows[b];if(!['entity_id','supplier_id','document_type','currency'].every(k=>x[k]===y[k]))continue;
      for(const [rule,yes]of[['exact_reference',x.invoice_number===y.invoice_number],['normalized_reference',norm(x.invoice_number)!==''&&norm(x.invoice_number)===norm(y.invoice_number)],['same_amount_date',x.total_minor===y.total_minor&&x.invoice_date===y.invoice_date]])if(yes){expected.add(x.record_id);expected.add(y.record_id);pairs.add(JSON.stringify([rule,...[x.record_id,y.record_id].sort()]));}
    }
    const actual=check({records:rows});assert.equal(actual.summary.candidate_record_count,expected.size);
    const actualPairs=new Set();for(const g of actual.groups)for(let a=0;a<g.record_ids.length;a++)for(let b=a+1;b<g.record_ids.length;b++)actualPairs.add(JSON.stringify([g.rule,g.record_ids[a],g.record_ids[b]]));assert.deepEqual(actualPairs,pairs);
    assert(actual.summary.group_memberships<=3*rows.length);
  }
});
test('CSV contains one source record per row, quoted evidence, and escaped formula-like text',()=>{const r=check({records:[record('=R',{invoice_number:'@SUM(1)',supplier_label:'  =1+1',entity_label:'A,"B"'})]});const csv=exportCsv(r);assert(csv.includes('"\'=R"'));assert(csv.includes('"\'@SUM(1)"'));assert(csv.includes('"\'  =1+1"'));assert(csv.includes('"A,""B"""'));assert.equal(csv.split('\r\n').length,3);assert.equal(exportCsv(r,1,10).split('\r\n').length,2);});

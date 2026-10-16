// Mirror note: tests that need a signed Pro key are skipped here. The signing key
// lives only in the monorepo (keys/license-private.pem); run them there.
import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StdioClientTransport } from '@modelcontextprotocol/sdk/client/stdio.js';
import { fileURLToPath } from 'node:url';
import { fixture, record, temporary } from './helpers.mjs';
test('actual stdio exposes eight tools, rejects unknowns, returns full free diagnosis and caps only saving',async()=>{
 const temp=temporary();const client=new Client({name:'duplicate-invoice-check-smoke',version:'1.0.0'});const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],env:{...process.env,XDG_DATA_HOME:temp.dir,XDG_CONFIG_HOME:temp.dir,MCP_LICENSE_KEY:''},stderr:'pipe'});
 const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args});assert(!r.isError,r.content?.[0]?.text);return JSON.parse(r.content[0].text);};
 try{await client.connect(transport);assert.deepEqual((await client.listTools()).tools.map(t=>t.name).sort(),['duplicate_invoice_check','report_list','report_get','report_page','report_delete','report_export_csv','license_status','license_activate'].sort());assert.equal((await call('license_status')).tier,'free');
 for(const args of [{...fixture(),unknown:1},{records:[record('R',{unknown:1})]},{records:[record('R',{invoice_date:'2026-02-29'})]},{records:[record('R'),record('R')]}])assert.equal((await client.callTool({name:'duplicate_invoice_check',arguments:args})).isError,true);
 const unsaved=await call('duplicate_invoice_check',fixture());assert.equal(unsaved.saved,false);assert.equal(unsaved.report.summary.candidate_record_count,4);const preview=unsaved.report.retrieval.report_id;assert(preview.startsWith('preview:'));assert.equal((await call('report_export_csv',{id:preview})).total_rows,4);
 const x={...fixture(),save:true};const first=await call('duplicate_invoice_check',x);assert.equal(first.saved,true);assert.equal((await call('report_get',{id:first.id})).report.groups.length,3);assert.equal((await call('report_page',{id:first.id,section:'groups',limit:1})).next_offset,1);assert.equal((await call('report_page',{id:first.id,section:'group_members',group_id:first.report.groups[0].group_id})).total,first.report.groups[0].record_ids.length);
 await call('duplicate_invoice_check',x);await call('duplicate_invoice_check',x);const capped=await call('duplicate_invoice_check',x);assert.equal(capped.saved,false);assert.equal(capped.save_error,'free_saved_report_cap');assert.equal(capped.report.summary.candidate_record_count,4);assert(capped.upgrade.includes('/buy/duplicate-invoice-check'));assert.equal((await call('report_export_csv',{id:capped.report.retrieval.report_id})).total_rows,4);assert.equal((await call('report_list')).total,3);await call('report_delete',{id:first.id});assert.equal((await call('duplicate_invoice_check',x)).saved,true);
 assert.equal((await client.callTool({name:'report_get',arguments:{id:'../secret'}})).isError,true);
 const many={records:Array.from({length:1000},(_,i)=>record(`R${String(i).padStart(4,'0')}`))};const large=await call('duplicate_invoice_check',many);assert.equal(large.report.summary.candidate_record_count,1000);assert.equal(large.report.summary.group_memberships,3000);const group=large.report.groups[0];let next=0,total=0;do{const p=await call('report_page',{id:large.report.retrieval.report_id,section:'group_members',group_id:group.group_id,offset:next,limit:100});total+=p.rows.length;next=p.next_offset;}while(next!==null);assert.equal(total,1000);
 }finally{await client.close();temp.cleanup();}
});
test.skip('actual stdio signed single and bundle keys remove only saved-count cap',{skip:!(await import('node:fs')).existsSync(new URL('../../../keys/license-private.pem',import.meta.url))},async()=>{
 const {execFileSync}=await import('node:child_process');
 for(const product of ['duplicate-invoice-check','*']){
  const temp=temporary();const key=execFileSync(process.execPath,[fileURLToPath(new URL('../../../scripts/sign-license.mjs',import.meta.url)),product],{encoding:'utf8'}).trim();
  const client=new Client({name:'duplicate-invoice-check-pro-smoke',version:'1.0.0'});const transport=new StdioClientTransport({command:process.execPath,args:[fileURLToPath(new URL('../dist/index.js',import.meta.url))],env:{...process.env,XDG_DATA_HOME:temp.dir,XDG_CONFIG_HOME:temp.dir,MCP_LICENSE_KEY:key},stderr:'pipe'});
  try{await client.connect(transport);const call=async(name,args={})=>{const r=await client.callTool({name,arguments:args});assert(!r.isError);return JSON.parse(r.content[0].text);};assert.equal((await call('license_status')).tier,'pro');for(let i=0;i<4;i++)assert.equal((await call('duplicate_invoice_check',{...fixture(),save:true})).saved,true);assert.equal((await call('report_list')).total,4);assert.equal((await call('duplicate_invoice_check',fixture())).report.summary.candidate_record_count,4);}
  finally{await client.close();temp.cleanup();}
 }
});

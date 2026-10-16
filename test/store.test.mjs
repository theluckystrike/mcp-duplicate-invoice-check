import test from 'node:test';
import assert from 'node:assert/strict';
import { join } from 'node:path';
import { symlinkSync, readFileSync, writeFileSync, readdirSync, lstatSync, mkdirSync } from 'node:fs';
import { saveReport, listReports, getReport, deleteReport } from '../dist/store.js';
import { check } from '../dist/core.js';
import { fixture, temporary } from './helpers.mjs';
test('file lock serializes concurrent saves; Pro removes only save cap, with safe IDs', async () => {
  const temp = temporary(); const previous = process.env.XDG_DATA_HOME; process.env.XDG_DATA_HOME = temp.dir;
  try {
    const r = check(fixture()); const results = await Promise.all(Array.from({ length: 10 }, () => saveReport(r, false))); assert.equal(results.filter(Boolean).length, 3); assert.equal(listReports().total, 3);
    const pro = await saveReport(r, true); assert(pro); assert.equal(listReports().total, 4); assert.deepEqual(getReport(pro.id).report, r);
    assert.throws(() => getReport('../../secret')); await deleteReport(pro.id); assert.equal(listReports().total, 3);
    const alias = '11111111-1111-4111-8111-111111111111'; symlinkSync(join(temp.dir, 'absent'), join(temp.dir, 'mcp-servers', 'duplicate-invoice-check', `${alias}.json`)); assert.throws(() => getReport(alias), /Invalid saved/);
  } finally { if (previous === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous; temp.cleanup(); }
});
test('independent processes cannot exceed the free saved-report cap', async () => {
  const { spawn } = await import('node:child_process');
  const { fileURLToPath } = await import('node:url');
  const temp = temporary(); const previous = process.env.XDG_DATA_HOME; process.env.XDG_DATA_HOME = temp.dir;
  try {
    const results = await Promise.all(Array.from({ length: 6 }, () => new Promise((resolve, reject) => {
      const child = spawn(process.execPath, [fileURLToPath(new URL('./save-worker.mjs', import.meta.url))], { env: { ...process.env, XDG_DATA_HOME: temp.dir }, stdio: ['ignore', 'pipe', 'pipe'] });
      let output = '', errors = ''; child.stdout.on('data', data => output += data); child.stderr.on('data', data => errors += data); child.on('error', reject); child.on('close', code => { if (code !== 0) reject(new Error(errors)); else resolve(JSON.parse(output)); });
    })));
    assert.equal(results.filter(r => r.saved).length, 3); assert.equal(listReports().total, 3);
  } finally { if (previous === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous; temp.cleanup(); }
});
test('saved evidence is private and atomic; reads recompute edited derived fields and reject invalid sources', async () => {
  const temp = temporary(), previous = process.env.XDG_DATA_HOME; process.env.XDG_DATA_HOME = temp.dir;
  try {
    const r = check(fixture()), saved = await saveReport(r, false);
    const dir = join(temp.dir, 'mcp-servers', 'duplicate-invoice-check'), path = join(dir, `${saved.id}.json`);
    if (process.platform !== 'win32') assert.equal(lstatSync(path).mode & 0o777, 0o600);
    assert.deepEqual(readdirSync(dir), [`${saved.id}.json`]);
    const stored = JSON.parse(readFileSync(path, 'utf8'));
    stored.report.status = 'fake'; stored.report.groups = []; stored.report.summary.candidate_record_count = 0;
    writeFileSync(path, JSON.stringify(stored)); assert.deepEqual(getReport(saved.id).report, r);
    stored.report.records[0].total_minor = 0.5;
    const corrupt = JSON.stringify(stored); writeFileSync(path, corrupt);
    assert.throws(() => getReport(saved.id)); assert.equal(readFileSync(path, 'utf8'), corrupt);
    await deleteReport(saved.id); assert.equal(listReports().total, 0);
  } finally { if (previous === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous; temp.cleanup(); }
});
test('relative paths, non-directories and symlink directory ancestry fail without writes', async () => {
  const temp = temporary(), previous = process.env.XDG_DATA_HOME;
  try {
    process.env.XDG_DATA_HOME = 'relative-storage'; await assert.rejects(() => saveReport(check(fixture()), false), /absolute path/);
    const file = join(temp.dir, 'not-a-directory'); writeFileSync(file, 'preserve');
    process.env.XDG_DATA_HOME = file; await assert.rejects(() => saveReport(check(fixture()), false), /real directory/); assert.equal(readFileSync(file, 'utf8'), 'preserve');
    const target = join(temp.dir, 'real'); mkdirSync(target);
    const link = join(temp.dir, 'alias'); symlinkSync(target, link, 'dir');
    process.env.XDG_DATA_HOME = link; await assert.rejects(() => saveReport(check(fixture()), false), /real directory/); assert.deepEqual(readdirSync(target), []);
  } finally { if (previous === undefined) delete process.env.XDG_DATA_HOME; else process.env.XDG_DATA_HOME = previous; temp.cleanup(); }
});
test('64 MiB aggregate budget uses exact bytes and applies equally to Pro',async()=>{const {assertStorageBudget,MAX_STORAGE_BYTES}=await import('../dist/store.js');assert.doesNotThrow(()=>assertStorageBudget(MAX_STORAGE_BYTES-1,1));assert.throws(()=>assertStorageBudget(MAX_STORAGE_BYTES,1),/64 MiB total storage/);assert.throws(()=>assertStorageBudget(40*1024*1024,25*1024*1024),/64 MiB total storage/);for(const value of [Infinity,-1,0.5,Number.MAX_SAFE_INTEGER+1])assert.throws(()=>assertStorageBudget(value,1));});

import { saveReport } from '../dist/store.js';
import { check } from '../dist/core.js';
import { fixture } from './helpers.mjs';
const saved = await saveReport(check(fixture()), false);
process.stdout.write(JSON.stringify({ saved: saved !== null }));

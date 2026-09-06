#!/usr/bin/env node
import { runHarness, formatReport } from '../src/eval/harness.js';
import { MVP_TASKS } from '../src/eval/tasks.js';

const summary = await runHarness(MVP_TASKS);
const md = formatReport(summary);
console.log(md);
console.log(`\nPass rate: ${(summary.passRate * 100).toFixed(1)}% (${summary.passed}/${summary.total})`);
process.exit(summary.passRate >= 0.7 ? 0 : 1);

import { runHarness } from '../dist/eval/harness.js';
import { MVP_TASKS } from '../dist/eval/tasks.js';

const s = await runHarness(MVP_TASKS);
console.log(JSON.stringify(s, null, 2));
process.exit(s.passRate >= 0.7 ? 0 : 1);

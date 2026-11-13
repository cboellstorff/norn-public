// Child process for the S1 concurrency test: append N questions to <stateDir> as role checkin.
import { record } from '../../engine/lib/records.mjs';
const [dir, w, n] = process.argv.slice(2);
for (let i = 0; i < Number(n); i++)
  record(dir, { kind: 'question', ev: 'create', by: 'checkin', data: { title: `w${w}-${i}`, lane: 'gen', body: 'b', options: [], class: 'i', blocks: [] } }, { views: false });

import { ControllerPasses } from '../src/services/attention-gates.js';
import { AttentionProjector } from '../src/services/attention-projector.js';
import { openDaemonStorage, verified, verifyRecords } from '../src/persisted-records.js';

const path = process.argv[2]!;
const storage = openDaemonStorage(path);
const passes = new ControllerPasses();
const projector = new AttentionProjector(storage, passes, () => new Date());
storage.observeWrites(projector);
let t = performance.now();
projector.rebuild();
console.log(`rebuild ${(performance.now() - t).toFixed(0)} ms`);
for (const item of storage.attention.open())
  console.log(item.code.padEnd(34), item.subjectKey.padEnd(60), item.title.slice(0, 70));
t = performance.now();
projector.rebuild();
console.log(
  `second rebuild (no change) ${(performance.now() - t).toFixed(0)} ms, open ${storage.attention.open().length}`,
);
const v = verifyRecords(storage);
console.log('verified', verified(v), v.counts['attention-item'], v.invalid.slice(0, 3));
storage.close();

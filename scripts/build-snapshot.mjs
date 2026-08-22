import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { CONFIG, applyLogs, emptyState, fetchHistoricalLogs, fetchLogs, hydrate, latestBlock, serialize } from '../src/indexer.js';

await mkdir('public', { recursive: true });
let previous = null;
try { previous = JSON.parse(await readFile('public/snapshot.json', 'utf8')); } catch {}
const state = hydrate(previous || emptyState());
const chainHead = await latestBlock();
const cutoff = chainHead - 25;
const stopAt = state.cutoffBlock;
console.log(`Indexing blocks ${stopAt + 1} through ${cutoff} (head ${chainHead})`);
const progress = ({ address, page, count }) => console.log(`${address.slice(0, 8)} page=${page} logs=${count}`);
const historical = !previous;
const [staking, sNet] = await Promise.all(historical ? [
  fetchHistoricalLogs(CONFIG.staking, stopAt + 1, cutoff, progress),
  fetchHistoricalLogs(CONFIG.sNet, stopAt + 1, cutoff, progress),
] : [
  fetchLogs(CONFIG.staking, { stopAt, cutoff, onProgress: progress }),
  fetchLogs(CONFIG.sNet, { stopAt, cutoff, onProgress: progress }),
]);
applyLogs(state, [...staking, ...sNet]);
state.cutoffBlock = cutoff;
state.indexedAt = new Date().toISOString();
await writeFile('public/snapshot.json', JSON.stringify(serialize(state)) + '\n');
console.log(`Saved ${staking.length + sNet.length} new logs at block ${cutoff}`);

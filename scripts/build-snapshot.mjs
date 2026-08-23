import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createPublicClient, http } from 'viem';
import { CONFIG, applyLogs, emptyState, fetchHistoricalLogs, fetchLogs, hydrate, latestBlock, serialize, viewModel } from '../src/indexer.js';

const treasuryAbi = [{ type: 'function', name: 'rfv', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];
const erc20Abi = [{ type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }, { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }];
const stakingAbi = [{ type: 'function', name: 'totalStaked', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];
const oracleAbi = [{ type: 'function', name: 'twapNetUsdg', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];
const sleeveTokens = new Set(['0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec', '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea', '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9', '0xe93237c50d904957cf27e7b1133b510c669c2e74', '0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3', '0x6330d8c3178a418788df01a47479c0ce7ccf450b']);
const DISCLOSED_SLEEVE_USD = 863_750;
const client = createPublicClient({ transport: http(CONFIG.rpc, { retryCount: 4, timeout: 15_000 }) });

async function collectMetrics(state) {
  const excluded = [CONFIG.genesisBond, CONFIG.staking, CONFIG.taxCollector, CONFIG.bondDepository, CONFIG.rwaDesk, CONFIG.packDesk];
  const [rfv, supply, staked, priceWad, excludedBalances, sleeve] = await Promise.all([
    client.readContract({ address: CONFIG.treasury, abi: treasuryAbi, functionName: 'rfv' }),
    client.readContract({ address: CONFIG.net, abi: erc20Abi, functionName: 'totalSupply' }),
    client.readContract({ address: CONFIG.staking, abi: stakingAbi, functionName: 'totalStaked' }),
    client.readContract({ address: CONFIG.pairOracle, abi: oracleAbi, functionName: 'twapNetUsdg' }).catch(() => 0n),
    Promise.all(excluded.map((address) => client.readContract({ address: CONFIG.net, abi: erc20Abi, functionName: 'balanceOf', args: [address] }))),
    fetch(`${CONFIG.api}/addresses/${CONFIG.managerSleeve}/token-balances`).then((r) => r.ok ? r.json() : null).catch(() => null),
  ]);
  const liveSleeveUsd = Array.isArray(sleeve) ? sleeve.filter((item) => sleeveTokens.has(item.token?.address_hash?.toLowerCase()) && item.token?.exchange_rate).reduce((sum, item) => sum + Number(item.value) / 10 ** Number(item.token.decimals) * Number(item.token.exchange_rate), 0) : null;
  const previousSleeveUsd = [...(state.metricsHistory || [])].reverse().find((point) => Number.isFinite(point.rwaSleeveUsd))?.rwaSleeveUsd;
  const rwaSleeveUsd = liveSleeveUsd ?? previousSleeveUsd ?? DISCLOSED_SLEEVE_USD;
  const supplyNet = Number(supply) / 1e9, stakedNet = Number(staked) / 1e9, price = Number(priceWad) / 1e18;
  const circulatingNet = Math.max(0, supplyNet - excludedBalances.reduce((sum, value) => sum + Number(value) / 1e9, 0));
  const vm = viewModel(state), onchainRfv = Number(rfv) / 1e18;
  return { timestamp: new Date().toISOString(), block: state.cutoffBlock, totalStaked: Number(vm.totalStaked) / 1e9, activeStakers: vm.stakers.filter((row) => BigInt(row.balance) > 0n).length, totalRewards: Number(vm.totalRewards) / 1e9, onchainRfv, rwaSleeveUsd, trueRfvUsd: rwaSleeveUsd == null ? null : onchainRfv + rwaSleeveUsd, supplyNet, stakedNet, stakedPct: supplyNet > 0 ? stakedNet / supplyNet * 100 : 0, circulatingNet, price, circulatingMarketCap: price > 0 ? circulatingNet * price : null, fdv: price > 0 ? supplyNet * price : null };
}

await mkdir('public', { recursive: true });
let previous = null;
try { previous = JSON.parse(await readFile('public/snapshot.json', 'utf8')); } catch {}
const state = hydrate(previous || emptyState());
const chainHead = await latestBlock();
const cutoff = chainHead - 25;
const stopAt = state.cutoffBlock;
console.log(`Indexing blocks ${stopAt + 1} through ${cutoff} (head ${chainHead})`);
const progress = ({ address, page, count }) => console.log(`${address.slice(0, 8)} page=${page} logs=${count}`);
const historical = !previous || Number(previous.cutoffBlock || 0) < CONFIG.deploymentBlock;
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
try {
  const point = await collectMetrics(state);
  state.metricsHistory = [...(state.metricsHistory || []), point].filter((p) => Date.now() - new Date(p.timestamp).getTime() <= 8 * 24 * 60 * 60 * 1000);
} catch (error) { console.warn(`Metrics checkpoint skipped: ${error.message}`); }
await writeFile('public/snapshot.json', JSON.stringify(serialize(state)) + '\n');
console.log(`Saved ${staking.length + sNet.length} new logs at block ${cutoff}`);

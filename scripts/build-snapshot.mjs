import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createPublicClient, http } from 'viem';
import { CONFIG, applyLogs, applyWinNetLogs, emptyState, hydrate, serialize, viewModel } from '../src/indexer.js';

const treasuryAbi = [{ type: 'function', name: 'rfv', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];
const erc20Abi = [{ type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }, { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }];
const stakingAbi = [{ type: 'function', name: 'totalStaked', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];
const drawSettledEvent = { type: 'event', name: 'DrawSettled', inputs: [{ name: 'drawId', type: 'uint256', indexed: true }, { name: 'winner', type: 'address', indexed: true }, { name: 'prizeNet', type: 'uint256', indexed: false }, { name: 'burnedNet', type: 'uint256', indexed: false }] };
const oracleAbi = [{ type: 'function', name: 'twapNetUsdg', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];
const sleeveTokens = new Set(['0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec', '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea', '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9', '0xe93237c50d904957cf27e7b1133b510c669c2e74', '0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3', '0x6330d8c3178a418788df01a47479c0ce7ccf450b']);
const DISCLOSED_SLEEVE_USD = 863_750;
const WSNET_WRAPPER = '0x63c12667638f2ae6fc6ae09b43d98ec84a8586ea';
const client = createPublicClient({ transport: http(CONFIG.rpc, { retryCount: 4, timeout: 15_000 }) });
const knownInfra = new Set([CONFIG.net, CONFIG.sNet, CONFIG.staking, CONFIG.treasury, CONFIG.genesisBond, CONFIG.bondDepository, CONFIG.taxCollector, CONFIG.pairOracle, CONFIG.rwaDesk, CONFIG.packDesk, CONFIG.managerSleeve, CONFIG.winNet, CONFIG.winNetDrawController, WSNET_WRAPPER, '0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead'].map((address) => address.toLowerCase()));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const validSleeveMark = (value) => Number.isFinite(value) && value > 0;

const MAIN_TOPICS = {
  staked: '0x5dac0c1b1112564a045ba943c9d50270893e8e826c49be8e7073adc713ab7bd7',
  unstaked: '0xd8654fcc8cf5b36d30b3f5e4688fc78118e6d68de60b9994e09902268b57c3e3',
  rebased: '0x8d01b778e641f65fc8a5cae34cc83e082ab8b2149b3c1bb3925913116fe4633f',
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  approval: '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
};
const rpcWord = (data = '0x', index = 0) => `0x${data.slice(2 + index * 64, 2 + (index + 1) * 64)}`;
const rpcAddress = (topic = '') => `0x${topic.slice(-40)}`;

async function rpcLogs(address, fromBlock, toBlock, { decodeMain = false, onProgress } = {}) {
  const raw = [];
  const chunkSize = 50_000;
  for (let from = fromBlock; from <= toBlock; from += chunkSize) {
    const to = Math.min(toBlock, from + chunkSize - 1);
    let logs = null;
    for (let attempt = 0; attempt < 5 && !logs; attempt += 1) {
      try { logs = await client.getLogs({ address, fromBlock: BigInt(from), toBlock: BigInt(to) }); }
      catch (error) {
        if (attempt === 4) throw error;
        await pause(1_000 * (attempt + 1));
      }
    }
    raw.push(...logs);
    onProgress?.({ address, page: Math.floor((from - fromBlock) / chunkSize) + 1, count: raw.length });
  }

  const timestamps = new Map();
  const blocks = [...new Set(raw.map((log) => log.blockNumber.toString()))];
  const timestampBatchSize = 75;
  for (let offset = 0; offset < blocks.length; offset += timestampBatchSize) {
    const batch = blocks.slice(offset, offset + timestampBatchSize);
    let payload = null;
    for (let attempt = 0; attempt < 10 && !payload; attempt += 1) {
      try {
        const response = await fetch(CONFIG.rpc, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(batch.map((key, index) => ({ jsonrpc: '2.0', id: index, method: 'eth_getBlockByNumber', params: [`0x${BigInt(key).toString(16)}`, false] }))),
        });
        if (response.ok) payload = await response.json();
      } catch { /* retry below */ }
      if (!payload) await pause(Math.min(10_000, 700 * (attempt + 1)));
    }
    if (!Array.isArray(payload)) throw new Error('Unable to retrieve RPC block timestamp batch');
    for (const item of payload) {
      const key = batch[Number(item.id)];
      if (key != null && item.result?.timestamp) timestamps.set(key, new Date(Number(BigInt(item.result.timestamp)) * 1000).toISOString());
    }
    if (batch.some((key) => !timestamps.has(key))) throw new Error('RPC timestamp batch returned incomplete blocks');
    await pause(250);
  }

  return raw.map((log) => {
    const normalized = {
      address,
      block_number: Number(log.blockNumber),
      block_timestamp: timestamps.get(log.blockNumber.toString()),
      data: log.data,
      index: Number(log.logIndex),
      topics: log.topics,
      transaction_hash: log.transactionHash,
    };
    if (!decodeMain) return normalized;
    const topic = log.topics[0]?.toLowerCase();
    let name, parameters;
    if (topic === MAIN_TOPICS.staked || topic === MAIN_TOPICS.unstaked) {
      name = topic === MAIN_TOPICS.staked ? 'Staked' : 'Unstaked';
      parameters = [{ name: 'from', value: rpcAddress(log.topics[1]) }, { name: 'to', value: rpcAddress(log.topics[2]) }, { name: 'amount', value: BigInt(log.data).toString() }];
    } else if (topic === MAIN_TOPICS.rebased) {
      name = 'Rebased';
      parameters = [{ name: 'epoch', value: BigInt(log.topics[1]).toString() }, { name: 'distributed', value: BigInt(log.data).toString() }];
    } else if (address.toLowerCase() === CONFIG.sNet.toLowerCase() && topic === MAIN_TOPICS.transfer) {
      name = 'Transfer';
      parameters = [{ name: 'from', value: rpcAddress(log.topics[1]) }, { name: 'to', value: rpcAddress(log.topics[2]) }, { name: 'value', value: BigInt(log.data).toString() }];
    } else if (address.toLowerCase() === CONFIG.sNet.toLowerCase() && topic !== MAIN_TOPICS.approval) {
      name = 'LogRebase';
      parameters = [{ name: 'epoch', value: BigInt(log.topics[1]).toString() }, { name: 'rebaseAmount', value: BigInt(rpcWord(log.data, 0)).toString() }, { name: 'index', value: BigInt(rpcWord(log.data, 1)).toString() }];
    } else return null;
    return { ...normalized, decoded: { method_call: `${name}()`, parameters } };
  }).filter(Boolean);
}

function sleeveValue(balances) {
  if (!Array.isArray(balances)) return null;
  const valuedBalances = balances.filter((item) => {
    const value = Number(item.value), decimals = Number(item.token?.decimals), exchangeRate = Number(item.token?.exchange_rate);
    return sleeveTokens.has(item.token?.address_hash?.toLowerCase()) && Number.isFinite(value) && Number.isFinite(decimals) && Number.isFinite(exchangeRate) && exchangeRate > 0;
  });
  if (!valuedBalances.length) return null;
  const total = valuedBalances.reduce((sum, item) => sum + Number(item.value) / 10 ** Number(item.token.decimals) * Number(item.token.exchange_rate), 0);
  return validSleeveMark(total) ? total : null;
}

async function fetchRpcWinNetDraws(fromBlock, toBlock) {
  const logs = await client.getLogs({ address: CONFIG.winNetDrawController, event: drawSettledEvent, fromBlock: BigInt(fromBlock), toBlock: BigInt(toBlock) });
  const timestamps = new Map();
  for (const blockNumber of [...new Set(logs.map((log) => log.blockNumber))]) {
    const block = await client.getBlock({ blockNumber });
    timestamps.set(blockNumber.toString(), new Date(Number(block.timestamp) * 1000).toISOString());
  }
  return logs.map((log) => ({ address: log.address, block_number: Number(log.blockNumber), block_timestamp: timestamps.get(log.blockNumber.toString()), data: log.data, index: Number(log.logIndex), topics: log.topics, transaction_hash: log.transactionHash }));
}

function isUserWalletAddress(address) {
  if (!address?.is_contract) return true;
  if (address.proxy_type?.toLowerCase() === 'eip7702') return true;
  const identity = [
    address.name,
    ...(address.implementations || []).flatMap((implementation) => [implementation.name, implementation.address_hash]),
    ...(address.public_tags || []).flatMap((tag) => [tag.name, tag.display_name, tag.label]),
  ].filter(Boolean).join(' ');
  return /(?:smart.?account|wallet|ambire|safe|argent|kernel|light.?account|simple.?account|coinbase.?smart)/i.test(identity);
}

async function fetchHolderWallets(token) {
  const wallets = new Set(), excluded = new Set(knownInfra);
  let next = null;
  do {
    const query = next ? `?${new URLSearchParams(Object.entries(next).map(([key, value]) => [key, String(value)]))}` : '';
    let page = null;
    for (let attempt = 0; attempt < 8 && !page; attempt += 1) {
      try {
        const response = await fetch(`${CONFIG.api}/tokens/${token}/holders${query}`, { headers: { accept: 'application/json' } });
        if (response.ok) page = await response.json();
        else console.warn(`Holder page retry: token=${token.slice(0, 8)} status=${response.status} attempt=${attempt + 1}`);
      } catch (error) { console.warn(`Holder page retry: token=${token.slice(0, 8)} error=${error.message} attempt=${attempt + 1}`); }
      if (!page) await pause(Math.min(15_000, 1_500 * (attempt + 1)));
    }
    if (!page?.items) throw new Error(`Unable to classify ${token} holders`);
    for (const item of page.items) {
      const address = item.address?.hash?.toLowerCase();
      if (!address) continue;
      if (knownInfra.has(address) || !isUserWalletAddress(item.address)) excluded.add(address);
      else wallets.add(address);
    }
    next = page.next_page_params || null;
    if (next) await pause(350);
  } while (next);
  return { wallets, excluded };
}

async function collectMetrics(state, { classifyHolders = true } = {}) {
  const excluded = [CONFIG.genesisBond, CONFIG.staking, CONFIG.taxCollector, CONFIG.bondDepository, CONFIG.rwaDesk, CONFIG.packDesk];
  const [rfv, supply, staked, priceWad, excludedBalances, sleeve] = await Promise.all([
    client.readContract({ address: CONFIG.treasury, abi: treasuryAbi, functionName: 'rfv' }),
    client.readContract({ address: CONFIG.net, abi: erc20Abi, functionName: 'totalSupply' }),
    client.readContract({ address: CONFIG.staking, abi: stakingAbi, functionName: 'totalStaked' }),
    client.readContract({ address: CONFIG.pairOracle, abi: oracleAbi, functionName: 'twapNetUsdg' }).catch(() => 0n),
    Promise.all(excluded.map((address) => client.readContract({ address: CONFIG.net, abi: erc20Abi, functionName: 'balanceOf', args: [address] }))),
    fetch(`${CONFIG.api}/addresses/${CONFIG.managerSleeve}/token-balances`).then((r) => r.ok ? r.json() : null).catch(() => null),
  ]);
  const liveSleeveUsd = sleeveValue(sleeve);
  const previousSleeveUsd = [...(state.metricsHistory || [])].reverse().find((point) => validSleeveMark(point.rwaSleeveUsd))?.rwaSleeveUsd;
  const rwaSleeveUsd = liveSleeveUsd ?? previousSleeveUsd ?? DISCLOSED_SLEEVE_USD;
  const previousPoint = [...(state.metricsHistory || [])].reverse().find((point) => Number.isFinite(point.walletHolderCount));
  let holderMetrics = null;
  if (classifyHolders) {
    try {
      const [netHolders, sNetHolders, wsNetHolders] = await Promise.all([
        fetchHolderWallets(CONFIG.net),
        fetchHolderWallets(CONFIG.sNet),
        fetchHolderWallets(WSNET_WRAPPER),
      ]);
      const vm = viewModel(state);
      const excludedAddresses = new Set([...netHolders.excluded, ...sNetHolders.excluded, ...wsNetHolders.excluded, ...knownInfra]);
      const directStakers = new Set(vm.stakers.filter((row) => BigInt(row.balance) > 0n && !excludedAddresses.has(row.address.toLowerCase())).map((row) => row.address.toLowerCase()));
      const directHolders = new Set([...netHolders.wallets, ...sNetHolders.wallets, ...directStakers]);
      const winNetHolders = new Set(vm.winNetStakers.filter((row) => BigInt(row.balance) > 0n && !excludedAddresses.has(row.address.toLowerCase())).map((row) => row.address.toLowerCase()));
      const wrappedHolders = new Set(wsNetHolders.wallets);
      const trueHolders = new Set([...directHolders, ...winNetHolders, ...wrappedHolders]);
      const trueStakers = new Set([...sNetHolders.wallets, ...directStakers, ...winNetHolders, ...wrappedHolders]);
      holderMetrics = {
        walletHolderCount: directHolders.size,
        walletStakerCount: directStakers.size,
        trueHolderCount: trueHolders.size,
        trueStakerCount: trueStakers.size,
        directHolderCount: directHolders.size,
        winNetHolderCount: winNetHolders.size,
        wsNetHolderCount: wrappedHolders.size,
        holderOverlapsRemoved: directHolders.size + winNetHolders.size + wrappedHolders.size - trueHolders.size,
        excludedHolderAddresses: [...excludedAddresses],
      };
    } catch (error) { console.warn(`Holder classification fallback: ${error.message}`); }
  } else console.log('Deferring holder classification until after the WinNET checkpoint');
  const supplyNet = Number(supply) / 1e9, stakedNet = Number(staked) / 1e9, price = Number(priceWad) / 1e18;
  const circulatingNet = Math.max(0, supplyNet - excludedBalances.reduce((sum, value) => sum + Number(value) / 1e9, 0));
  const vm = viewModel(state), onchainRfv = Number(rfv) / 1e18;
  return { timestamp: new Date().toISOString(), block: state.cutoffBlock, totalStaked: Number(vm.totalStaked) / 1e9, activeStakers: holderMetrics?.walletStakerCount ?? previousPoint?.walletStakerCount ?? vm.stakers.filter((row) => BigInt(row.balance) > 0n).length, totalRewards: Number(vm.totalRewards) / 1e9, onchainRfv, rwaSleeveUsd, trueRfvUsd: rwaSleeveUsd == null ? null : onchainRfv + rwaSleeveUsd, supplyNet, stakedNet, stakedPct: supplyNet > 0 ? stakedNet / supplyNet * 100 : 0, walletHolderCount: holderMetrics?.walletHolderCount ?? previousPoint?.walletHolderCount ?? null, walletStakerCount: holderMetrics?.walletStakerCount ?? previousPoint?.walletStakerCount ?? null, trueHolderCount: holderMetrics?.trueHolderCount ?? previousPoint?.trueHolderCount ?? null, trueStakerCount: holderMetrics?.trueStakerCount ?? previousPoint?.trueStakerCount ?? null, directHolderCount: holderMetrics?.directHolderCount ?? previousPoint?.directHolderCount ?? null, winNetHolderCount: holderMetrics?.winNetHolderCount ?? previousPoint?.winNetHolderCount ?? null, wsNetHolderCount: holderMetrics?.wsNetHolderCount ?? previousPoint?.wsNetHolderCount ?? null, holderOverlapsRemoved: holderMetrics?.holderOverlapsRemoved ?? previousPoint?.holderOverlapsRemoved ?? null, excludedHolderAddresses: holderMetrics?.excludedHolderAddresses ?? previousPoint?.excludedHolderAddresses ?? [...knownInfra], circulatingNet, price, circulatingMarketCap: price > 0 ? circulatingNet * price : null, fdv: price > 0 ? supplyNet * price : null };
}

await mkdir('public', { recursive: true });
let previous = null;
try { previous = JSON.parse(await readFile('public/snapshot.json', 'utf8')); } catch {}
const state = hydrate(previous || emptyState());
const chainHead = Number(await client.getBlockNumber());
const cutoff = chainHead - 25;
const stopAt = state.cutoffBlock;
console.log(`Indexing blocks ${stopAt + 1} through ${cutoff} (head ${chainHead})`);
const progress = ({ address, page, count }) => console.log(`${address.slice(0, 8)} page=${page} logs=${count}`);
const mainLogs = [
  rpcLogs(CONFIG.staking, stopAt + 1, cutoff, { decodeMain: true, onProgress: progress }),
  rpcLogs(CONFIG.sNet, stopAt + 1, cutoff, { decodeMain: true, onProgress: progress }),
];
const needsWinNetBackfill = !previous || Number(previous.version || 1) < 6 || !previous.winNetCutoffBlock;
if (needsWinNetBackfill) {
  state.winNetCutoffBlock = CONFIG.winNetDeploymentBlock - 1;
  state.winNetWallets = new Map();
  state.winNetActivity = [];
  state.winNetSeen = new Set();
}
const winNetStopAt = Math.max(CONFIG.winNetDeploymentBlock - 1, state.winNetCutoffBlock - 500);
const winNetLogs = rpcLogs(CONFIG.winNet, winNetStopAt + 1, cutoff, { onProgress: progress });
const winNetDrawLogs = rpcLogs(CONFIG.winNetDrawController, winNetStopAt + 1, cutoff, { onProgress: progress });
console.log(needsWinNetBackfill ? `Backfilling WinNET from block ${CONFIG.winNetDeploymentBlock}` : `Updating WinNET after block ${state.winNetCutoffBlock}`);
const rpcWinNetDrawLogs = fetchRpcWinNetDraws(winNetStopAt + 1, cutoff).catch(() => []);
const [staking, sNet, winNet, winNetDraws, rpcWinNetDraws] = await Promise.all([...mainLogs, winNetLogs, winNetDrawLogs, rpcWinNetDrawLogs]);
applyLogs(state, [...staking, ...sNet]);
applyWinNetLogs(state, [...winNet, ...winNetDraws, ...rpcWinNetDraws]);
state.version = 6;
state.cutoffBlock = cutoff;
state.winNetCutoffBlock = cutoff;
state.indexedAt = new Date().toISOString();
try {
  const point = await collectMetrics(state, { classifyHolders: !needsWinNetBackfill });
  state.metricsHistory = [...(state.metricsHistory || []), point].filter((p) => Date.now() - new Date(p.timestamp).getTime() <= 8 * 24 * 60 * 60 * 1000);
} catch (error) { console.warn(`Metrics checkpoint skipped: ${error.message}`); }
await writeFile('public/snapshot.json', JSON.stringify(serialize(state)) + '\n');
console.log(`Saved ${staking.length + sNet.length} staking and ${winNet.length + winNetDraws.length + rpcWinNetDraws.length} WinNET logs at block ${cutoff}`);

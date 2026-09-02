import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createPublicClient, http } from 'viem';
import { CONFIG, applyLogs, applyWinNetLogs, emptyState, hydrate, serialize, viewModel } from '../src/indexer.js';

const treasuryAbi = [{ type: 'function', name: 'rfv', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];
const erc20Abi = [{ type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }, { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }];
const stakingAbi = [{ type: 'function', name: 'totalStaked', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];
const drawSettledEvent = { type: 'event', name: 'DrawSettled', inputs: [{ name: 'drawId', type: 'uint256', indexed: true }, { name: 'winner', type: 'address', indexed: true }, { name: 'prizeNet', type: 'uint256', indexed: false }, { name: 'burnedNet', type: 'uint256', indexed: false }] };
const transferEvent = { type: 'event', name: 'Transfer', inputs: [{ name: 'from', type: 'address', indexed: true }, { name: 'to', type: 'address', indexed: true }, { name: 'value', type: 'uint256', indexed: false }] };
const oracleAbi = [{ type: 'function', name: 'twapNetUsdg', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];
const sleeveTokens = new Set(['0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec', '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea', '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9', '0xe93237c50d904957cf27e7b1133b510c669c2e74', '0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3', '0x6330d8c3178a418788df01a47479c0ce7ccf450b']);
const DISCLOSED_SLEEVE_USD = 863_750;
const WSNET_WRAPPER = '0x63c12667638f2ae6fc6ae09b43d98ec84a8586ea';
const client = createPublicClient({ transport: http(CONFIG.rpc, { retryCount: 4, timeout: 15_000 }) });
const knownInfra = new Set([CONFIG.net, CONFIG.sNet, CONFIG.staking, CONFIG.treasury, CONFIG.genesisBond, CONFIG.bondDepository, CONFIG.taxCollector, CONFIG.pairOracle, CONFIG.rwaDesk, CONFIG.packDesk, CONFIG.managerSleeve, CONFIG.winNet, CONFIG.winNetDrawController, WSNET_WRAPPER, '0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead'].map((address) => address.toLowerCase()));
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const confirmedUserWallets = new Set(['0xbde76bf3c7bbddd8d30fb1750bd62910b64dd55f']);

async function fetchRpcCodes(addresses) {
  const codes = new Map();

  async function classifyBatch(batch) {
    for (let attempt = 0; attempt < 4; attempt += 1) {
      try {
        const response = await fetch(CONFIG.rpc, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify(batch.map((address, index) => ({ jsonrpc: '2.0', id: index, method: 'eth_getCode', params: [address, 'latest'] }))),
        });
        const result = response.ok ? await response.json() : null;
        if (Array.isArray(result)) {
          const byId = new Map(result.map((item) => [item.id, item]));
          for (let index = 0; index < batch.length; index += 1) {
            const item = byId.get(index);
            codes.set(batch[index], item?.result || '0xunknown');
          }
          return;
        }
      } catch {}
      if (attempt < 3) await pause(500 * (attempt + 1));
    }

    if (batch.length > 1) {
      const middle = Math.ceil(batch.length / 2);
      await classifyBatch(batch.slice(0, middle));
      await classifyBatch(batch.slice(middle));
      return;
    }

    console.warn(`Unable to classify holder bytecode: ${batch[0]}`);
    codes.set(batch[0], '0xunknown');
  }

  for (let start = 0; start < addresses.length; start += 100) {
    await classifyBatch(addresses.slice(start, start + 100));
    await pause(75);
  }
  return codes;
}

async function fetchLegacyHolderWallets(token) {
  const addresses = [];
  const offset = 1000;
  for (let page = 1; page <= 1000; page += 1) {
    const params = new URLSearchParams({ module: 'token', action: 'getTokenHolders', contractaddress: token, page: String(page), offset: String(offset) });
    let json = null;
    for (let attempt = 0; attempt < 8 && !json; attempt += 1) {
      try {
        const response = await fetch(`${CONFIG.explorer}/api?${params}`, { headers: { accept: 'application/json' } });
        if (response.ok) json = await response.json();
      } catch {}
      if (!json) await pause(Math.min(10_000, 1_000 * (attempt + 1)));
    }
    if (!Array.isArray(json?.result)) throw new Error(`Unable to read legacy holders for ${token}`);
    const current = json.result.map((item) => item.address?.toLowerCase()).filter(Boolean);
    addresses.push(...current);
    if (current.length < offset) break;
    await pause(250);
  }
  const unique = [...new Set(addresses)];
  const codes = await fetchRpcCodes(unique);
  const wallets = new Set(), excluded = new Set(knownInfra);
  for (const address of unique) {
    const code = (codes.get(address) || '0x').toLowerCase();
    const isContract = code !== '0x' && code !== '0x0';
    const isDelegatedWallet = code.startsWith('0xef0100');
    if (knownInfra.has(address) || (isContract && !isDelegatedWallet && !confirmedUserWallets.has(address))) excluded.add(address);
    else wallets.add(address);
  }
  console.log(`Legacy holder fallback: token=${token.slice(0, 8)} holders=${wallets.size} contracts_excluded=${excluded.size}`);
  return { wallets, excluded };
}
const validSleeveMark = (value) => Number.isFinite(value) && value > 0;
let rpcTimeBaseBlock = 0, rpcTimeBaseMs = Date.now(), rpcBlockMs = 100;

const MAIN_TOPICS = {
  staked: '0x5dac0c1b1112564a045ba943c9d50270893e8e826c49be8e7073adc713ab7bd7',
  unstaked: '0xd8654fcc8cf5b36d30b3f5e4688fc78118e6d68de60b9994e09902268b57c3e3',
  rebased: '0x8d01b778e641f65fc8a5cae34cc83e082ab8b2149b3c1bb3925913116fe4633f',
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  approval: '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
};
const rpcWord = (data = '0x', index = 0) => `0x${data.slice(2 + index * 64, 2 + (index + 1) * 64)}`;
const rpcAddress = (topic = '') => `0x${topic.slice(-40)}`;

async function rpcLogs(address, fromBlock, toBlock, { decodeMain = false, event = null, onProgress } = {}) {
  const raw = [];
  const chunkSize = event ? 200_000 : 50_000;
  let completedRanges = 0;

  async function fetchRange(from, to, depth = 0) {
    for (let attempt = 0; attempt < 6; attempt += 1) {
      try {
        const logs = await client.getLogs({ address, ...(event ? { event } : {}), fromBlock: BigInt(from), toBlock: BigInt(to) });
        completedRanges += 1;
        onProgress?.({ address, page: completedRanges, count: raw.length + logs.length });
        return logs;
      } catch (error) {
        const message = [error?.message, error?.details, error?.cause?.message].filter(Boolean).join(' ');
        const shouldSplit = from < to && (/exceeds limit of 10000|internal server|timeout|invalid parameters/i.test(message) || attempt >= 2);
        if (shouldSplit) {
          const middle = Math.floor((from + to) / 2);
          const older = await fetchRange(from, middle, depth + 1);
          const newer = await fetchRange(middle + 1, to, depth + 1);
          return [...older, ...newer];
        }
        if (attempt === 5) throw error;
        await pause(Math.min(10_000, 750 * (attempt + 1)));
      }
    }
    return [];
  }

  for (let from = fromBlock; from <= toBlock; from += chunkSize) {
    const to = Math.min(toBlock, from + chunkSize - 1);
    raw.push(...await fetchRange(from, to));
    await pause(event ? 100 : 400);
  }

  return raw.map((log) => {
    const normalized = {
      address,
      block_number: Number(log.blockNumber),
      block_timestamp: new Date(rpcTimeBaseMs + (Number(log.blockNumber) - rpcTimeBaseBlock) * rpcBlockMs).toISOString(),
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

function applyHolderTransferLogs(balances, logs) {
  for (const log of logs) {
    if (log.topics?.[0]?.toLowerCase() !== MAIN_TOPICS.transfer) continue;
    const from = rpcAddress(log.topics[1]).toLowerCase(), to = rpcAddress(log.topics[2]).toLowerCase();
    const value = BigInt(log.data || 0);
    if (from !== '0x0000000000000000000000000000000000000000') {
      const current = balances.get(from) || 0n;
      balances.set(from, current > value ? current - value : 0n);
    }
    if (to !== '0x0000000000000000000000000000000000000000') balances.set(to, (balances.get(to) || 0n) + value);
  }
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
        else {
          console.warn(`Holder page retry: token=${token.slice(0, 8)} status=${response.status} attempt=${attempt + 1}`);
          if (response.status === 403) return fetchLegacyHolderWallets(token);
        }
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
  const measuredAt = new Date().toISOString();
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
  const vm = viewModel(state);
  let holderMetrics = null;
  if (classifyHolders) {
    try {
      const candidateHolders = new Set([
        ...[...state.netBalances].filter(([, balance]) => balance > 0n).map(([address]) => address),
        ...[...state.gons].filter(([address, balance]) => address !== CONFIG.staking.toLowerCase() && balance > 0n).map(([address]) => address),
        ...[...state.wsNetBalances].filter(([, balance]) => balance > 0n).map(([address]) => address),
        ...vm.winNetStakers.filter((row) => BigInt(row.balance) > 0n).map((row) => row.address.toLowerCase()),
      ]);
      const codes = await fetchRpcCodes([...candidateHolders]);
      const excludedAddresses = new Set(knownInfra);
      for (const address of candidateHolders) {
        const code = (codes.get(address) || '0x').toLowerCase();
        const isContract = code !== '0x' && code !== '0x0';
        const isDelegatedWallet = code.startsWith('0xef0100');
        if (isContract && !isDelegatedWallet && !confirmedUserWallets.has(address)) excludedAddresses.add(address);
      }
      const directStakers = new Set(vm.stakers.filter((row) => BigInt(row.balance) > 0n && !excludedAddresses.has(row.address.toLowerCase())).map((row) => row.address.toLowerCase()));
      const netHolders = [...state.netBalances].filter(([address, balance]) => balance > 0n && !excludedAddresses.has(address)).map(([address]) => address);
      const sNetHolders = [...state.gons].filter(([address, balance]) => balance > 0n && !excludedAddresses.has(address)).map(([address]) => address);
      const directHolders = new Set([...netHolders, ...sNetHolders, ...directStakers]);
      const winNetHolders = new Set(vm.winNetStakers.filter((row) => BigInt(row.balance) > 0n && !excludedAddresses.has(row.address.toLowerCase())).map((row) => row.address.toLowerCase()));
      const wrappedHolders = new Set([...state.wsNetBalances].filter(([address, balance]) => balance > 0n && !excludedAddresses.has(address)).map(([address]) => address));
      const trueHolders = new Set([...directHolders, ...winNetHolders, ...wrappedHolders]);
      const trueStakers = new Set([...sNetHolders, ...directStakers, ...winNetHolders, ...wrappedHolders]);
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
  } else console.log('Deferring holder classification until after the holder-ledger checkpoint');
  const supplyNet = Number(supply) / 1e9, stakedNet = Number(staked) / 1e9, price = Number(priceWad) / 1e18;
  const circulatingNet = Math.max(0, supplyNet - excludedBalances.reduce((sum, value) => sum + Number(value) / 1e9, 0));
  const onchainRfv = Number(rfv) / 1e18;
  return { timestamp: measuredAt, block: state.cutoffBlock, totalStaked: Number(vm.totalStaked) / 1e9, activeStakers: holderMetrics?.walletStakerCount ?? previousPoint?.walletStakerCount ?? vm.stakers.filter((row) => BigInt(row.balance) > 0n).length, totalRewards: Number(vm.totalRewards) / 1e9, onchainRfv, rwaSleeveUsd, trueRfvUsd: rwaSleeveUsd == null ? null : onchainRfv + rwaSleeveUsd, supplyNet, stakedNet, stakedPct: supplyNet > 0 ? stakedNet / supplyNet * 100 : 0, holderMetricsFresh: Boolean(holderMetrics), holderMetricsAt: holderMetrics ? measuredAt : previousPoint?.holderMetricsAt ?? previousPoint?.timestamp ?? null, walletHolderCount: holderMetrics?.walletHolderCount ?? previousPoint?.walletHolderCount ?? null, walletStakerCount: holderMetrics?.walletStakerCount ?? previousPoint?.walletStakerCount ?? null, trueHolderCount: holderMetrics?.trueHolderCount ?? previousPoint?.trueHolderCount ?? null, trueStakerCount: holderMetrics?.trueStakerCount ?? previousPoint?.trueStakerCount ?? null, directHolderCount: holderMetrics?.directHolderCount ?? previousPoint?.directHolderCount ?? null, winNetHolderCount: holderMetrics?.winNetHolderCount ?? previousPoint?.winNetHolderCount ?? null, wsNetHolderCount: holderMetrics?.wsNetHolderCount ?? previousPoint?.wsNetHolderCount ?? null, holderOverlapsRemoved: holderMetrics?.holderOverlapsRemoved ?? previousPoint?.holderOverlapsRemoved ?? null, excludedHolderAddresses: holderMetrics?.excludedHolderAddresses ?? previousPoint?.excludedHolderAddresses ?? [...knownInfra], circulatingNet, price, circulatingMarketCap: price > 0 ? circulatingNet * price : null, fdv: price > 0 ? supplyNet * price : null };
}

await mkdir('public', { recursive: true });
let previous = null;
try { previous = JSON.parse(await readFile('public/snapshot.json', 'utf8')); } catch {}
const state = hydrate(previous || emptyState());
let chainHead = null;
for (let attempt = 0; attempt < 12 && chainHead == null; attempt += 1) {
  try { chainHead = Number(await client.getBlockNumber()); }
  catch (error) {
    if (attempt === 11) throw error;
    await pause(Math.min(15_000, 1_500 * (attempt + 1)));
  }
}
const cutoff = chainHead - 25;
const stopAt = state.cutoffBlock;
const previousIndexedMs = Date.parse(state.indexedAt || '');
rpcTimeBaseBlock = stopAt;
rpcTimeBaseMs = Number.isFinite(previousIndexedMs) ? previousIndexedMs : Date.now() - Math.max(0, cutoff - stopAt) * 100;
rpcBlockMs = cutoff > stopAt ? Math.max(50, Math.min(1_000, (Date.now() - rpcTimeBaseMs) / (cutoff - stopAt))) : 100;
console.log(`Indexing blocks ${stopAt + 1} through ${cutoff} (head ${chainHead})`);
const progress = ({ address, page, count }) => console.log(`${address.slice(0, 8)} page=${page} logs=${count}`);
const needsWinNetBackfill = !previous || Number(previous.version || 1) < 6 || !previous.winNetCutoffBlock;
const needsHolderBackfill = !previous || Number(previous.version || 1) < 7 || !previous.holderCutoffBlock;
if (needsHolderBackfill) {
  state.holderCutoffBlock = CONFIG.deploymentBlock - 1;
  state.netBalances = new Map();
  state.wsNetBalances = new Map();
}
if (needsWinNetBackfill) {
  state.winNetCutoffBlock = CONFIG.winNetDeploymentBlock - 1;
  state.winNetWallets = new Map();
  state.winNetActivity = [];
  state.winNetSeen = new Set();
}
const winNetStopAt = Math.max(CONFIG.winNetDeploymentBlock - 1, state.winNetCutoffBlock - 500);
console.log(needsWinNetBackfill ? `Backfilling WinNET from block ${CONFIG.winNetDeploymentBlock}` : `Updating WinNET after block ${state.winNetCutoffBlock}`);
const staking = await rpcLogs(CONFIG.staking, stopAt + 1, cutoff, { decodeMain: true, onProgress: progress });
const sNet = await rpcLogs(CONFIG.sNet, stopAt + 1, cutoff, { decodeMain: true, onProgress: progress });
const winNet = await rpcLogs(CONFIG.winNet, winNetStopAt + 1, cutoff, { onProgress: progress });
const winNetDraws = await rpcLogs(CONFIG.winNetDrawController, winNetStopAt + 1, cutoff, { onProgress: progress });
const rpcWinNetDraws = [];
applyLogs(state, [...staking, ...sNet]);
applyWinNetLogs(state, [...winNet, ...winNetDraws, ...rpcWinNetDraws]);
const holderFromBlock = needsHolderBackfill ? CONFIG.deploymentBlock : state.holderCutoffBlock + 1;
console.log(needsHolderBackfill ? `Backfilling holder ledgers from block ${holderFromBlock}` : `Updating holder ledgers after block ${state.holderCutoffBlock}`);
const [netTransfers, wsNetTransfers] = await Promise.all([
  rpcLogs(CONFIG.net, holderFromBlock, cutoff, { event: transferEvent, onProgress: progress }),
  rpcLogs(WSNET_WRAPPER, holderFromBlock, cutoff, { event: transferEvent, onProgress: progress }),
]);
applyHolderTransferLogs(state.netBalances, netTransfers);
applyHolderTransferLogs(state.wsNetBalances, wsNetTransfers);
state.holderCutoffBlock = cutoff;
state.version = 7;
state.cutoffBlock = cutoff;
state.winNetCutoffBlock = cutoff;
state.indexedAt = new Date().toISOString();
try {
  const point = await collectMetrics(state, { classifyHolders: !needsWinNetBackfill });
  state.metricsHistory = [...(state.metricsHistory || []), point].filter((p) => Date.now() - new Date(p.timestamp).getTime() <= 8 * 24 * 60 * 60 * 1000);
} catch (error) { console.warn(`Metrics checkpoint skipped: ${error.message}`); }
await writeFile('public/snapshot.json', JSON.stringify(serialize(state)) + '\n');
console.log(`Saved ${staking.length + sNet.length} staking, ${winNet.length + winNetDraws.length + rpcWinNetDraws.length} WinNET, and ${netTransfers.length + wsNetTransfers.length} holder-transfer logs at block ${cutoff}`);

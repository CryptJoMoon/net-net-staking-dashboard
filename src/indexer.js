export const CONFIG = {
  api: 'https://robinhoodchain.blockscout.com/api/v2',
  explorer: 'https://robinhoodchain.blockscout.com',
  rpc: 'https://rpc.mainnet.chain.robinhood.com',
  staking: '0xB078cc304A0B264C5F3680DC0488954ACcd02E87',
  sNet: '0xb773ec2c326b7f98a5a83fc098825492f020a4c7',
  treasury: '0x04822Ea321A0DEE6F40656172F29312104855d66',
  net: '0xCA9c78Dd337A67F6e0077F65F5E9218719d30eDf',
  genesisBond: '0x575b7B7c97Ef3E21C82DAeB427899d583e1E913f',
  bondDepository: '0xff32a969A0c567129eECD926D04657728E1980C1',
  taxCollector: '0x086C58400b8708Ef993f256E12e752dcF0AC918e',
  pairOracle: '0x929631b33F4070D6f54477fba3FD27566567dAca',
  rwaDesk: '0x99B6eE6eDe47d9a8a9bfd03F728a99B789df1961',
  packDesk: '0x7cf28D61D42352Eb2FD68167e9B08f73CBbF21eB',
  managerSleeve: '0x498752D5fa0600CBd613074C151Abe15B3FeC7CB',
  winNet: '0x7332B329860986e596B2fd71e9c53786c0242ce5',
  deploymentBlock: 11439688,
  winNetDeploymentBlock: 20922503,
  decimals: 9,
};

const INITIAL_SUPPLY = 5_000_000_000n * 1_000_000_000n;
const MAX_UINT = (1n << 256n) - 1n;
const TOTAL_GONS = MAX_UINT - (MAX_UINT % INITIAL_SUPPLY);
const TOPICS = {
  staked: '0x5dac0c1b1112564a045ba943c9d50270893e8e826c49be8e7073adc713ab7bd7',
  unstaked: '0xd8654fcc8cf5b36d30b3f5e4688fc78118e6d68de60b9994e09902268b57c3e3',
  rebased: '0x8d01b778e641f65fc8a5cae34cc83e082ab8b2149b3c1bb3925913116fe4633f',
  transfer: '0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef',
  approval: '0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925',
};
const WINNET_TOPICS = {
  entered: '0xad30511f5397c2d44beaaf7e942e746f493c3dc189163814096d170c8d9f8df6',
  enteredWithNet: '0x12f16f2fae71bc4ed6fe595fe468c4d4dae62bb936851ef11fdd9db0b5568681',
  exited: '0x8a5fb43af839bf26e1fb4b456434b3cf69111df1b3e95abca72edeb31588a7ba',
  exitedToUsdg: '0x976a9f453f5c058ec504d1fd497581dc7cda9fe95209f9dc6f55f8ed749051f0',
  prizePaid: '0x3d8e8e4fb25b225f79c876a0e65b0399b4202048d4d72f276c1f0fa046891167',
  earlyUnlocked: '0xa3fbf5ab09b5d4aef9d96d27ec59daf5803b6b5b80a219070d47c8b907616053',
  fullExit: '0x68443e4550884e7d05d71c512db6fcd2474daf53bf5b98464a53637b9011e560',
};
const lower = (v = '') => v.toLowerCase();
const valueOf = (log, name) => log.decoded?.parameters?.find((p) => p.name === name)?.value;
const eventOf = (log) => log.decoded?.method_call?.split('(')[0] || '';
const idOf = (log) => `${lower(log.address?.hash || log.address)}:${log.transaction_hash}:${log.index}`;
const cmp = (a, b) => a.block_number - b.block_number || a.index - b.index;

export function emptyState() {
  return { version: 4, cutoffBlock: CONFIG.deploymentBlock - 1, winNetCutoffBlock: CONFIG.winNetDeploymentBlock - 1, indexedAt: null, totalSupply: INITIAL_SUPPLY.toString(), gpf: (TOTAL_GONS / INITIAL_SUPPLY).toString(), gons: {}, earned: {}, wallets: {}, activity: [], seen: [], winNetWallets: {}, winNetActivity: [], winNetSeen: [], metricsHistory: [] };
}

export function hydrate(raw) {
  const state = raw || emptyState();
  return {
    ...state,
    totalSupply: BigInt(state.totalSupply), gpf: BigInt(state.gpf),
    gons: new Map(Object.entries(state.gons || {}).map(([k, v]) => [k, BigInt(v)])),
    earned: new Map(Object.entries(state.earned || {}).map(([k, v]) => [k, BigInt(v)])),
    wallets: new Map(Object.entries(state.wallets || {})), seen: new Set(state.seen || []),
    winNetCutoffBlock: state.winNetCutoffBlock || CONFIG.winNetDeploymentBlock - 1,
    winNetWallets: new Map(Object.entries(state.winNetWallets || {})), winNetSeen: new Set(state.winNetSeen || []), winNetActivity: state.winNetActivity || [],
  };
}

export function serialize(state) {
  return {
    version: 4, cutoffBlock: state.cutoffBlock, winNetCutoffBlock: state.winNetCutoffBlock, indexedAt: state.indexedAt,
    totalSupply: state.totalSupply.toString(), gpf: state.gpf.toString(),
    gons: Object.fromEntries([...state.gons].map(([k, v]) => [k, v.toString()])),
    earned: Object.fromEntries([...state.earned].map(([k, v]) => [k, v.toString()])),
    wallets: Object.fromEntries(state.wallets), activity: state.activity.slice(0, 1500),
    seen: [...state.seen].slice(-5000), winNetWallets: Object.fromEntries(state.winNetWallets || []), winNetActivity: (state.winNetActivity || []).slice(0, 1500), winNetSeen: [...(state.winNetSeen || [])].slice(-5000), metricsHistory: (state.metricsHistory || []).slice(-1200),
  };
}

function wallet(state, address) {
  const key = lower(address);
  if (!state.wallets.has(key)) state.wallets.set(key, { address, added: '0', removed: '0', stakes: 0, unstakes: 0, lastActive: null });
  return state.wallets.get(key);
}

function addBig(obj, field, amount) { obj[field] = (BigInt(obj[field] || 0) + amount).toString(); }
const dataUint = (data = '0x', index = 0) => BigInt(`0x${data.slice(2 + index * 64, 2 + (index + 1) * 64) || '0'}`);
const eventAddress = (topic = '') => topic ? `0x${topic.slice(-40)}` : null;

export function applyLogs(state, logs) {
  const ordered = logs.filter((l) => !state.seen.has(idOf(l))).sort(cmp);
  for (const log of ordered) {
    const id = idOf(log); state.seen.add(id);
    state.cutoffBlock = Math.max(state.cutoffBlock, log.block_number);
    state.indexedAt = log.block_timestamp || state.indexedAt;
    const event = eventOf(log), contract = lower(log.address?.hash || log.address);
    if (contract === lower(CONFIG.sNet)) {
      if (event === 'Transfer') {
        const from = lower(valueOf(log, 'from')), toRaw = valueOf(log, 'to'), to = lower(toRaw);
        const amount = BigInt(valueOf(log, 'value') || 0), moved = amount * state.gpf;
        if (from !== '0x0000000000000000000000000000000000000000') state.gons.set(from, (state.gons.get(from) || 0n) - moved);
        if (to !== '0x0000000000000000000000000000000000000000') state.gons.set(to, (state.gons.get(to) || 0n) + moved);
      } else if (event === 'LogRebase') {
        const before = state.gpf, increase = BigInt(valueOf(log, 'rebaseAmount') || 0);
        state.totalSupply += increase; state.gpf = TOTAL_GONS / state.totalSupply;
        if (increase > 0n) for (const [address, gons] of state.gons) {
          if (address === lower(CONFIG.staking) || gons <= 0n) continue;
          const reward = gons / state.gpf - gons / before;
          if (reward > 0n) state.earned.set(address, (state.earned.get(address) || 0n) + reward);
        }
      }
    }
    if (contract === lower(CONFIG.staking) && ['Staked', 'Unstaked', 'Rebased'].includes(event)) {
      const amountName = event === 'Rebased' ? 'distributed' : 'amount';
      const amount = BigInt(valueOf(log, amountName) || 0);
      const actor = event === 'Staked' ? valueOf(log, 'to') : event === 'Unstaked' ? valueOf(log, 'from') : null;
      if (actor) {
        const w = wallet(state, actor); const field = event === 'Staked' ? 'added' : 'removed';
        addBig(w, field, amount); w[event === 'Staked' ? 'stakes' : 'unstakes'] += 1; w.lastActive = log.block_timestamp;
      }
      state.activity.unshift({ id, type: event, actor, recipient: event === 'Unstaked' ? valueOf(log, 'to') : null, amount: amount.toString(), epoch: valueOf(log, 'epoch') || null, block: log.block_number, timestamp: log.block_timestamp, tx: log.transaction_hash });
    }
  }
  state.activity = state.activity.sort((a, b) => b.block - a.block).slice(0, 1500);
  return state;
}

export function applyWinNetLogs(state, logs) {
  const ordered = logs.filter((log) => !state.winNetSeen.has(idOf(log))).sort(cmp);
  for (const log of ordered) {
    const id = idOf(log), topic = lower(log.topics?.[0]), actor = eventAddress(log.topics?.[1]);
    state.winNetSeen.add(id); state.winNetCutoffBlock = Math.max(state.winNetCutoffBlock, log.block_number);
    if (!actor || !Object.values(WINNET_TOPICS).includes(topic)) continue;
    const key = lower(actor);
    if (!state.winNetWallets.has(key)) state.winNetWallets.set(key, { address: actor, principal: '0', entered: '0', exited: '0', prizes: '0', penalties: '0', wins: 0, entries: 0, exits: 0, lastActive: null });
    const wallet = state.winNetWallets.get(key); let type = null, amount = 0n;
    if (topic === WINNET_TOPICS.entered) { amount = dataUint(log.data, 1); addBig(wallet, 'principal', amount); addBig(wallet, 'entered', amount); wallet.entries += 1; type = 'WinNET Entry'; }
    else if (topic === WINNET_TOPICS.enteredWithNet) { amount = dataUint(log.data, 0); addBig(wallet, 'principal', amount); addBig(wallet, 'entered', amount); wallet.entries += 1; type = 'WinNET Entry'; }
    else if (topic === WINNET_TOPICS.exited || topic === WINNET_TOPICS.exitedToUsdg) { amount = dataUint(log.data, 0); wallet.principal = (BigInt(wallet.principal) > amount ? BigInt(wallet.principal) - amount : 0n).toString(); addBig(wallet, 'exited', amount); wallet.exits += 1; type = 'WinNET Exit'; }
    else if (topic === WINNET_TOPICS.prizePaid) { amount = dataUint(log.data, 0); addBig(wallet, 'principal', amount); addBig(wallet, 'prizes', amount); wallet.wins = (wallet.wins || 0) + 1; type = 'WinNET Prize'; }
    else if (topic === WINNET_TOPICS.earlyUnlocked) { amount = dataUint(log.data, 1); wallet.principal = (BigInt(wallet.principal) > amount ? BigInt(wallet.principal) - amount : 0n).toString(); addBig(wallet, 'penalties', amount); type = 'WinNET Penalty'; }
    else if (topic === WINNET_TOPICS.fullExit) { wallet.principal = '0'; type = 'WinNET Full Exit'; }
    if (type) {
      wallet.lastActive = log.block_timestamp;
      state.winNetActivity.unshift({ id, type, actor, amount: amount.toString(), block: log.block_number, timestamp: log.block_timestamp, tx: log.transaction_hash });
    }
  }
  state.winNetActivity = state.winNetActivity.sort((a, b) => b.block - a.block).slice(0, 1500);
  return state;
}

export function viewModel(state) {
  const rows = new Set([...state.wallets.keys(), ...state.gons.keys()]);
  const stakers = [...rows].filter((a) => a !== lower(CONFIG.staking)).map((address) => {
    const w = state.wallets.get(address) || { address, added: '0', removed: '0', stakes: 0, unstakes: 0, lastActive: null };
    return { ...w, address: w.address || address, balance: ((state.gons.get(address) || 0n) / state.gpf).toString(), rewards: (state.earned.get(address) || 0n).toString() };
  }).filter((w) => BigInt(w.added) || BigInt(w.removed) || BigInt(w.balance)).sort((a, b) => BigInt(a.balance) === BigInt(b.balance) ? 0 : BigInt(a.balance) > BigInt(b.balance) ? -1 : 1);
  const totalStaked = stakers.reduce((n, w) => n + BigInt(w.balance), 0n);
  const totalRewards = stakers.reduce((n, w) => n + BigInt(w.rewards), 0n);
  const since = Date.now() - 24 * 60 * 60 * 1000;
  const activity24h = state.activity.filter((a) => a.timestamp && new Date(a.timestamp).getTime() >= since);
  const adds24h = activity24h.filter((a) => a.type === 'Staked').reduce((n, a) => n + BigInt(a.amount), 0n);
  const removals24h = activity24h.filter((a) => a.type === 'Unstaked').reduce((n, a) => n + BigInt(a.amount), 0n);
  const winNetStakers = [...(state.winNetWallets || new Map()).values()].map((wallet) => ({ ...wallet, balance: wallet.principal, added: wallet.entered, removed: (BigInt(wallet.exited || 0) + BigInt(wallet.penalties || 0)).toString(), rewards: wallet.prizes, lotteryWins: wallet.wins || 0, stakes: wallet.entries, unstakes: wallet.exits, venue: 'WinNET' }));
  return { stakers, winNetStakers, activity: state.activity, winNetActivity: state.winNetActivity || [], totalStaked: totalStaked.toString(), totalRewards: totalRewards.toString(), adds24h: adds24h.toString(), removals24h: removals24h.toString(), cutoffBlock: state.cutoffBlock, winNetCutoffBlock: state.winNetCutoffBlock, indexedAt: state.indexedAt };
}

async function request(url, attempts = 6) {
  for (let i = 0; i < attempts; i++) {
    try { const r = await fetch(url, { headers: { accept: 'application/json' } }); if (r.ok) return await r.json(); } catch {}
    await new Promise((resolve) => setTimeout(resolve, 700 * (i + 1)));
  }
  throw new Error('Blockscout is temporarily rate-limiting requests. Retrying on the next refresh.');
}

export async function fetchLogs(address, { stopAt = 0, cutoff = Infinity, onProgress } = {}) {
  let url = `${CONFIG.api}/addresses/${address}/logs`, page = 0; const all = [];
  while (url && page < 1000) {
    const json = await request(url); page += 1;
    const items = json.items || []; all.push(...items.filter((l) => l.block_number > stopAt && l.block_number <= cutoff));
    onProgress?.({ address, page, count: all.length });
    if (!json.next_page_params || items.some((l) => l.block_number <= stopAt)) break;
    const params = new URLSearchParams(Object.entries(json.next_page_params).map(([k, v]) => [k, String(v)]));
    url = `${CONFIG.api}/addresses/${address}/logs?${params}`;
  }
  return all;
}

const word = (hex, n) => `0x${hex.slice(2 + n * 64, 2 + (n + 1) * 64)}`;
const topicAddress = (topic) => `0x${topic.slice(-40)}`;
function normalizeLegacy(log, address) {
  const t = lower(log.topics?.[0]), isStaking = lower(address) === lower(CONFIG.staking);
  let name, parameters = [];
  if (t === TOPICS.staked || t === TOPICS.unstaked) {
    name = t === TOPICS.staked ? 'Staked' : 'Unstaked';
    parameters = [{ name: 'from', value: topicAddress(log.topics[1]) }, { name: 'to', value: topicAddress(log.topics[2]) }, { name: 'amount', value: BigInt(log.data).toString() }];
  } else if (t === TOPICS.rebased) {
    name = 'Rebased'; parameters = [{ name: 'epoch', value: BigInt(log.topics[1]).toString() }, { name: 'distributed', value: BigInt(log.data).toString() }];
  } else if (!isStaking && t === TOPICS.transfer) {
    name = 'Transfer'; parameters = [{ name: 'from', value: topicAddress(log.topics[1]) }, { name: 'to', value: topicAddress(log.topics[2]) }, { name: 'value', value: BigInt(log.data).toString() }];
  } else if (!isStaking && t !== TOPICS.approval) {
    name = 'LogRebase'; parameters = [{ name: 'epoch', value: BigInt(log.topics[1]).toString() }, { name: 'rebaseAmount', value: BigInt(word(log.data, 0)).toString() }, { name: 'index', value: BigInt(word(log.data, 1)).toString() }];
  } else return null;
  return { address, block_number: Number(BigInt(log.blockNumber)), block_timestamp: new Date(Number(BigInt(log.timeStamp)) * 1000).toISOString(), data: log.data, decoded: { method_call: `${name}()`, parameters }, index: Number(BigInt(log.logIndex)), topics: log.topics, transaction_hash: log.transactionHash };
}

export async function fetchHistoricalLogs(address, fromBlock, toBlock, onProgress) {
  let requests = 0;
  async function range(from, to) {
    const params = new URLSearchParams({ module: 'logs', action: 'getLogs', fromBlock: String(from), toBlock: String(to), address });
    let json;
    for (let retry = 0; retry < 8; retry++) {
      json = await request(`https://robinhoodchain.blockscout.com/api?${params}`); requests += 1;
      if (!/Too many requests/i.test(json.message || json.result || '')) break;
      await new Promise((resolve) => setTimeout(resolve, 1200 * (retry + 1)));
    }
    if (json.status === '0' && /No logs/i.test(json.message || json.result || '')) return [];
    const items = Array.isArray(json.result) ? json.result : [];
    onProgress?.({ address, page: requests, count: items.length });
    if (items.length >= 1000 && from < to) {
      const mid = Math.floor((from + to) / 2);
      const [a, b] = await Promise.all([range(from, mid), range(mid + 1, to)]);
      return [...a, ...b];
    }
    return items;
  }
  return (await range(fromBlock, toBlock)).map((log) => normalizeLegacy(log, address)).filter(Boolean);
}

export async function fetchRawHistoricalLogs(address, fromBlock, toBlock, onProgress) {
  let requests = 0;
  async function range(from, to) {
    const params = new URLSearchParams({ module: 'logs', action: 'getLogs', fromBlock: String(from), toBlock: String(to), address });
    let json;
    for (let retry = 0; retry < 8; retry++) {
      json = await request(`https://robinhoodchain.blockscout.com/api?${params}`); requests += 1;
      if (!/Too many requests/i.test(json.message || json.result || '')) break;
      await new Promise((resolve) => setTimeout(resolve, 1200 * (retry + 1)));
    }
    if (json?.status === '0' && /No logs/i.test(json.message || json.result || '')) return [];
    const items = Array.isArray(json?.result) ? json.result : [];
    onProgress?.({ address, page: requests, count: items.length });
    if (items.length >= 1000 && from < to) {
      const mid = Math.floor((from + to) / 2);
      const [older, newer] = await Promise.all([range(from, mid), range(mid + 1, to)]);
      return [...older, ...newer];
    }
    if (!Array.isArray(json?.result)) throw new Error(`Unable to backfill logs for ${address}`);
    return items;
  }
  return (await range(fromBlock, toBlock)).map((log) => ({
    address,
    block_number: Number(BigInt(log.blockNumber)),
    block_timestamp: new Date(Number(BigInt(log.timeStamp)) * 1000).toISOString(),
    data: log.data,
    index: Number(BigInt(log.logIndex)),
    topics: log.topics,
    transaction_hash: log.transactionHash,
  }));
}

export async function latestBlock() {
  const body = await request(`${CONFIG.api}/blocks?type=block`);
  if (!body.items?.[0]?.height) throw new Error('Unable to read the current Robinhood Chain block.');
  return Number(body.items[0].height);
}

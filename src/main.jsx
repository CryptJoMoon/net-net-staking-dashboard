import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, ArrowDownToLine, ArrowUpFromLine, Coins, ExternalLink, RefreshCw, Search, Trophy, Users } from 'lucide-react';
import { createPublicClient, http } from 'viem';
import { CONFIG, applyLogs, applyWinNetLogs, emptyState, fetchLogs, hydrate, latestBlock, viewModel } from './indexer.js';
import './styles.css';

const UNIT = 10n ** 9n;
const WAD = 10n ** 18n;
const treasuryAbi = [{ type: 'function', name: 'rfv', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }, { type: 'function', name: 'liquidUsdg', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }, { type: 'function', name: 'morphoAssets', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }, { type: 'function', name: 'polRfv', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }, { type: 'function', name: 'backingPerToken', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];
const erc20Abi = [{ type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }, { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }];
const stakingAbi = [{ type: 'function', name: 'totalStaked', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];
const oracleAbi = [{ type: 'function', name: 'twapNetUsdg', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];
const drawControllerAbi = [{ type: 'function', name: 'treeSize', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];
const drawSettledEvent = { type: 'event', name: 'DrawSettled', inputs: [{ name: 'drawId', type: 'uint256', indexed: true }, { name: 'winner', type: 'address', indexed: true }, { name: 'prizeNet', type: 'uint256', indexed: false }, { name: 'burnedNet', type: 'uint256', indexed: false }] };
const sleeveTokens = new Set(['0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec', '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea', '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9', '0xe93237c50d904957cf27e7b1133b510c669c2e74', '0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3', '0x6330d8c3178a418788df01a47479c0ce7ccf450b']);
const DISCLOSED_SLEEVE_USD = 863_750;
const WINNET_VAULT = '0x7332b329860986e596b2fd71e9c53786c0242ce5';
const WSNET_WRAPPER = '0x63c12667638f2ae6fc6ae09b43d98ec84a8586ea';
const WINNET_DRAW_CONTROLLER = '0xcC4A7C03A2d4D248B8dA0E35C178944799feac70';
const confirmedUserWallets = new Set(['0xbde76bf3c7bbddd8d30fb1750bd62910b64dd55f']);
const knownInfra = new Set([CONFIG.net, CONFIG.sNet, CONFIG.staking, CONFIG.treasury, CONFIG.genesisBond, CONFIG.bondDepository, CONFIG.taxCollector, CONFIG.pairOracle, CONFIG.rwaDesk, CONFIG.packDesk, CONFIG.managerSleeve, '0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead'].map((address) => address.toLowerCase()));
const SLEEVE_CACHE_KEY = 'netnet-rwa-sleeve-v1';
const SLEEVE_CACHE_MAX_AGE = 48 * 60 * 60 * 1000;
let snapshotSleeveFallback = null;
const publicClient = createPublicClient({ transport: http(CONFIG.rpc, { retryCount: 3, timeout: 10_000 }) });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
async function fetchRpcWinNetDraws(fromBlock, toBlock) {
  const logs = await publicClient.getLogs({ address: CONFIG.winNetDrawController, event: drawSettledEvent, fromBlock: BigInt(fromBlock), toBlock: BigInt(toBlock) });
  const timestamps = new Map();
  for (const blockNumber of [...new Set(logs.map((log) => log.blockNumber))]) {
    const block = await publicClient.getBlock({ blockNumber });
    timestamps.set(blockNumber.toString(), new Date(Number(block.timestamp) * 1000).toISOString());
  }
  return logs.map((log) => ({ address: log.address, block_number: Number(log.blockNumber), block_timestamp: timestamps.get(log.blockNumber.toString()), data: log.data, index: Number(log.logIndex), topics: log.topics, transaction_hash: log.transactionHash }));
}
async function fetchSleeveBalances() {
  for (let attempt = 0; attempt < 4; attempt += 1) {
    try {
      const response = await fetch(`${CONFIG.api}/addresses/${CONFIG.managerSleeve}/token-balances`, { cache: 'no-store', headers: { accept: 'application/json' } });
      if (response.ok) {
        const balances = await response.json();
        if (Array.isArray(balances)) return balances;
      }
    } catch { /* retry transient explorer errors */ }
    if (attempt < 3) await pause(600 * (attempt + 1));
  }
  return null;
}
function sleeveValue(balances) {
  return balances.filter((item) => sleeveTokens.has(item.token?.address_hash?.toLowerCase()) && item.token?.exchange_rate).reduce((sum, item) => sum + Number(item.value) / (10 ** Number(item.token.decimals)) * Number(item.token.exchange_rate), 0);
}
function cachedSleeveValue() {
  const candidates = [snapshotSleeveFallback];
  try { candidates.push(JSON.parse(localStorage.getItem(SLEEVE_CACHE_KEY))); } catch { /* unavailable or malformed cache */ }
  return candidates.filter((item) => Number.isFinite(item?.value) && Date.now() - new Date(item.timestamp).getTime() <= SLEEVE_CACHE_MAX_AGE).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0]?.value ?? DISCLOSED_SLEEVE_USD;
}
function rememberSleeveValue(value) {
  try { localStorage.setItem(SLEEVE_CACHE_KEY, JSON.stringify({ value, timestamp: new Date().toISOString() })); } catch { /* storage can be disabled */ }
}
function amount(raw, max = 4) {
  const value = BigInt(raw || 0), whole = value / UNIT, fraction = (value % UNIT).toString().padStart(9, '0').slice(0, max).replace(/0+$/, '');
  return `${Number(whole).toLocaleString()}${fraction ? `.${fraction}` : ''}`;
}
function wadAmount(raw, max = 2) {
  if (raw == null) return '—'; const value = BigInt(raw), whole = value / WAD, fraction = (value % WAD).toString().padStart(18, '0').slice(0, max).replace(/0+$/, '');
  return `${Number(whole).toLocaleString()}${fraction ? `.${fraction}` : ''}`;
}
const usd = (value) => value == null ? '—' : `$${Math.round(value).toLocaleString()}`;
const short = (a) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : 'Protocol';
const when = (date) => date ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' }).format(new Date(date)) + ' UTC' : '—';
const ago = (date) => { if (!date) return '—'; const s = Math.max(0, (Date.now() - new Date(date).getTime()) / 1000); return s < 60 ? `${Math.floor(s)}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`; };

function Window({ title, children, className = '' }) {
  return <section className={`window ${className}`}><div className="titlebar"><span>{title}</span><span className="glyphs"><i>_</i><i>□</i></span></div>{children}</section>;
}
function Readout({ label, value, sub, change, icon: Icon }) {
  return <div className="readout">{Icon && <Icon size={15} />}<div><label>{label}</label><strong>{value}</strong>{sub && <small>{sub}</small>}{change && <em className={`readout-change ${change.tone || ''}`}>{change.text}</em>}</div></div>;
}
function Address({ value }) { return <a className="address" href={`${CONFIG.explorer}/address/${value}`} target="_blank" rel="noreferrer" title={value}>{short(value)} <ExternalLink size={10} /></a>; }

function App() {
  const [state, setState] = useState(null), [head, setHead] = useState(null), [status, setStatus] = useState('Loading historical ledger…'), [error, setError] = useState('');
  const [fund, setFund] = useState(null);
  const [tab, setTab] = useState('stakers'), [venue, setVenue] = useState('all'), [query, setQuery] = useState(''), [sort, setSort] = useState('balance'), [page, setPage] = useState(1);
  const refresh = async (base, quiet = false) => {
    try {
      if (!quiet) setStatus('Checking the chain…'); setError('');
      const chainHead = await latestBlock(); setHead(chainHead);
      const confirmed = chainHead - 5, stopAt = base.cutoffBlock;
      const winNetStopAt = Math.max(CONFIG.winNetDeploymentBlock - 1, base.winNetCutoffBlock - 500);
      const [staking, sNet, winNet, winNetDraws, rpcWinNetDraws] = await Promise.all([fetchLogs(CONFIG.staking, { stopAt, cutoff: confirmed }), fetchLogs(CONFIG.sNet, { stopAt, cutoff: confirmed }), fetchLogs(CONFIG.winNet, { stopAt: winNetStopAt, cutoff: confirmed }), fetchLogs(CONFIG.winNetDrawController, { stopAt: winNetStopAt, cutoff: confirmed }), fetchRpcWinNetDraws(winNetStopAt + 1, confirmed).catch(() => [])]);
      applyLogs(base, [...staking, ...sNet]); base.cutoffBlock = confirmed; base.indexedAt = new Date().toISOString();
      applyWinNetLogs(base, [...winNet, ...winNetDraws, ...rpcWinNetDraws]); base.winNetCutoffBlock = confirmed;
      setState({ ...base }); setStatus('Live');
    } catch (e) { setError(e.message); setStatus('Snapshot mode'); setState({ ...base }); }
  };
  useEffect(() => {
    let alive = true, timer;
    (async () => {
      let snapshot;
      try { const r = await fetch(`/snapshot.json?t=${Date.now()}`); if (!r.ok) throw new Error(); snapshot = await r.json(); }
      catch { snapshot = emptyState(); }
      const lastSleevePoint = [...(snapshot.metricsHistory || [])].reverse().find((point) => Number.isFinite(point.rwaSleeveUsd));
      snapshotSleeveFallback = lastSleevePoint ? { value: lastSleevePoint.rwaSleeveUsd, timestamp: lastSleevePoint.timestamp } : null;
      if (!alive) return; const base = hydrate(snapshot); setState({ ...base }); await refresh(base);
      timer = setInterval(() => refresh(base, true), 15000);
    })();
    return () => { alive = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    let alive = true;
    const loadFund = async () => {
      try {
        const names = ['rfv', 'liquidUsdg', 'morphoAssets', 'polRfv', 'backingPerToken'];
        const excluded = [CONFIG.genesisBond, CONFIG.staking, CONFIG.taxCollector, CONFIG.bondDepository, CONFIG.rwaDesk, CONFIG.packDesk];
        const [values, totalSupply, totalStaked, priceWad, excludedBalances, sleeveResponse, playingTonight] = await Promise.all([
          Promise.all(names.map((functionName) => publicClient.readContract({ address: CONFIG.treasury, abi: treasuryAbi, functionName }))),
          publicClient.readContract({ address: CONFIG.net, abi: erc20Abi, functionName: 'totalSupply' }),
          publicClient.readContract({ address: CONFIG.staking, abi: stakingAbi, functionName: 'totalStaked' }),
          publicClient.readContract({ address: CONFIG.pairOracle, abi: oracleAbi, functionName: 'twapNetUsdg' }).catch(() => 0n),
          Promise.all(excluded.map((address) => publicClient.readContract({ address: CONFIG.net, abi: erc20Abi, functionName: 'balanceOf', args: [address] }))),
          fetchSleeveBalances(),
          publicClient.readContract({ address: WINNET_DRAW_CONTROLLER, abi: drawControllerAbi, functionName: 'treeSize' }).catch(() => null),
        ]);
        const treasury = Object.fromEntries(names.map((name, i) => [name, values[i].toString()]));
        const liveSleeveValue = Array.isArray(sleeveResponse) ? sleeveValue(sleeveResponse) : null;
        if (liveSleeveValue != null) rememberSleeveValue(liveSleeveValue);
        const rwaSleeveUsd = liveSleeveValue ?? cachedSleeveValue();
        const supplyNet = Number(totalSupply) / 1e9, stakedNet = Number(totalStaked) / 1e9, price = Number(priceWad) / 1e18;
        const excludedNet = excludedBalances.reduce((sum, value) => sum + Number(value) / 1e9, 0);
        const circulatingNet = Math.max(0, supplyNet - excludedNet);
        const onchainRfv = Number(values[0]) / 1e18;
        if (alive) setFund({ treasury, rwaSleeveUsd, rwaSleeveCached: liveSleeveValue == null && rwaSleeveUsd != null, trueRfvUsd: rwaSleeveUsd == null ? null : onchainRfv + rwaSleeveUsd, supplyNet, stakedNet, stakedPct: supplyNet > 0 ? stakedNet / supplyNet * 100 : 0, circulatingNet, price, playingTonight: playingTonight == null ? null : Number(playingTonight), circulatingMarketCap: price > 0 ? circulatingNet * price : null, fdv: price > 0 ? supplyNet * price : null });
      } catch { if (alive) setFund(null); }
    };
    loadFund(); const timer = setInterval(loadFund, 60_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  const data = useMemo(() => state ? viewModel(state) : null, [state]);
  const baseline24h = useMemo(() => {
    const cutoff = Date.now() - 24 * 60 * 60 * 1000;
    return [...(state?.metricsHistory || [])].filter((point) => new Date(point.timestamp).getTime() <= cutoff).sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0] || null;
  }, [state]);
  const latestMetrics = useMemo(() => [...(state?.metricsHistory || [])].sort((a, b) => new Date(b.timestamp) - new Date(a.timestamp))[0] || null, [state]);
  const excludedAddresses = useMemo(() => new Set([...knownInfra, ...(latestMetrics?.excludedHolderAddresses || []).map((address) => address.toLowerCase())].filter((address) => !confirmedUserWallets.has(address))), [latestMetrics]);
  const stakeDistribution = useMemo(() => {
    const balances = (data?.stakers || []).filter((row) => BigInt(row.balance) > 0n && !excludedAddresses.has(row.address.toLowerCase())).map((row) => BigInt(row.balance)).sort((a, b) => a < b ? -1 : a > b ? 1 : 0);
    if (!balances.length) return null;
    const total = balances.reduce((sum, value) => sum + value, 0n), middle = Math.floor(balances.length / 2);
    const median = balances.length % 2 ? balances[middle] : (balances[middle - 1] + balances[middle]) / 2n;
    return { median, average: total / BigInt(balances.length), total, count: balances.length };
  }, [data, excludedAddresses]);
  const venueStake = useMemo(() => {
    const byAddress = new Map((data?.stakers || []).map((row) => [row.address.toLowerCase(), BigInt(row.balance || 0)]));
    const winNet = byAddress.get(WINNET_VAULT) || 0n, wsNet = byAddress.get(WSNET_WRAPPER) || 0n;
    return { winNet, wsNet, total: winNet + wsNet };
  }, [data]);
  const change24h = (current, previous, formatter = (n) => Math.round(Math.abs(n)).toLocaleString()) => {
    if (current == null) return null;
    if (previous == null) return { text: '24h baseline building', tone: 'idle' };
    const difference = current - previous, pct = previous !== 0 ? difference / Math.abs(previous) * 100 : null;
    return { text: `24h ${difference >= 0 ? '+' : '−'}${formatter(difference)}${pct == null ? '' : ` (${difference >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%)`}`, tone: difference > 0 ? 'positive' : difference < 0 ? 'negative' : 'idle' };
  };
  const rows = useMemo(() => {
    if (!data) return []; const q = query.toLowerCase().trim();
    const direct = data.stakers.filter((row) => !excludedAddresses.has(row.address.toLowerCase())).map((row) => ({ ...row, venue: 'Direct', lotteryWinnings: '0', lotteryWins: 0 }));
    const lottery = (data.winNetStakers || []).map((row) => ({ ...row, lotteryWinnings: row.prizes || row.rewards || '0' }));
    let source;
    if (venue === 'direct') source = direct;
    else if (venue === 'winnet') source = lottery;
    else {
      const combined = new Map();
      for (const row of [...direct, ...lottery]) {
        const key = row.address.toLowerCase(), current = combined.get(key);
        if (!current) combined.set(key, { ...row });
        else combined.set(key, { ...current, added: (BigInt(current.added || 0) + BigInt(row.added || 0)).toString(), removed: (BigInt(current.removed || 0) + BigInt(row.removed || 0)).toString(), rewards: (BigInt(current.rewards || 0) + BigInt(row.rewards || 0)).toString(), lotteryWinnings: (BigInt(current.lotteryWinnings || 0) + BigInt(row.lotteryWinnings || 0)).toString(), lotteryWins: (current.lotteryWins || 0) + (row.lotteryWins || 0), balance: (BigInt(current.balance || 0) + BigInt(row.balance || 0)).toString(), stakes: (current.stakes || 0) + (row.stakes || 0), unstakes: (current.unstakes || 0) + (row.unstakes || 0), lastActive: new Date(current.lastActive || 0) > new Date(row.lastActive || 0) ? current.lastActive : row.lastActive, venue: current.venue === row.venue ? current.venue : 'Direct + WinNET' });
      }
      source = [...combined.values()];
    }
    return source.filter((r) => !q || r.address.toLowerCase().includes(q)).sort((a, b) => {
      if (sort === 'address') return a.address.localeCompare(b.address);
      const sortField = sort === 'usdValue' ? 'balance' : sort;
      const av = BigInt(a[sortField] || 0), bv = BigInt(b[sortField] || 0); return av === bv ? 0 : av > bv ? -1 : 1;
    });
  }, [data, venue, query, sort, excludedAddresses]);
  const pageSize = 25, pages = Math.max(1, Math.ceil(rows.length / pageSize)), visible = rows.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => setPage(1), [venue, query, sort]);
  if (!data) return <main className="desktop"><div className="boot">NET STAKING LEDGER<br/><span>Reconstructing shareholder records…</span></div></main>;
  const lag = head == null ? null : Math.max(0, head - data.cutoffBlock);
  const netFlow24h = BigInt(data.adds24h) - BigInt(data.removals24h);
  const activeStakers = data.stakers.filter((r) => BigInt(r.balance) > 0n && !excludedAddresses.has(r.address.toLowerCase())).length;
  const walletHolderCount = latestMetrics?.walletHolderCount || null;
  const walletStakerCount = latestMetrics?.walletStakerCount || activeStakers;
  const trueHolderCount = latestMetrics?.trueHolderCount || walletHolderCount;
  const trueStakerCount = latestMetrics?.trueStakerCount || walletStakerCount;
  const addressStakingPct = trueHolderCount > 0 ? trueStakerCount / trueHolderCount * 100 : null;
  const winNetParticipants = (data.winNetStakers || []).filter((row) => BigInt(row.balance) > 0n).length;
  const lotteryWinners = (data.winNetStakers || []).filter((row) => (row.lotteryWins || 0) > 0).length;
  const lotteryPayoutCount = (data.winNetStakers || []).reduce((sum, row) => sum + (row.lotteryWins || 0), 0);
  const lotteryPayouts = (data.winNetStakers || []).reduce((sum, row) => sum + BigInt(row.rewards || 0), 0n);
  const lotteryPayouts24h = (data.winNetActivity || []).filter((event) => event.type === 'WinNET Prize' && event.timestamp && Date.now() - new Date(event.timestamp).getTime() <= 24 * 60 * 60 * 1000);
  const lotteryPayoutAmount24h = lotteryPayouts24h.reduce((sum, event) => sum + BigInt(event.amount || 0), 0n);
  const latestLotteryWin = (data.winNetActivity || []).find((event) => event.type === 'WinNET Draw') || (data.winNetActivity || []).find((event) => event.type === 'WinNET Prize') || null;
  const latestWinner = latestLotteryWin ? (data.winNetStakers || []).find((row) => row.address.toLowerCase() === latestLotteryWin.actor?.toLowerCase()) : null;
  return <main className="desktop"><div className="frame">
    <Window title="NET Staking Ledger — Robinhood Chain" className="masthead">
      <div className="menu"><button className={tab === 'stakers' ? 'active' : ''} onClick={() => setTab('stakers')}><u>S</u>takers</button><button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}><u>A</u>ctivity</button><a href={`${CONFIG.explorer}/address/${CONFIG.staking}?tab=read_write_contract`} target="_blank" rel="noreferrer">Verified Contract</a></div>
      <div className="brand"><div className="crt">NET</div><div><p>NETNET CAPITAL</p><h1>Shareholder Staking Ledger</h1><span>Independent, read-only onchain records</span></div><div className="livebox"><i className={status === 'Live' ? 'on' : ''}/><b>{status}</b><small>{lag == null ? 'Connecting' : `${lag.toLocaleString()} blocks behind head`}</small></div></div>
      {error && <div className="notice">{error}</div>}
    </Window>
    <section className="lottery-banner">
      <div className="lottery-callout"><Trophy size={25}/><div><label>Latest WinNET jackpot winner</label>{latestLotteryWin ? <><strong>{latestLotteryWin.drawId != null ? <>No. {latestLotteryWin.drawId} · </> : null}<Address value={latestLotteryWin.actor}/> won {amount(latestLotteryWin.amount, 2)} NET</strong><small>{when(latestLotteryWin.timestamp)} · {fund?.price > 0 ? usd(Number(latestLotteryWin.amount) / 1e9 * fund.price) : '—'} current value</small></> : <><strong>Tonight could be your night.</strong><small>Public-beacon nightly prize draws backed by pooled NET staking.</small></>}</div></div>
      {latestWinner && <div className="winner-stats"><span><b>{(latestWinner.lotteryWins || 0).toLocaleString()}</b> jackpot wins</span><span><b>{amount(latestWinner.rewards, 2)} NET</b> lifetime won</span><span><b>{fund?.price > 0 ? usd(Number(latestWinner.rewards) / 1e9 * fund.price) : '—'}</b> winnings value</span><span><b>{amount(latestWinner.balance, 2)} NET</b>{fund?.price > 0 ? `${usd(Number(latestWinner.balance) / 1e9 * fund.price)} current stake value` : 'Current WinNET stake'}</span></div>}
      <div className="lottery-cta"><a href="https://win.netnet.capital/?ref=cryptjomoon" target="_blank" rel="noreferrer sponsored">Play WinNET <ExternalLink size={13}/></a><small>Affiliate link · 18+ · prizes vary</small></div>
    </section>
    <div className="stats">
      <Readout icon={Coins} label="Total staked" value={`${amount(data.totalStaked, 2)} sNET`} sub={stakeDistribution ? `Median ${amount(stakeDistribution.median, 2)} NET · Average ${amount(stakeDistribution.average, 2)} NET` : 'Current holder balances'} change={change24h(Number(data.totalStaked) / 1e9, baseline24h?.totalStaked)} />
      <Readout icon={ArrowDownToLine} label="24-hour adds" value={`+${amount(data.adds24h, 2)} NET`} sub="Rolling staking deposits" change={{ text: fund?.price > 0 ? `${usd(Number(data.adds24h) / 1e9 * fund.price)} at current TWAP` : 'USD value loading', tone: 'idle' }} />
      <Readout icon={ArrowUpFromLine} label="24-hour removals" value={`−${amount(data.removals24h, 2)} NET`} sub="Rolling staking withdrawals" change={{ text: fund?.price > 0 ? `${usd(Number(data.removals24h) / 1e9 * fund.price)} at current TWAP` : 'USD value loading', tone: 'idle' }} />
      <Readout icon={netFlow24h >= 0n ? ArrowUpFromLine : ArrowDownToLine} label="24-hour net flow" value={`${netFlow24h >= 0n ? '+' : '−'}${amount(netFlow24h >= 0n ? netFlow24h : -netFlow24h, 2)} NET`} sub="Adds minus removals" change={{ text: `${netFlow24h > 0n ? 'Net staking growth' : netFlow24h < 0n ? 'Net staking outflow' : 'No net change'}${fund?.price > 0 && netFlow24h !== 0n ? ` · ${netFlow24h > 0n ? '+' : '−'}${usd(Number(netFlow24h > 0n ? netFlow24h : -netFlow24h) / 1e9 * fund.price)} at current TWAP` : ''}`, tone: netFlow24h > 0n ? 'positive' : netFlow24h < 0n ? 'negative' : 'idle' }} />
      <Readout icon={Coins} label="True RFV (memo)" value={fund ? usd(fund.trueRfvUsd) : 'Loading…'} sub={fund ? `${wadAmount(fund.treasury.rfv)} on-chain + ${usd(fund.rwaSleeveUsd)} RWA sleeve${fund.rwaSleeveCached ? ' · last known mark' : ''} · team-custodied` : 'RFV + team-custodied Sleeve'} change={change24h(fund?.trueRfvUsd, baseline24h?.trueRfvUsd, (n) => `$${Math.round(Math.abs(n)).toLocaleString()}`)} />
      <Readout icon={Activity} label="Circulating market cap" value={fund ? usd(fund.circulatingMarketCap) : 'Loading…'} sub={fund && fund.price > 0 ? `${Math.round(fund.circulatingNet).toLocaleString()} NET × ${fund.price.toFixed(3)} USDG` : 'Floating supply × TWAP'} change={change24h(fund?.circulatingMarketCap, baseline24h?.circulatingMarketCap, (n) => `$${Math.round(Math.abs(n)).toLocaleString()}`)} />
      <Readout icon={Coins} label="Fully diluted market cap" value={fund ? usd(fund.fdv) : 'Loading…'} sub="Total supply × TWAP" change={change24h(fund?.fdv, baseline24h?.fdv, (n) => `$${Math.round(Math.abs(n)).toLocaleString()}`)} />
      <Readout icon={Activity} label="Market price" value={fund?.price > 0 ? `${fund.price.toFixed(4)} USDG` : 'Loading…'} sub="One-hour NET/USDG TWAP" change={change24h(fund?.price > 0 ? fund.price : null, baseline24h?.price, (n) => Math.abs(n).toFixed(4))} />
      <Readout icon={Users} label="Supply" value={fund ? `${Math.round(fund.supplyNet).toLocaleString()} NET` : 'Loading…'} sub={fund ? `${fund.stakedPct.toFixed(1)}% staked · ${Math.round(fund.stakedNet).toLocaleString()} NET` : 'Live on-chain supply'} change={change24h(fund?.supplyNet, baseline24h?.supplyNet)} />
      <Readout icon={Users} label="True unique holders" value={trueHolderCount?.toLocaleString() || 'Indexing…'} sub={latestMetrics?.trueHolderCount ? `${latestMetrics.directHolderCount.toLocaleString()} NET/sNET · ${latestMetrics.winNetHolderCount.toLocaleString()} WinNET · ${latestMetrics.wsNetHolderCount.toLocaleString()} wsNET · ${latestMetrics.holderOverlapsRemoved.toLocaleString()} overlaps removed · ${trueStakerCount.toLocaleString()} stakers (${addressStakingPct.toFixed(1)}%)` : 'Combining direct and contract-underlying holders'} change={change24h(trueHolderCount, baseline24h?.trueHolderCount)} />
      <Readout icon={Users} label="Direct wallet stake" value={stakeDistribution ? `${amount(stakeDistribution.total, 2)} sNET` : 'Loading…'} sub={stakeDistribution ? `${stakeDistribution.count.toLocaleString()} active wallet positions · contracts excluded` : 'Wallet-only staking balance'} />
      <Readout icon={Coins} label="WinNET pooled stake" value={`${amount(venueStake.winNet, 2)} sNET`} sub={`${winNetParticipants.toLocaleString()} active principal wallets${fund?.playingTonight != null ? ` · ${fund.playingTonight.toLocaleString()} playing tonight` : ''}`} />
      <Readout icon={Coins} label="wsNET collateral wrapper" value={`${amount(venueStake.wsNet, 2)} sNET`} sub="Wrapped staked NET for lending/perpetual collateral · not WinNET lottery stake" />
      <Readout icon={Coins} label="WinNET jackpot payouts" value={`${amount(lotteryPayouts, 2)} NET`} sub={`${fund?.price > 0 ? usd(Number(lotteryPayouts) / 1e9 * fund.price) : '—'} current value · ${lotteryPayoutCount.toLocaleString()} NET jackpots · ${lotteryWinners.toLocaleString()} unique jackpot winners`} change={{ text: lotteryPayouts24h.length ? `24h +${amount(lotteryPayoutAmount24h, 2)} NET · ${lotteryPayouts24h.length} payout${lotteryPayouts24h.length === 1 ? '' : 's'}` : '24h no lottery payout', tone: lotteryPayouts24h.length ? 'positive' : 'idle' }} />
      <Readout icon={Activity} label="Rewards distributed" value={`${amount(data.totalRewards, 2)} NET`} sub="Reconstructed per rebase" change={change24h(Number(data.totalRewards) / 1e9, baseline24h?.totalRewards)} />
      <Readout icon={RefreshCw} label="Indexed block" value={`#${data.cutoffBlock.toLocaleString()}`} sub={ago(data.indexedAt)} />
    </div>
    <div className="ticker"><div><span>CONTRACT</span> {short(CONFIG.staking)} <b>◆</b> <span>NETWORK</span> ROBINHOOD CHAIN <b>◆</b> <span>UPDATED</span> {when(data.indexedAt)} <b>◆</b> <span>HEAD</span> #{head?.toLocaleString() || '—'}</div></div>
    {tab === 'stakers' ? <Window title="Shareholder Register">
      <div className="toolbar"><label><Search size={14}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search wallet address" /></label><div className="filters"><select value={venue} onChange={(e) => setVenue(e.target.value)}><option value="all">Venue: all</option><option value="direct">Venue: direct staking</option><option value="winnet">Venue: WinNET lottery</option></select><select value={sort} onChange={(e) => setSort(e.target.value)}><option value="balance">Sort: balance</option><option value="usdValue">Sort: USD value</option><option value="lotteryWinnings">Sort: lottery winnings USD</option><option value="lotteryWins">Sort: lottery win count</option><option value="rewards">Sort: rewards</option><option value="added">Sort: additions</option><option value="removed">Sort: removals</option><option value="address">Sort: address</option></select></div></div>
      <div className="tablewrap"><table><thead><tr><th>#</th><th>Staker</th><th>Venue</th><th className="num">Adds</th><th className="num">Removals</th><th className="num">Rewards</th><th className="num">Lottery Wins</th><th className="num">Lottery Winnings USD</th><th className="num">Stake Balance</th><th className="num">Current USD Value</th><th className="num">Actions</th></tr></thead><tbody>{visible.map((r, i) => <tr key={`${r.address}-${r.venue}`}><td>{(page - 1) * pageSize + i + 1}</td><td><Address value={r.address}/><small className="last">{r.lastActive ? `Active ${ago(r.lastActive)}` : 'Stake holder'}</small></td><td><span className={`venue ${r.venue.toLowerCase().replaceAll(' ', '-')}`}>{r.venue}</span></td><td className="num up">+{amount(r.added)}</td><td className="num down">−{amount(r.removed)}</td><td className="num reward">+{amount(r.rewards)}</td><td className="num reward">{r.lotteryWins > 0 ? r.lotteryWins.toLocaleString() : '—'}</td><td className="num reward">{BigInt(r.lotteryWinnings || 0) > 0n ? (fund?.price > 0 ? usd(Number(r.lotteryWinnings) / 1e9 * fund.price) : '—') : '—'}</td><td className="num balance">{amount(r.balance)}</td><td className="num balance">{fund?.price > 0 ? usd(Number(r.balance) / 1e9 * fund.price) : '—'}</td><td className="num muted">{r.stakes} / {r.unstakes}</td></tr>)}</tbody></table>{!visible.length && <div className="empty">No matching staking addresses.</div>}</div>
      <div className="pager"><span>{rows.length.toLocaleString()} records</span><div><button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>Previous</button><b>Page {page} of {pages}</b><button disabled={page === pages} onClick={() => setPage((p) => p + 1)}>Next</button></div></div>
    </Window> : <Window title="Complete Staking Activity">
      <div className="tablewrap"><table><thead><tr><th>Activity</th><th>Wallet / Epoch</th><th className="num">Amount</th><th>Time (UTC)</th><th className="num">Block</th></tr></thead><tbody>{data.activity.map((a) => <tr key={a.id}><td><span className={`event ${a.type.toLowerCase()}`}>{a.type === 'Staked' ? <ArrowDownToLine size={12}/> : a.type === 'Unstaked' ? <ArrowUpFromLine size={12}/> : <RefreshCw size={12}/>} {a.type}</span></td><td>{a.actor ? <Address value={a.actor}/> : `Epoch ${a.epoch}`}</td><td className={`num ${a.type === 'Unstaked' ? 'down' : 'up'}`}>{a.type === 'Unstaked' ? '−' : '+'}{amount(a.amount)} NET</td><td>{when(a.timestamp)}</td><td className="num"><a href={`${CONFIG.explorer}/tx/${a.tx}`} target="_blank" rel="noreferrer">#{a.block.toLocaleString()}</a></td></tr>)}</tbody></table></div>
    </Window>}
    <footer><div><i className="on"/> Public chain data · No wallet connection · Auto-refreshes every 15 seconds</div><div>Rewards follow sNET ownership at each rebase.</div></footer>
  </div></main>;
}

createRoot(document.getElementById('root')).render(<App />);

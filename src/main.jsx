import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, ArrowDownToLine, ArrowUpFromLine, Coins, ExternalLink, RefreshCw, Search, Users } from 'lucide-react';
import { createPublicClient, http } from 'viem';
import { CONFIG, applyLogs, emptyState, fetchLogs, hydrate, latestBlock, viewModel } from './indexer.js';
import './styles.css';

const UNIT = 10n ** 9n;
const WAD = 10n ** 18n;
const treasuryAbi = [{ type: 'function', name: 'rfv', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }, { type: 'function', name: 'liquidUsdg', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }, { type: 'function', name: 'morphoAssets', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }, { type: 'function', name: 'polRfv', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }, { type: 'function', name: 'backingPerToken', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];
const erc20Abi = [{ type: 'function', name: 'totalSupply', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }, { type: 'function', name: 'balanceOf', stateMutability: 'view', inputs: [{ type: 'address' }], outputs: [{ type: 'uint256' }] }];
const stakingAbi = [{ type: 'function', name: 'totalStaked', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];
const oracleAbi = [{ type: 'function', name: 'twapNetUsdg', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];
const sleeveTokens = new Set(['0xd0601ce157db5bdc3162bbac2a2c8af5320d9eec', '0x4a0e65a3eccec6dbe60ae065f2e7bb85fae35eea', '0xaf3d76f1834a1d425780943c99ea8a608f8a93f9', '0xe93237c50d904957cf27e7b1133b510c669c2e74', '0x2e0847e8910a9732eb3fb1bb4b70a580adad4fe3', '0x6330d8c3178a418788df01a47479c0ce7ccf450b']);
const DISCLOSED_SLEEVE_USD = 863_750;
const knownInfra = new Set([CONFIG.net, CONFIG.sNet, CONFIG.staking, CONFIG.treasury, CONFIG.genesisBond, CONFIG.bondDepository, CONFIG.taxCollector, CONFIG.pairOracle, CONFIG.rwaDesk, CONFIG.packDesk, CONFIG.managerSleeve, '0x0000000000000000000000000000000000000000', '0x000000000000000000000000000000000000dead'].map((address) => address.toLowerCase()));
const SLEEVE_CACHE_KEY = 'netnet-rwa-sleeve-v1';
const SLEEVE_CACHE_MAX_AGE = 48 * 60 * 60 * 1000;
let snapshotSleeveFallback = null;
const publicClient = createPublicClient({ transport: http(CONFIG.rpc, { retryCount: 3, timeout: 10_000 }) });
const pause = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
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
  const [tab, setTab] = useState('stakers'), [query, setQuery] = useState(''), [sort, setSort] = useState('balance'), [page, setPage] = useState(1);
  const refresh = async (base, quiet = false) => {
    try {
      if (!quiet) setStatus('Checking the chain…'); setError('');
      const chainHead = await latestBlock(); setHead(chainHead);
      const confirmed = chainHead - 5, stopAt = base.cutoffBlock;
      const [staking, sNet] = await Promise.all([fetchLogs(CONFIG.staking, { stopAt, cutoff: confirmed }), fetchLogs(CONFIG.sNet, { stopAt, cutoff: confirmed })]);
      applyLogs(base, [...staking, ...sNet]); base.cutoffBlock = confirmed; base.indexedAt = new Date().toISOString();
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
        const [values, totalSupply, totalStaked, priceWad, excludedBalances, sleeveResponse] = await Promise.all([
          Promise.all(names.map((functionName) => publicClient.readContract({ address: CONFIG.treasury, abi: treasuryAbi, functionName }))),
          publicClient.readContract({ address: CONFIG.net, abi: erc20Abi, functionName: 'totalSupply' }),
          publicClient.readContract({ address: CONFIG.staking, abi: stakingAbi, functionName: 'totalStaked' }),
          publicClient.readContract({ address: CONFIG.pairOracle, abi: oracleAbi, functionName: 'twapNetUsdg' }).catch(() => 0n),
          Promise.all(excluded.map((address) => publicClient.readContract({ address: CONFIG.net, abi: erc20Abi, functionName: 'balanceOf', args: [address] }))),
          fetchSleeveBalances(),
        ]);
        const treasury = Object.fromEntries(names.map((name, i) => [name, values[i].toString()]));
        const liveSleeveValue = Array.isArray(sleeveResponse) ? sleeveValue(sleeveResponse) : null;
        if (liveSleeveValue != null) rememberSleeveValue(liveSleeveValue);
        const rwaSleeveUsd = liveSleeveValue ?? cachedSleeveValue();
        const supplyNet = Number(totalSupply) / 1e9, stakedNet = Number(totalStaked) / 1e9, price = Number(priceWad) / 1e18;
        const excludedNet = excludedBalances.reduce((sum, value) => sum + Number(value) / 1e9, 0);
        const circulatingNet = Math.max(0, supplyNet - excludedNet);
        const onchainRfv = Number(values[0]) / 1e18;
        if (alive) setFund({ treasury, rwaSleeveUsd, rwaSleeveCached: liveSleeveValue == null && rwaSleeveUsd != null, trueRfvUsd: rwaSleeveUsd == null ? null : onchainRfv + rwaSleeveUsd, supplyNet, stakedNet, stakedPct: supplyNet > 0 ? stakedNet / supplyNet * 100 : 0, circulatingNet, price, circulatingMarketCap: price > 0 ? circulatingNet * price : null, fdv: price > 0 ? supplyNet * price : null });
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
  const excludedAddresses = useMemo(() => new Set([...knownInfra, ...(latestMetrics?.excludedHolderAddresses || []).map((address) => address.toLowerCase())]), [latestMetrics]);
  const change24h = (current, previous, formatter = (n) => Math.round(Math.abs(n)).toLocaleString()) => {
    if (current == null) return null;
    if (previous == null) return { text: '24h baseline building', tone: 'idle' };
    const difference = current - previous, pct = previous !== 0 ? difference / Math.abs(previous) * 100 : null;
    return { text: `24h ${difference >= 0 ? '+' : '−'}${formatter(difference)}${pct == null ? '' : ` (${difference >= 0 ? '+' : '−'}${Math.abs(pct).toFixed(1)}%)`}`, tone: difference > 0 ? 'positive' : difference < 0 ? 'negative' : 'idle' };
  };
  const rows = useMemo(() => {
    if (!data) return []; const q = query.toLowerCase().trim();
    return data.stakers.filter((r) => !excludedAddresses.has(r.address.toLowerCase()) && (!q || r.address.toLowerCase().includes(q))).sort((a, b) => {
      if (sort === 'address') return a.address.localeCompare(b.address);
      const sortField = sort === 'usdValue' ? 'balance' : sort;
      const av = BigInt(a[sortField] || 0), bv = BigInt(b[sortField] || 0); return av === bv ? 0 : av > bv ? -1 : 1;
    });
  }, [data, query, sort, excludedAddresses]);
  const pageSize = 25, pages = Math.max(1, Math.ceil(rows.length / pageSize)), visible = rows.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => setPage(1), [query, sort]);
  if (!data) return <main className="desktop"><div className="boot">NET STAKING LEDGER<br/><span>Reconstructing shareholder records…</span></div></main>;
  const lag = head == null ? null : Math.max(0, head - data.cutoffBlock);
  const netFlow24h = BigInt(data.adds24h) - BigInt(data.removals24h);
  const activeStakers = data.stakers.filter((r) => BigInt(r.balance) > 0n && !excludedAddresses.has(r.address.toLowerCase())).length;
  const walletHolderCount = latestMetrics?.walletHolderCount || null;
  const walletStakerCount = latestMetrics?.walletStakerCount || activeStakers;
  const addressStakingPct = walletHolderCount > 0 ? walletStakerCount / walletHolderCount * 100 : null;
  return <main className="desktop"><div className="frame">
    <Window title="NET Staking Ledger — Robinhood Chain" className="masthead">
      <div className="menu"><button className={tab === 'stakers' ? 'active' : ''} onClick={() => setTab('stakers')}><u>S</u>takers</button><button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}><u>A</u>ctivity</button><a href={`${CONFIG.explorer}/address/${CONFIG.staking}?tab=read_write_contract`} target="_blank" rel="noreferrer">Verified Contract</a></div>
      <div className="brand"><div className="crt">NET</div><div><p>NETNET CAPITAL</p><h1>Shareholder Staking Ledger</h1><span>Independent, read-only onchain records</span></div><div className="livebox"><i className={status === 'Live' ? 'on' : ''}/><b>{status}</b><small>{lag == null ? 'Connecting' : `${lag.toLocaleString()} blocks behind head`}</small></div></div>
      {error && <div className="notice">{error}</div>}
    </Window>
    <div className="stats">
      <Readout icon={Coins} label="Total staked" value={`${amount(data.totalStaked, 2)} sNET`} sub="Current holder balances" change={change24h(Number(data.totalStaked) / 1e9, baseline24h?.totalStaked)} />
      <Readout icon={ArrowDownToLine} label="24-hour adds" value={`+${amount(data.adds24h, 2)} NET`} sub="Rolling staking deposits" />
      <Readout icon={ArrowUpFromLine} label="24-hour removals" value={`−${amount(data.removals24h, 2)} NET`} sub="Rolling staking withdrawals" />
      <Readout icon={netFlow24h >= 0n ? ArrowDownToLine : ArrowUpFromLine} label="24-hour net flow" value={`${netFlow24h >= 0n ? '+' : '−'}${amount(netFlow24h >= 0n ? netFlow24h : -netFlow24h, 2)} NET`} sub="Adds minus removals" change={{ text: netFlow24h > 0n ? 'Net staking growth' : netFlow24h < 0n ? 'Net staking outflow' : 'No net change', tone: netFlow24h > 0n ? 'positive' : netFlow24h < 0n ? 'negative' : 'idle' }} />
      <Readout icon={Coins} label="True RFV (memo)" value={fund ? usd(fund.trueRfvUsd) : 'Loading…'} sub={fund ? `${wadAmount(fund.treasury.rfv)} on-chain + ${usd(fund.rwaSleeveUsd)} RWA sleeve${fund.rwaSleeveCached ? ' · last known mark' : ''} · team-custodied` : 'RFV + team-custodied Sleeve'} change={change24h(fund?.trueRfvUsd, baseline24h?.trueRfvUsd, (n) => `$${Math.round(Math.abs(n)).toLocaleString()}`)} />
      <Readout icon={Activity} label="Circulating market cap" value={fund ? usd(fund.circulatingMarketCap) : 'Loading…'} sub={fund && fund.price > 0 ? `${Math.round(fund.circulatingNet).toLocaleString()} NET × ${fund.price.toFixed(3)} USDG` : 'Floating supply × TWAP'} change={change24h(fund?.circulatingMarketCap, baseline24h?.circulatingMarketCap, (n) => `$${Math.round(Math.abs(n)).toLocaleString()}`)} />
      <Readout icon={Coins} label="Fully diluted market cap" value={fund ? usd(fund.fdv) : 'Loading…'} sub="Total supply × TWAP" change={change24h(fund?.fdv, baseline24h?.fdv, (n) => `$${Math.round(Math.abs(n)).toLocaleString()}`)} />
      <Readout icon={Activity} label="Market price" value={fund?.price > 0 ? `${fund.price.toFixed(4)} USDG` : 'Loading…'} sub="One-hour NET/USDG TWAP" change={change24h(fund?.price > 0 ? fund.price : null, baseline24h?.price, (n) => Math.abs(n).toFixed(4))} />
      <Readout icon={Users} label="Supply" value={fund ? `${Math.round(fund.supplyNet).toLocaleString()} NET` : 'Loading…'} sub={fund ? `${fund.stakedPct.toFixed(1)}% staked · ${Math.round(fund.stakedNet).toLocaleString()} NET` : 'Live on-chain supply'} change={change24h(fund?.supplyNet, baseline24h?.supplyNet)} />
      <Readout icon={Users} label="Staking addresses" value={walletStakerCount.toLocaleString()} sub={walletHolderCount ? `${walletHolderCount.toLocaleString()} unique NET/sNET wallets · ${addressStakingPct.toFixed(1)}% staking · contracts/LP/infra excluded` : `${data.stakers.length.toLocaleString()} lifetime participants · wallet filter indexing`} change={change24h(walletStakerCount, baseline24h?.activeStakers)} />
      <Readout icon={Activity} label="Rewards distributed" value={`${amount(data.totalRewards, 2)} NET`} sub="Reconstructed per rebase" change={change24h(Number(data.totalRewards) / 1e9, baseline24h?.totalRewards)} />
      <Readout icon={RefreshCw} label="Indexed block" value={`#${data.cutoffBlock.toLocaleString()}`} sub={ago(data.indexedAt)} />
    </div>
    <div className="ticker"><div><span>CONTRACT</span> {short(CONFIG.staking)} <b>◆</b> <span>NETWORK</span> ROBINHOOD CHAIN <b>◆</b> <span>UPDATED</span> {when(data.indexedAt)} <b>◆</b> <span>HEAD</span> #{head?.toLocaleString() || '—'}</div></div>
    {tab === 'stakers' ? <Window title="Shareholder Register">
      <div className="toolbar"><label><Search size={14}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search wallet address" /></label><select value={sort} onChange={(e) => setSort(e.target.value)}><option value="balance">Sort: balance</option><option value="usdValue">Sort: USD value</option><option value="rewards">Sort: rewards</option><option value="added">Sort: additions</option><option value="removed">Sort: removals</option><option value="address">Sort: address</option></select></div>
      <div className="tablewrap"><table><thead><tr><th>#</th><th>Staker</th><th className="num">Adds</th><th className="num">Removals</th><th className="num">Rewards</th><th className="num">sNET Balance</th><th className="num">Current USD Value</th><th className="num">Actions</th></tr></thead><tbody>{visible.map((r, i) => <tr key={r.address}><td>{(page - 1) * pageSize + i + 1}</td><td><Address value={r.address}/><small className="last">{r.lastActive ? `Active ${ago(r.lastActive)}` : 'sNET holder'}</small></td><td className="num up">+{amount(r.added)}</td><td className="num down">−{amount(r.removed)}</td><td className="num reward">+{amount(r.rewards)}</td><td className="num balance">{amount(r.balance)}</td><td className="num balance">{fund?.price > 0 ? usd(Number(r.balance) / 1e9 * fund.price) : '—'}</td><td className="num muted">{r.stakes} / {r.unstakes}</td></tr>)}</tbody></table>{!visible.length && <div className="empty">No matching staking addresses.</div>}</div>
      <div className="pager"><span>{rows.length.toLocaleString()} records</span><div><button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>Previous</button><b>Page {page} of {pages}</b><button disabled={page === pages} onClick={() => setPage((p) => p + 1)}>Next</button></div></div>
    </Window> : <Window title="Complete Staking Activity">
      <div className="tablewrap"><table><thead><tr><th>Activity</th><th>Wallet / Epoch</th><th className="num">Amount</th><th>Time (UTC)</th><th className="num">Block</th></tr></thead><tbody>{data.activity.map((a) => <tr key={a.id}><td><span className={`event ${a.type.toLowerCase()}`}>{a.type === 'Staked' ? <ArrowDownToLine size={12}/> : a.type === 'Unstaked' ? <ArrowUpFromLine size={12}/> : <RefreshCw size={12}/>} {a.type}</span></td><td>{a.actor ? <Address value={a.actor}/> : `Epoch ${a.epoch}`}</td><td className={`num ${a.type === 'Unstaked' ? 'down' : 'up'}`}>{a.type === 'Unstaked' ? '−' : '+'}{amount(a.amount)} NET</td><td>{when(a.timestamp)}</td><td className="num"><a href={`${CONFIG.explorer}/tx/${a.tx}`} target="_blank" rel="noreferrer">#{a.block.toLocaleString()}</a></td></tr>)}</tbody></table></div>
    </Window>}
    <footer><div><i className="on"/> Public chain data · No wallet connection · Auto-refreshes every 15 seconds</div><div>Rewards follow sNET ownership at each rebase.</div></footer>
  </div></main>;
}

createRoot(document.getElementById('root')).render(<App />);

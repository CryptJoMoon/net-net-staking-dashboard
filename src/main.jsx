import React, { useEffect, useMemo, useState } from 'react';
import { createRoot } from 'react-dom/client';
import { Activity, ArrowDownToLine, ArrowUpFromLine, Coins, ExternalLink, RefreshCw, Search, Users } from 'lucide-react';
import { createPublicClient, http } from 'viem';
import { CONFIG, applyLogs, emptyState, fetchLogs, hydrate, latestBlock, viewModel } from './indexer.js';
import './styles.css';

const UNIT = 10n ** 9n;
const WAD = 10n ** 18n;
const treasuryAbi = [{ type: 'function', name: 'rfv', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }, { type: 'function', name: 'liquidUsdg', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }, { type: 'function', name: 'morphoAssets', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }, { type: 'function', name: 'polRfv', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }, { type: 'function', name: 'backingPerToken', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];
const publicClient = createPublicClient({ transport: http(CONFIG.rpc, { retryCount: 3, timeout: 10_000 }) });
function amount(raw, max = 4) {
  const value = BigInt(raw || 0), whole = value / UNIT, fraction = (value % UNIT).toString().padStart(9, '0').slice(0, max).replace(/0+$/, '');
  return `${Number(whole).toLocaleString()}${fraction ? `.${fraction}` : ''}`;
}
function wadAmount(raw, max = 2) {
  if (raw == null) return '—'; const value = BigInt(raw), whole = value / WAD, fraction = (value % WAD).toString().padStart(18, '0').slice(0, max).replace(/0+$/, '');
  return `${Number(whole).toLocaleString()}${fraction ? `.${fraction}` : ''}`;
}
const short = (a) => a ? `${a.slice(0, 6)}…${a.slice(-4)}` : 'Protocol';
const when = (date) => date ? new Intl.DateTimeFormat(undefined, { dateStyle: 'medium', timeStyle: 'medium', timeZone: 'UTC' }).format(new Date(date)) + ' UTC' : '—';
const ago = (date) => { if (!date) return '—'; const s = Math.max(0, (Date.now() - new Date(date).getTime()) / 1000); return s < 60 ? `${Math.floor(s)}s ago` : s < 3600 ? `${Math.floor(s / 60)}m ago` : `${Math.floor(s / 3600)}h ago`; };

function Window({ title, children, className = '' }) {
  return <section className={`window ${className}`}><div className="titlebar"><span>{title}</span><span className="glyphs"><i>_</i><i>□</i></span></div>{children}</section>;
}
function Readout({ label, value, sub, icon: Icon }) {
  return <div className="readout">{Icon && <Icon size={15} />}<div><label>{label}</label><strong>{value}</strong>{sub && <small>{sub}</small>}</div></div>;
}
function Address({ value }) { return <a className="address" href={`${CONFIG.explorer}/address/${value}`} target="_blank" rel="noreferrer" title={value}>{short(value)} <ExternalLink size={10} /></a>; }

function App() {
  const [state, setState] = useState(null), [head, setHead] = useState(null), [status, setStatus] = useState('Loading historical ledger…'), [error, setError] = useState('');
  const [treasury, setTreasury] = useState(null);
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
      if (!alive) return; const base = hydrate(snapshot); setState({ ...base }); await refresh(base);
      timer = setInterval(() => refresh(base, true), 15000);
    })();
    return () => { alive = false; clearInterval(timer); };
  }, []);
  useEffect(() => {
    let alive = true;
    const loadTreasury = async () => {
      try {
        const names = ['rfv', 'liquidUsdg', 'morphoAssets', 'polRfv', 'backingPerToken'];
        const values = await Promise.all(names.map((functionName) => publicClient.readContract({ address: CONFIG.treasury, abi: treasuryAbi, functionName })));
        if (alive) setTreasury(Object.fromEntries(names.map((name, i) => [name, values[i].toString()])));
      } catch { if (alive) setTreasury(null); }
    };
    loadTreasury(); const timer = setInterval(loadTreasury, 60_000);
    return () => { alive = false; clearInterval(timer); };
  }, []);
  const data = useMemo(() => state ? viewModel(state) : null, [state]);
  const rows = useMemo(() => {
    if (!data) return []; const q = query.toLowerCase().trim();
    return data.stakers.filter((r) => !q || r.address.toLowerCase().includes(q)).sort((a, b) => {
      if (sort === 'address') return a.address.localeCompare(b.address);
      const av = BigInt(a[sort] || 0), bv = BigInt(b[sort] || 0); return av === bv ? 0 : av > bv ? -1 : 1;
    });
  }, [data, query, sort]);
  const pageSize = 25, pages = Math.max(1, Math.ceil(rows.length / pageSize)), visible = rows.slice((page - 1) * pageSize, page * pageSize);
  useEffect(() => setPage(1), [query, sort]);
  if (!data) return <main className="desktop"><div className="boot">NET STAKING LEDGER<br/><span>Reconstructing shareholder records…</span></div></main>;
  const lag = head == null ? null : Math.max(0, head - data.cutoffBlock);
  return <main className="desktop"><div className="frame">
    <Window title="NET Staking Ledger — Robinhood Chain" className="masthead">
      <div className="menu"><button className={tab === 'stakers' ? 'active' : ''} onClick={() => setTab('stakers')}><u>S</u>takers</button><button className={tab === 'activity' ? 'active' : ''} onClick={() => setTab('activity')}><u>A</u>ctivity</button><a href={`${CONFIG.explorer}/address/${CONFIG.staking}?tab=read_write_contract`} target="_blank" rel="noreferrer">Verified Contract</a></div>
      <div className="brand"><div className="crt">NET</div><div><p>NETNET CAPITAL</p><h1>Shareholder Staking Ledger</h1><span>Independent, read-only onchain records</span></div><div className="livebox"><i className={status === 'Live' ? 'on' : ''}/><b>{status}</b><small>{lag == null ? 'Connecting' : `${lag.toLocaleString()} blocks behind head`}</small></div></div>
      {error && <div className="notice">{error}</div>}
    </Window>
    <div className="stats">
      <Readout icon={Coins} label="Total staked" value={`${amount(data.totalStaked, 2)} sNET`} sub="Current holder balances" />
      <Readout icon={ArrowDownToLine} label="24-hour adds" value={`+${amount(data.adds24h, 2)} NET`} sub="Rolling staking deposits" />
      <Readout icon={ArrowUpFromLine} label="24-hour removals" value={`−${amount(data.removals24h, 2)} NET`} sub="Rolling staking withdrawals" />
      <Readout icon={Coins} label="Treasury RFV" value={treasury ? `${wadAmount(treasury.rfv)} USDG` : 'Loading…'} sub={treasury ? `${wadAmount(treasury.liquidUsdg)} liquid · ${wadAmount(treasury.morphoAssets)} Morpho · ${wadAmount(treasury.polRfv)} POL` : 'Liquid + haircut Morpho + POL'} />
      <Readout icon={Users} label="Staking addresses" value={data.stakers.filter((r) => BigInt(r.balance) > 0n).length.toLocaleString()} sub={`${data.stakers.length.toLocaleString()} lifetime participants`} />
      <Readout icon={Activity} label="Rewards distributed" value={`${amount(data.totalRewards, 2)} NET`} sub="Reconstructed per rebase" />
      <Readout icon={RefreshCw} label="Indexed block" value={`#${data.cutoffBlock.toLocaleString()}`} sub={ago(data.indexedAt)} />
    </div>
    <div className="ticker"><div><span>CONTRACT</span> {short(CONFIG.staking)} <b>◆</b> <span>NETWORK</span> ROBINHOOD CHAIN <b>◆</b> <span>UPDATED</span> {when(data.indexedAt)} <b>◆</b> <span>HEAD</span> #{head?.toLocaleString() || '—'}</div></div>
    {tab === 'stakers' ? <Window title="Shareholder Register">
      <div className="toolbar"><label><Search size={14}/><input value={query} onChange={(e) => setQuery(e.target.value)} placeholder="Search wallet address" /></label><select value={sort} onChange={(e) => setSort(e.target.value)}><option value="balance">Sort: balance</option><option value="rewards">Sort: rewards</option><option value="added">Sort: additions</option><option value="removed">Sort: removals</option><option value="address">Sort: address</option></select></div>
      <div className="tablewrap"><table><thead><tr><th>#</th><th>Staker</th><th className="num">Adds</th><th className="num">Removals</th><th className="num">Rewards</th><th className="num">sNET Balance</th><th className="num">Actions</th></tr></thead><tbody>{visible.map((r, i) => <tr key={r.address}><td>{(page - 1) * pageSize + i + 1}</td><td><Address value={r.address}/><small className="last">{r.lastActive ? `Active ${ago(r.lastActive)}` : 'sNET holder'}</small></td><td className="num up">+{amount(r.added)}</td><td className="num down">−{amount(r.removed)}</td><td className="num reward">+{amount(r.rewards)}</td><td className="num balance">{amount(r.balance)}</td><td className="num muted">{r.stakes} / {r.unstakes}</td></tr>)}</tbody></table>{!visible.length && <div className="empty">No matching staking addresses.</div>}</div>
      <div className="pager"><span>{rows.length.toLocaleString()} records</span><div><button disabled={page === 1} onClick={() => setPage((p) => p - 1)}>Previous</button><b>Page {page} of {pages}</b><button disabled={page === pages} onClick={() => setPage((p) => p + 1)}>Next</button></div></div>
    </Window> : <Window title="Complete Staking Activity">
      <div className="tablewrap"><table><thead><tr><th>Activity</th><th>Wallet / Epoch</th><th className="num">Amount</th><th>Time (UTC)</th><th className="num">Block</th></tr></thead><tbody>{data.activity.map((a) => <tr key={a.id}><td><span className={`event ${a.type.toLowerCase()}`}>{a.type === 'Staked' ? <ArrowDownToLine size={12}/> : a.type === 'Unstaked' ? <ArrowUpFromLine size={12}/> : <RefreshCw size={12}/>} {a.type}</span></td><td>{a.actor ? <Address value={a.actor}/> : `Epoch ${a.epoch}`}</td><td className={`num ${a.type === 'Unstaked' ? 'down' : 'up'}`}>{a.type === 'Unstaked' ? '−' : '+'}{amount(a.amount)} NET</td><td>{when(a.timestamp)}</td><td className="num"><a href={`${CONFIG.explorer}/tx/${a.tx}`} target="_blank" rel="noreferrer">#{a.block.toLocaleString()}</a></td></tr>)}</tbody></table></div>
    </Window>}
    <footer><div><i className="on"/> Public chain data · No wallet connection · Auto-refreshes every 15 seconds</div><div>Rewards follow sNET ownership at each rebase.</div></footer>
  </div></main>;
}

createRoot(document.getElementById('root')).render(<App />);

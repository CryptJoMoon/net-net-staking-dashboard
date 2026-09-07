import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { createPublicClient, http } from 'viem';
import { CONFIG, hydrate, viewModel } from '../src/indexer.js';

const UNIT = 1e9;
const WAD = 1e18;
const requestedDays = Math.max(1, Number(process.env.DAYS || 30));
const fallbackEpochRate = Math.max(0, Number(process.env.EPOCH_RATE || 0.0045));
const outDir = process.env.OUT_DIR || 'yield-extraction-report';
const snapshot = JSON.parse(await readFile('public/snapshot.json', 'utf8'));
const state = hydrate(snapshot);
const vm = viewModel(state);
const client = createPublicClient({ transport: http(CONFIG.rpc, { retryCount: 2, timeout: 10_000 }) });
const stakingAbi = [
  { type: 'function', name: 'distributor', stateMutability: 'view', inputs: [], outputs: [{ type: 'address' }] },
];
const distributorAbi = [{ type: 'function', name: 'currentRateWad', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];
const oracleAbi = [{ type: 'function', name: 'twapNetUsdg', stateMutability: 'view', inputs: [], outputs: [{ type: 'uint256' }] }];

async function liveInputs() {
  let epochRate = fallbackEpochRate;
  let rateSource = 'fallback';
  let price = [...(snapshot.metricsHistory || [])].reverse().find((point) => Number(point.price) > 0)?.price || 0;
  let priceSource = price > 0 ? 'latest snapshot metric' : 'unavailable';
  try {
    const distributor = await client.readContract({ address: CONFIG.staking, abi: stakingAbi, functionName: 'distributor' });
    const rateWad = await client.readContract({ address: distributor, abi: distributorAbi, functionName: 'currentRateWad' });
    const candidate = Number(rateWad) / WAD;
    if (Number.isFinite(candidate) && candidate >= 0) {
      epochRate = candidate;
      rateSource = 'live Distributor.currentRateWad';
    }
  } catch {}
  try {
    const priceWad = await client.readContract({ address: CONFIG.pairOracle, abi: oracleAbi, functionName: 'twapNetUsdg' });
    const candidate = Number(priceWad) / WAD;
    if (Number.isFinite(candidate) && candidate > 0) {
      price = candidate;
      priceSource = 'live one-hour TWAP';
    }
  } catch {}
  return { epochRate, rateSource, dailyRate: (1 + epochRate) ** 3 - 1, price, priceSource };
}

const inputs = await liveInputs();
const datedActivity = (state.activity || [])
  .filter((event) => event.timestamp && Number.isFinite(new Date(event.timestamp).getTime()))
  .sort((a, b) => new Date(a.timestamp) - new Date(b.timestamp));
if (!datedActivity.length) throw new Error('The snapshot contains no timestamped staking activity.');

const generatedAt = new Date();
const requestedStart = new Date(generatedAt.getTime() - requestedDays * 86_400_000);
const retainedStart = new Date(datedActivity[0].timestamp);
const start = retainedStart > requestedStart ? retainedStart : requestedStart;
const end = generatedAt;
const coverageDays = Math.max((end - start) / 86_400_000, 1 / 24);
const coverageLimited = retainedStart > requestedStart;
const activity = datedActivity.filter((event) => new Date(event.timestamp) >= start && new Date(event.timestamp) <= end);
const rebases = activity.filter((event) => event.type === 'Rebased').map((event) => new Date(event.timestamp).getTime());
const stakers = new Map(vm.stakers.map((row) => [row.address.toLowerCase(), row]));
const verifiedHolderPoint = [...(snapshot.metricsHistory || [])].reverse().find((point) => Array.isArray(point.excludedHolderAddresses));
const excludedAddresses = new Set((verifiedHolderPoint?.excludedHolderAddresses || []).map((address) => address.toLowerCase()));
const byWallet = new Map();

for (const event of activity) {
  if (!event.actor || !['Staked', 'Unstaked'].includes(event.type)) continue;
  const address = event.actor.toLowerCase();
  if (excludedAddresses.has(address)) continue;
  if (!byWallet.has(address)) byWallet.set(address, { address: event.actor, adds: [], removals: [] });
  byWallet.get(address)[event.type === 'Staked' ? 'adds' : 'removals'].push(event);
}

const numberAmount = (raw) => Number(BigInt(raw || 0)) / UNIT;
const median = (values) => {
  if (!values.length) return null;
  const sorted = [...values].sort((a, b) => a - b);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
};
const nearestPriorRebaseMinutes = (timestamp) => {
  const time = new Date(timestamp).getTime();
  let prior = null;
  for (const rebase of rebases) {
    if (rebase > time) break;
    prior = rebase;
  }
  return prior == null ? null : (time - prior) / 60_000;
};

const rows = [];
for (const entry of byWallet.values()) {
  if (!entry.removals.length) continue;
  const staker = stakers.get(entry.address.toLowerCase());
  const currentStake = numberAmount(staker?.balance || 0);
  const removed = entry.removals.map((event) => numberAmount(event.amount));
  const totalRemoved = removed.reduce((sum, value) => sum + value, 0);
  const totalAdded = entry.adds.reduce((sum, event) => sum + numberAmount(event.amount), 0);
  const times = entry.removals.map((event) => new Date(event.timestamp).getTime()).sort((a, b) => a - b);
  const intervals = times.slice(1).map((time, index) => (time - times[index]) / 3_600_000);
  const rebaseLags = entry.removals.map((event) => nearestPriorRebaseMinutes(event.timestamp)).filter((value) => value != null && value >= 0);
  const alignedCount = rebaseLags.filter((minutes) => minutes <= 90).length;
  const epochAlignedPct = entry.removals.length ? alignedCount / entry.removals.length : 0;
  const averageDailyRemoved = totalRemoved / coverageDays;
  const estimatedDailyYield = currentStake * inputs.dailyRate;
  const yieldExtractionRatio = estimatedDailyYield > 0 ? averageDailyRemoved / estimatedDailyYield : null;
  const medianIntervalHours = median(intervals);
  const principalChanged = totalAdded - totalRemoved;
  const recipients = [...new Set(entry.removals.map((event) => event.recipient?.toLowerCase()).filter(Boolean))];

  let classification = 'Irregular removal';
  if (currentStake <= 0.000000001) classification = 'Full exit / no current direct stake';
  else if (yieldExtractionRatio != null && yieldExtractionRatio > 1.8) classification = 'Likely reducing principal';
  else if (entry.removals.length >= 3 && medianIntervalHours != null && medianIntervalHours <= 12 && epochAlignedPct >= 0.5 && yieldExtractionRatio >= 0.35 && yieldExtractionRatio <= 1.8) classification = 'Likely per-epoch yield harvesting';
  else if (entry.removals.length >= 3 && medianIntervalHours != null && medianIntervalHours <= 36 && yieldExtractionRatio >= 0.35 && yieldExtractionRatio <= 1.8) classification = 'Likely daily yield harvesting';
  else if (entry.removals.length >= 2 && yieldExtractionRatio >= 0.35 && yieldExtractionRatio <= 1.8) classification = 'Possible yield harvesting';

  rows.push({
    address: entry.address,
    classification,
    removalCount: entry.removals.length,
    totalRemoved,
    removedUsd: totalRemoved * inputs.price,
    averageDailyRemoved,
    averageDailyRemovedUsd: averageDailyRemoved * inputs.price,
    medianRemoval: median(removed),
    medianIntervalHours,
    epochAlignedPct,
    currentStake,
    currentStakeUsd: currentStake * inputs.price,
    estimatedDailyYield,
    estimatedDailyYieldUsd: estimatedDailyYield * inputs.price,
    yieldExtractionRatio,
    totalAdded,
    principalChanged,
    recipients: recipients.join(' | '),
    latestRemoval: new Date(Math.max(...times)).toISOString(),
  });
}

rows.sort((a, b) => b.averageDailyRemoved - a.averageDailyRemoved);
const harvesting = rows.filter((row) => /harvesting/.test(row.classification));
const whales = rows.filter((row) => row.currentStake >= 100 || row.totalRemoved >= 100);
const possibleDailyPressure = harvesting.reduce((sum, row) => sum + row.averageDailyRemoved, 0);
const fmt = (value, digits = 2) => Number(value || 0).toLocaleString('en-US', { maximumFractionDigits: digits });
const pct = (value) => value == null ? '—' : `${fmt(value * 100, 1)}%`;
const usd = (value) => inputs.price > 0 ? `$${fmt(value, 0)}` : '—';
const escapeCsv = (value) => {
  const text = String(value ?? '');
  return /[",\n]/.test(text) ? `"${text.replaceAll('"', '""')}"` : text;
};
const columns = [
  ['address', 'Wallet'], ['classification', 'Classification'], ['removalCount', 'Removal count'],
  ['totalRemoved', 'NET removed'], ['removedUsd', 'Removed USD at current TWAP'],
  ['averageDailyRemoved', 'Average NET removed/day'], ['averageDailyRemovedUsd', 'Average USD removed/day'],
  ['medianRemoval', 'Median removal NET'], ['medianIntervalHours', 'Median interval hours'],
  ['epochAlignedPct', 'Within 90m after epoch %'], ['currentStake', 'Current direct stake NET'],
  ['currentStakeUsd', 'Current direct stake USD'], ['estimatedDailyYield', 'Estimated current yield NET/day'],
  ['estimatedDailyYieldUsd', 'Estimated current yield USD/day'], ['yieldExtractionRatio', 'Removal vs estimated yield ratio'],
  ['totalAdded', 'NET added in coverage'], ['principalChanged', 'Adds minus removals NET'],
  ['latestRemoval', 'Latest removal UTC'], ['recipients', 'Withdrawal recipients'],
];
const csv = [
  columns.map(([, label]) => escapeCsv(label)).join(','),
  ...rows.map((row) => columns.map(([key]) => escapeCsv(row[key] == null ? '' : row[key])).join(',')),
].join('\n') + '\n';

const topRows = rows.slice(0, 30).map((row) =>
  `| ${row.address} | ${row.classification} | ${row.removalCount} | ${fmt(row.totalRemoved, 4)} | ${fmt(row.averageDailyRemoved, 4)} | ${usd(row.averageDailyRemovedUsd)} | ${fmt(row.currentStake, 4)} | ${pct(row.epochAlignedPct)} | ${pct(row.yieldExtractionRatio)} |`
).join('\n');
const coverageNote = coverageLimited
  ? `WARNING: The requested ${requestedDays}-day window is not fully retained. The latest 1,500 activity events cover only ${fmt(coverageDays, 2)} days, beginning ${start.toISOString()}.`
  : `The retained activity covers the complete requested ${requestedDays}-day window.`;

const markdown = `# NET staking yield-extraction analysis

Generated: ${generatedAt.toISOString()}

## Scope and assumptions

- Requested window: ${requestedDays} days
- Effective analyzed coverage: ${fmt(coverageDays, 2)} days
- Activity events analyzed: ${activity.length.toLocaleString()}
- Withdrawal wallets: ${rows.length.toLocaleString()}
- Whale removers (100+ NET current stake or removed): ${whales.length.toLocaleString()}
- Epoch rate: ${fmt(inputs.epochRate * 100, 4)}% (${inputs.rateSource})
- Compounding: 3 epochs/day
- Estimated daily rate: ${fmt(inputs.dailyRate * 100, 4)}%
- NET price: ${inputs.price > 0 ? `$${fmt(inputs.price, 4)}` : 'unavailable'} (${inputs.priceSource})

> ${coverageNote}

## Findings

- Likely/possible recurring yield harvesters: **${harvesting.length.toLocaleString()} wallets**
- Their combined average removals: **${fmt(possibleDailyPressure, 4)} NET/day**
- Current-TWAP value: **${usd(possibleDailyPressure * inputs.price)}/day**
- These are behavioral estimates, not proof of sales. An unstake can be held, transferred, restaked, or sold.

## Largest average daily removals

| Wallet | Classification | Removals | NET removed | NET/day | USD/day | Current stake | Epoch-aligned | Removal / est. yield |
|---|---:|---:|---:|---:|---:|---:|---:|---:|
${topRows || '| — | No withdrawals in retained coverage | — | — | — | — | — | — | — |'}

## Interpretation

“Epoch-aligned” means the withdrawal occurred within 90 minutes after a recorded rebase. “Removal / estimated yield” compares average daily removals with the wallet’s estimated yield from its **current** stake, so wallets whose stake changed substantially require manual review. This report does not label any wallet as a seller and does not yet trace withdrawn NET into DEX swaps.
`;

const summary = {
  generatedAt: generatedAt.toISOString(),
  requestedDays,
  coverageDays,
  coverageLimited,
  coverageStart: start.toISOString(),
  coverageEnd: end.toISOString(),
  epochRate: inputs.epochRate,
  rateSource: inputs.rateSource,
  dailyRate: inputs.dailyRate,
  price: inputs.price,
  priceSource: inputs.priceSource,
  activityEvents: activity.length,
  excludedProtocolAddresses: excludedAddresses.size,
  withdrawalWallets: rows.length,
  whaleRemovers: whales.length,
  harvestingCandidates: harvesting.length,
  possibleDailyPressureNet: possibleDailyPressure,
  possibleDailyPressureUsd: possibleDailyPressure * inputs.price,
};

await mkdir(outDir, { recursive: true });
await Promise.all([
  writeFile(`${outDir}/report.md`, markdown),
  writeFile(`${outDir}/wallets.csv`, csv),
  writeFile(`${outDir}/summary.json`, JSON.stringify(summary, null, 2) + '\n'),
]);
console.log(markdown);

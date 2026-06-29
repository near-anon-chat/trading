#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const bs58 = require('bs58').default;
const nacl = require('tweetnacl');
const deepseek = require('./lib/deepseek.js');

const PROJECT = __dirname;
const LOG_FILE = path.join(PROJECT, 'agent.log');
const LAST_TRADE = path.join(PROJECT, '.last_trade');
const ENV_FILE = path.join(PROJECT, '.env');
const UA = 'Mozilla/5.0 OpenCode-Agent/1.0';

const ACCOUNT = '0c279aaeb803608f60bf8eac25a52570e4a32551f5feb854f0f0355f028760ed';
const PUBLIC_KEY = 'ed25519:pSvH1pzY1drdsquruJsEL8M4KFRgz8vsxGBdNpHqw6L';
const USDC_NEAR = 'nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1';
const COOLDOWN_MS = 5 * 60 * 1000;
const MIN_TRADE = 0.50;
const GAS_RESERVE = 1.0;
const INITIAL_VALUE = 19.36;
const HISTORY_FILE = path.join(PROJECT, 'portfolio_history.json');
const RAISED_SYMS_FILE = path.join(PROJECT, '.raised_syms.json');
const MAX_POSITIONS = 3;
const MIN_POSITION_VALUE = 2.0;
const HOLD_MIN_MS = 60 * 60 * 1000;
const MAX_SPREAD_PCT = 2.0;

const FLAP_COOLDOWN_MS = 30 * 60 * 1000;   // route-flap penalty duration
const FLAP_FILE = path.join(PROJECT, '.route_flap.json');
const COST_BASIS_FILE = path.join(PROJECT, '.cost_basis.json');
const OHLC_CACHE_FILE = path.join(PROJECT, '.ohlc_cache.json');
const NO_ROUTE_LOG = path.join(PROJECT, 'no_route.log');
const FAIL_COOLDOWN_MS = 60 * 60 * 1000;   // wait 1h before re-checking a failed token
const FAIL_COOLDOWN_FILE = path.join(PROJECT, '.fail_cooldown.json');
const RESEARCH_FILE = path.join(PROJECT, '.research_log.json');
const ROUTE_HEALTH_FILE = path.join(PROJECT, '.route_health.json');
const PEAK_FILE = path.join(PROJECT, '.peak_tracker.json');
const FROZEN_FILE = path.join(PROJECT, '.frozen.json');
const DEPOSITS_FILE = path.join(PROJECT, 'deposits.json');
const DEPOSIT_HISTORY_FILE = path.join(PROJECT, '.deposit_history.json');
const BAL_CACHE_FILE = path.join(PROJECT, '.bal_cache.json');
const RPC_ENDPOINTS = [
  'https://rpc.mainnet.near.org',
  'https://archival-rpc.mainnet.near.org',
];
const JUNK_HOLD_MS = 30 * 60 * 1000;
const JUNK_FILE = path.join(PROJECT, '.junk_timers.json');
const OB_HOLD_MS = 30 * 60 * 1000;
const OB_FILE = path.join(PROJECT, '.ob_timers.json');
const TRADE_HISTORY_FILE = path.join(PROJECT, '.trade_history.json');
const MAX_TRADE_HISTORY = 20;
const REBUY_COOLDOWN_MS = 2 * 60 * 60 * 1000;
const MAX_DAILY_TRADES = 6;
const TOPUP_SCORE_MIN = 5;
const TOPUP_THROTTLE_FILE = path.join(PROJECT, '.topup_throttle.json');
const TOPUP_THROTTLE_MS = 60 * 60 * 1000;

// Tier allocation: 80/20 for 1 position, 60/40 for 2, 60/25/15 for 3+
function tierPct(rank, total) {
  if (total === 1) return rank === 0 ? 0.80 : 0;
  if (total === 2) return rank === 0 ? 0.60 : 0.40;
  return [0.60, 0.25, 0.15][Math.min(rank, 2)];
}

// Load all tradeable tokens from registry (exclude omdep.near — no swap routes)
function loadTradeableTokens() {
  try {
    const raw = JSON.parse(fs.readFileSync(path.join(PROJECT, 'tokens.json'), 'utf8'));
    const list = Array.isArray(raw) ? raw : (raw.tokens || raw.result || []);
    const seen = new Set();
    const pf = [];
    for (const t of list) {
      const aid = t.assetId || '';
      const sym = t.symbol;
      if (!sym || !aid) continue;
      if (aid.includes('omdep.near')) continue;
      if (seen.has(sym)) continue;
      seen.add(sym);
      pf.push({ id: aid, sym, dec: t.decimals ?? 18 });
    }
    if (!pf.find(p => p.id === USDC_NEAR)) pf.push({ id: USDC_NEAR, sym: 'USDC', dec: 6 });
    return pf;
  } catch(e) {
    // Fallback: minimal working set
    return [
      { id: USDC_NEAR, sym: 'USDC', dec: 6 },
      { id: 'nep141:base-0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf.omft.near', sym: 'VVV', dec: 18 },
    ];
  }
}

const PORTFOLIO = loadTradeableTokens();
function buyEntry(sym) {
  const s = sym === 'NEAR' ? 'wNEAR' : sym;
  return PORTFOLIO.find(p => p.sym === s);
}

// Auto-map CG IDs from coinList.json by symbol
let CG_IDS = {};
try {
  const cl = JSON.parse(fs.readFileSync(path.join(PROJECT, 'coinList.json'), 'utf8'));
  for (const sym of PORTFOLIO.map(p => p.sym)) {
    const cgSym = sym === 'wNEAR' ? 'near' : sym.toLowerCase();
    const entry = cl.find(c => c.symbol === cgSym);
    if (entry) CG_IDS[sym] = entry.id;
  }
} catch(e) {}
// wNEAR price = NEAR price
CG_IDS.wNEAR = 'near';
// Override auto-mapped IDs for tokens where coinList.json picks wrong bridged entry
const CG_OVERRIDES = {
  BTC: 'bitcoin', ETH: 'ethereum', SOL: 'solana', XRP: 'ripple',
  DOGE: 'dogecoin', ADA: 'cardano', AVAAX: 'avalanche-2', DOT: 'polkadot',
  LINK: 'chainlink', UNI: 'uniswap', SHIB: 'shiba-inu', PEPE: 'pepe',
  TON: 'the-open-network', TRX: 'tron', BNB: 'binancecoin', OP: 'optimism',
  ARB: 'arbitrum', LTC: 'litecoin', BCH: 'bitcoin-cash', XLM: 'stellar',
  ATOM: 'cosmos', NEAR: 'near', DAI: 'dai', FRAX: 'frax',
  APT: 'aptos', SUI: 'sui', AAVE: 'aave', MKR: 'maker',
  CRV: 'curve-dao-token', COMP: 'compound-governance-token', RUNE: 'thorchain',
  FIL: 'filecoin', ICP: 'internet-computer', ETC: 'ethereum-classic',
  ALGO: 'algorand', ZEC: 'zcash', DASH: 'dash', AKT: 'akash-network',
  FET: 'fetch-ai', AGIX: 'singularitynet', OCEAN: 'ocean-protocol',
  GRT: 'the-graph', SAND: 'the-sandbox', MANA: 'decentraland',
  SNX: 'synthetix-network-token', YFI: 'yearn-finance', SUSHI: 'sushi',
  CAKE: 'pancakeswap-token', KNC: 'kyber-network-crystal', BAL: 'balancer',
  LDO: 'lido-dao', FXS: 'frax-share', CVX: 'convex-finance',
  SPELL: 'spell-token', MINA: 'mina-protocol', FLOW: 'flow',
  FTM: 'fantom', MATIC: 'matic-network', HNT: 'helium',
  ANKR: 'ankr', ENJ: 'enjincoin', BAT: 'basic-attention-token',
  ZIL: 'zilliqa', IOST: 'iostoken', IOTX: 'iotex',
  ONT: 'ontology', VET: 'vechain', THETA: 'theta-token',
  TFUEL: 'theta-fuel', HOT: 'holotoken', CHZ: 'chiliz',
  AUDIO: 'audius', GALA: 'gala', RNDR: 'render-token',
  IMX: 'immutable-x', APE: 'apecoin', BLUR: 'blur', TRUMP: 'official-trump',
  WBTC: 'wrapped-bitcoin', wBTC: 'wrapped-bitcoin', WETH: 'weth',
  POL: 'polygon-ecosystem-token', MOVE: 'movement',
  USDT: 'tether', TURBO: 'turbo', SAFE: 'safe', MOG: 'mog-coin',
  CFI: 'consumerfi-protocol', USDT0: 'usdt0', xBTC: 'xbtc-2', COW: 'cow-protocol',
};
for (const [sym, id] of Object.entries(CG_OVERRIDES)) { CG_IDS[sym] = id; }
// Additional fallbacks for tokens not in coinList.json
const CG_FALLBACKS = { KAITO: 'kaito', VVV: 'venice-token', AURORA: 'aurora-near', GNO: 'gnosis', XAUT: 'tether-gold', MON: 'mon-protocol', 'NearKat': 'nearkat', '$WIF': 'dogwifcoin', 'BTC(OMNI)': 'bitcoin' };
for (const [sym, id] of Object.entries(CG_FALLBACKS)) { if (!CG_IDS[sym]) CG_IDS[sym] = id; }
const ETF_MAP = { SPYon: 'SPY', QQQon: 'QQQ', GLDon: 'GLD', TLTon: 'TLT', AGGon: 'AGG', USDon: 'DX-Y.NYB' };

function log(...a) {
  const m = `[${new Date().toISOString()}] ${a.join(' ')}`;
  console.log(m);
  try { fs.appendFileSync(LOG_FILE, m + '\n'); } catch(e) {}
}

function loadEnv() {
  if (fs.existsSync(ENV_FILE)) {
    for (const l of fs.readFileSync(ENV_FILE, 'utf8').split('\n')) {
      const t = l.trim();
      if (!t || t.startsWith('#')) continue;
      const i = t.indexOf('=');
      if (i > 0) process.env[t.slice(0, i).trim()] = t.slice(i + 1).trim();
    }
  }
  return { jwt: process.env.NEAR_SWAP_JWT_TOKEN, pk: process.env.PRIVATE_KEY };
}

const https = require('https');
const http = require('http');

function _httpGet(url, hdrs = {}) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const m = u.protocol === 'https:' ? https : http;
    m.get(url, { headers: { 'User-Agent': UA, ...hdrs } }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        if (r.statusCode === 429) rej(new Error('RATE_LIMITED'));
        else if (r.statusCode !== 200) rej(new Error(`HTTP${r.statusCode}`));
        else { try { res(JSON.parse(d)); } catch(e) { rej(new Error(d.slice(0, 200))); } }
      });
    }).on('error', rej);
  });
}

async function httpGet(url, hdrs = {}) {
  for (let i = 0; i < 3; i++) {
    try { return await _httpGet(url, hdrs); }
    catch(e) {
      if (i < 2) {
        if (e.message?.includes('RATE_LIMITED')) { await sleep(5000); continue; }
        if (e.message?.includes('EAI_AGAIN') || e.message?.includes('ECONNRESET') || e.message?.includes('ETIMEDOUT')) { await sleep(2000); continue; }
      }
      throw e;
    }
  }
}

function _httpPost(url, data, hdrs = {}) {
  return new Promise((res, rej) => {
    const u = new URL(url);
    const m = u.protocol === 'https:' ? https : http;
    const b = typeof data === 'string' ? data : JSON.stringify(data);
    const req = m.request(url, { method: 'POST', headers: { 'Content-Type': 'application/json', ...hdrs } }, r => {
      let d = '';
      r.on('data', c => d += c);
      r.on('end', () => {
        if (r.statusCode === 429) rej(new Error('RATE_LIMITED'));
        else { try { res({ s: r.statusCode, d: JSON.parse(d) }); } catch(e) { rej(new Error(d.slice(0, 200))); } }
      });
    });
    req.on('error', rej);
    req.write(b);
    req.end();
  });
}

async function httpPost(url, data, hdrs = {}) {
  for (let i = 0; i < 3; i++) {
    try { return await _httpPost(url, data, hdrs); }
    catch(e) {
      if (i < 2) {
        if (e.message?.includes('RATE_LIMITED')) { await sleep(5000); continue; }
        if (e.message?.includes('EAI_AGAIN') || e.message?.includes('ECONNRESET') || e.message?.includes('ETIMEDOUT')) { await sleep(2000); continue; }
      }
      throw e;
    }
  }
}

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchFG() {
  try {
    const f = await httpGet('https://api.alternative.me/fng/');
    return { v: parseInt(f?.data?.[0]?.value || 50), t: f?.data?.[0]?.value_classification || '?' };
  } catch(e) { return { v: 50, t: '?' }; }
}

const CG_CACHE_TTL = 60 * 1000;
const CG_CACHE_FILE = path.join(PROJECT, '.cg_cache.json');
let cgCache = { data: null, ts: 0 };

async function fetchCGData(ids) {
  const now = Date.now();
  if (cgCache.data && now - cgCache.ts < CG_CACHE_TTL) {
    return cgCache.data;
  }
  // Preload file cache as cold-start backup
  if (!cgCache.data) {
    try {
      const fc = JSON.parse(fs.readFileSync(CG_CACHE_FILE, 'utf8'));
      if (fc.data) cgCache = { data: fc.data, ts: fc.ts };
    } catch(e) {}
  }
  if (!ids.length) return {};
  // Always try live API first; file cache is fallback only
  try {
    const r = await httpGet(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true`);
    log('CG prices:', Object.keys(r).join(','));
    cgCache = { data: r, ts: now };
    try { fs.writeFileSync(CG_CACHE_FILE, JSON.stringify({ data: r, ts: now })); } catch(e) {}
    return r;
  } catch(e) {
    log('CG price err:', e.message);
    if (cgCache.data && now - cgCache.ts < CG_CACHE_TTL * 30) {
      log('  Using cached CG prices (' + Math.round((now - cgCache.ts) / 1000) + 's stale)');
      return cgCache.data;
    }
    return {};
  }
}

async function fetch1ClickPrices() {
  try {
    const data = await httpGet('https://1click.chaindefuser.com/v0/tokens', { 'Authorization': `Bearer ${process.env.NEAR_SWAP_JWT_TOKEN}` });
    if (!Array.isArray(data)) { log('1Click: unexpected response'); return {}; }
    const prices = {};
    for (const t of data) { if (t.symbol && t.price != null) prices[t.symbol] = t; }
    log(`1Click: ${Object.keys(prices).length} token prices`);
    return prices;
  } catch(e) {
    log('1Click price err:', e.message);
    return {};
  }
}

async function fetchOHLC(id) {
  const cacheKey = `${id}_${new Date().toISOString().slice(0, 10)}`;
  try {
    const cache = JSON.parse(fs.readFileSync(OHLC_CACHE_FILE, 'utf8'));
    if (cache[cacheKey]) return { closes: cache[cacheKey], fromCache: true };
  } catch(e) {}
  try {
    const d = await httpGet(`https://api.coingecko.com/api/v3/coins/${id}/ohlc?days=14&vs_currency=usd`);
    const closes = Array.isArray(d) ? d.map(c => c[4]).filter(p => p > 0) : null;
    if (closes) {
      try {
        let cache = {};
        try { cache = JSON.parse(fs.readFileSync(OHLC_CACHE_FILE, 'utf8')); } catch(e) {}
        cache[cacheKey] = closes;
        fs.writeFileSync(OHLC_CACHE_FILE, JSON.stringify(cache));
      } catch(e) {}
    }
    return { closes, fromCache: false };
  } catch(e) { return { closes: null, fromCache: false }; }
}

async function fetchIntraday(id) {
  const cacheKey = `intra_${id}_${new Date().toISOString().slice(0, 10)}`;
  const FRESH_MS = 20 * 60 * 1000;
  let staleEntry = null;
  try {
    const cache = JSON.parse(fs.readFileSync(OHLC_CACHE_FILE, 'utf8'));
    const c = cache[cacheKey];
    if (c) {
      if (Array.isArray(c)) return { prices: c, volumes: null, fromCache: true };
      if (c.ts && Date.now() - c.ts < FRESH_MS) {
        if (c.v !== undefined) return { prices: c.p || null, volumes: c.v || null, fromCache: true };
      }
      staleEntry = c;
    }
  } catch(e) {}
  try {
    const d = await httpGet(`https://api.coingecko.com/api/v3/coins/${id}/market_chart?vs_currency=usd&days=1`);
    const prices = Array.isArray(d?.prices) ? d.prices.map(p => p[1]).filter(p => p > 0) : null;
    const volumes = Array.isArray(d?.total_volumes) ? d.total_volumes.map(p => p[1]).filter(v => v > 0) : null;
    if (prices && prices.length >= 36) {
      try {
        let cache = {};
        try { cache = JSON.parse(fs.readFileSync(OHLC_CACHE_FILE, 'utf8')); } catch(e) {}
        cache[cacheKey] = { p: prices, v: volumes, ts: Date.now() };
        fs.writeFileSync(OHLC_CACHE_FILE, JSON.stringify(cache));
      } catch(e) {}
    }
    return { prices, volumes, fromCache: false };
  } catch(e) {
    if (staleEntry) return { prices: staleEntry.p || null, volumes: staleEntry.v || null, fromCache: true };
    return { prices: null, volumes: null, fromCache: false };
  }
}

function rsi(closes) {
  if (!closes || closes.length < 14) return null;
  const g = [], l = [];
  for (let i = 1; i < closes.length; i++) { const d = closes[i] - closes[i - 1]; g.push(d > 0 ? d : 0); l.push(d < 0 ? -d : 0); }
  const ag = g.slice(-14).reduce((a, b) => a + b, 0) / 14;
  const al = l.slice(-14).reduce((a, b) => a + b, 0) / 14;
  if (al === 0) return ag > 0 ? 100 : 50;
  return 100 - 100 / (1 + ag / al);
}

function detectBullishDivergence(prices, lookbackHours = 6) {
  if (!prices || prices.length < 48) return false;
  const step = Math.max(1, Math.floor(prices.length / 24));
  const sampled = [];
  for (let i = 0; i < prices.length; i += step) sampled.push(prices[i]);
  if (sampled.length < 14 + lookbackHours) return false;
  const rsiSeries = [];
  for (let i = 14; i < sampled.length; i++)
    rsiSeries.push(rsi(sampled.slice(i - 14, i + 1)));
  const p = sampled.slice(-lookbackHours);
  const r = rsiSeries.slice(-lookbackHours);
  let priceLow = Infinity, priceLowIdx = -1;
  for (let i = 0; i < p.length; i++) {
    if (p[i] < priceLow) { priceLow = p[i]; priceLowIdx = i; }
  }
  let rsiLow = Infinity, rsiLowIdx = -1;
  for (let i = 0; i < r.length; i++) {
    if (r[i] < rsiLow) { rsiLow = r[i]; rsiLowIdx = i; }
  }
  return priceLowIdx > rsiLowIdx && r[priceLowIdx] > rsiLow;
}

function intradayMom(prices) {
  if (!Array.isArray(prices) || prices.length < 36) return null;
  const last12 = prices.slice(-12);
  const prev24 = prices.slice(-36, -12);
  const recent = last12.reduce((s, p) => s + p, 0) / last12.length;
  const prev = prev24.reduce((s, p) => s + p, 0) / prev24.length;
  const pct = ((recent - prev) / prev) * 100;
  if (pct > 2) return 2;
  if (pct > 0.5) return 1;
  if (pct < -2) return -2;
  if (pct < -0.5) return -1;
  return 0;
}

function volRatio(prices) {
  if (!Array.isArray(prices) || prices.length < 24) return null;
  const last = prices.slice(-12);
  const prev = prices.slice(-24, -12);
  const avgMove = arr => {
    let sum = 0;
    for (let i = 1; i < arr.length; i++) sum += Math.abs(arr[i] - arr[i - 1]) / (arr[i - 1] || 0.0001);
    return sum / (arr.length - 1);
  };
  const aL = avgMove(last), aP = avgMove(prev);
  if (aP === 0) return null;
  return aL / aP;
}

function ema(prices) {
  if (!Array.isArray(prices) || prices.length < 9) return null;
  const last3 = prices.slice(-3);
  const prev6 = prices.slice(-9, -3);
  const recent = last3.reduce((s, p) => s + p, 0) / 3;
  const prior = prev6.reduce((s, p) => s + p, 0) / 6;
  const pct = ((recent - prior) / prior) * 100;
  if (pct < -3) return -2;
  if (pct < -1) return -1;
  if (pct > 3) return 2;
  if (pct > 1) return 1;
  return 0;
}

function peakDist(prices, sym) {
  if (!Array.isArray(prices) || prices.length < 10) return null;
  const cur = prices[prices.length - 1];
  const high = Math.max(...prices);
  const peaker = loadPeakTracker();
  const prev = peaker[sym] || 0;
  if (high > prev) { peaker[sym] = high; savePeakTracker(peaker); }
  const truePeak = Math.max(high, prev);
  return ((cur - truePeak) / truePeak) * 100;
}

function volSpike(prices, volumes) {
  if (!Array.isArray(prices) || !Array.isArray(volumes) || prices.length < 24 || volumes.length < 24) return null;
  const last3 = volumes.slice(-3).reduce((s, v) => s + v, 0) / 3;
  const prev9 = volumes.slice(-12, -3).reduce((s, v) => s + v, 0) / 9;
  if (prev9 <= 0) return null;
  return last3 / prev9;
}

function score(chg, vol, type) {
  let s = 0;
  if (chg > 10) s += 5; else if (chg > 5) s += 3; else if (chg > 2) s += 2; else if (chg > 0) s += 1; else if (chg > -5) s -= 1; else s -= 2;
  if (vol > 5e8) s += 3; else if (vol > 5e7) s += 2; else if (vol > 5e6) s += 1;
  if (type === 's') s += 2;
  return s;
}

async function fetchYF(sym) {
  try {
    const d = await httpGet(`https://query1.finance.yahoo.com/v8/finance/chart/${sym}?interval=1d&range=2mo`);
    const r = d?.chart?.result?.[0];
    if (!r) return null;
    const c = r.indicators?.quote?.[0]?.close?.filter(x => x) || [];
    return { p: r.meta.regularMarketPrice, pc: r.meta.chartPreviousClose, c: c.filter(x => x > 0), v: r.indicators?.quote?.[0]?.volume || [] };
  } catch(e) { return null; }
}

async function fetchBals() {
  const ids = PORTFOLIO.map(p => p.id);
  const args = Buffer.from(JSON.stringify({ account_id: ACCOUNT, token_ids: ids })).toString('base64');
  const body = { jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', account_id: 'intents.near', method_name: 'mt_batch_balance_of', args_base64: args, finality: 'optimistic' } };
  for (let i = 0; i < RPC_ENDPOINTS.length; i++) {
    const rpc = RPC_ENDPOINTS[i];
    try {
      const r = await httpPost(rpc, body);
      if (!r.d?.result?.result) continue;
      const parsed = JSON.parse(Buffer.from(r.d.result.result, 'base64').toString());
      const bals = PORTFOLIO.map((p, j) => {
        const raw = Array.isArray(parsed) ? (parsed[j] || '0') : '0';
        return { ...p, raw, human: Number(BigInt(raw)) / 10 ** p.dec };
      });
      try { fs.writeFileSync(BAL_CACHE_FILE, JSON.stringify(bals)); } catch(e) {}
      return bals;
    } catch(e) { if (i === RPC_ENDPOINTS.length - 1) log(`Balance fetch failed, using cached balances`); }
  }
  try {
    const cached = JSON.parse(fs.readFileSync(BAL_CACHE_FILE, 'utf8'));
    log('Using cached balances');
    return cached;
  } catch(e) {}
  return PORTFOLIO.map(p => ({ ...p, raw: '0', human: 0 }));
}

async function fetchNearBal() {
  const body = { jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', account_id: ACCOUNT, finality: 'optimistic' } };
  for (const rpc of RPC_ENDPOINTS) {
    try {
      const r = await httpPost(rpc, body);
      if (r.d?.result?.amount) return Number(BigInt(r.d.result.amount)) / 1e24;
    } catch(e) {}
  }
  return 0;
}

async function execSwap(from, to, amount, pk, prices) {
  const { jwt } = loadEnv();
  if (!jwt) return null;
  const dl = new Date(Date.now() + 86400000).toISOString().replace(/\.\d+Z/, '.000Z');
  const quoteBody = (dry) => ({
    dry, swapType: 'EXACT_INPUT', depositMode: 'SIMPLE',
    originAsset: from.id, destinationAsset: to.id,
    amount: amount.toString(),
    slippageTolerance: 100,
    recipient: ACCOUNT, recipientType: 'INTENTS',
    refundTo: ACCOUNT, refundType: 'INTENTS',
    depositType: 'INTENTS', deadline: dl,
  });
  try {
    // Step 1: Dry run → spread check (no deposit address created)
    let spreadPct = 0;
    if (prices) {
      const dryR = await httpPost('https://1click.chaindefuser.com/v0/quote', quoteBody(true), { 'Authorization': `Bearer ${jwt}` });
      const q = dryR.d?.quote;
      if (q?.amountOut) {
        const pIn = from.sym === 'USDC' ? 1 : (prices[from.sym]?.p || 0);
        const pOut = to.sym === 'USDC' ? 1 : (prices[to.sym]?.p || 0);
        const inUSD = Number(q.amountIn) / 10 ** from.dec * pIn;
        const outUSD = Number(q.amountOut) / 10 ** to.dec * pOut;
        if (inUSD > 0) {
          spreadPct = Math.max(0, (1 - outUSD / inUSD) * 100);
          log(`  Spread (dry): ${spreadPct.toFixed(2)}%`);
          if (spreadPct > MAX_SPREAD_PCT) {
            log(`  Spread ${spreadPct.toFixed(1)}% > ${MAX_SPREAD_PCT}%, skipping`);
            return { ok: false, spread: spreadPct, feeUsd: 0 };
          }
        }
      }
    }

    // Step 2: Non-dry quote → get deposit address
    const qr = await httpPost('https://1click.chaindefuser.com/v0/quote', quoteBody(false), { 'Authorization': `Bearer ${jwt}` });
    if (!qr.d?.quote?.depositAddress) { log('Quote fail:', JSON.stringify(qr.d).slice(0, 200)); return null; }
    const da = qr.d.quote.depositAddress;
    const qAmtIn = qr.d.quote.amountIn || amount;
    const qAmtOut = qr.d.quote.amountOut || '0';

    if (spreadPct === 0 && prices) {
      const pIn2 = from.sym === 'USDC' ? 1 : (prices[from.sym]?.p || 0);
      const pOut2 = to.sym === 'USDC' ? 1 : (prices[to.sym]?.p || 0);
      const inUSD2 = Number(qAmtIn) / 10 ** from.dec * pIn2;
      const outUSD2 = Number(qAmtOut) / 10 ** to.dec * pOut2;
      if (inUSD2 > 0) {
        spreadPct = Math.max(0, (1 - outUSD2 / inUSD2) * 100);
        log(`  Spread (non-dry fallback): ${spreadPct.toFixed(2)}%`);
      }
    }

    log(`  Swap ${from.sym}→${to.sym} addr=${da.slice(0, 16)}...`);

    const ir = await httpPost('https://1click.chaindefuser.com/v0/generate-intent', {
      type: 'swap_transfer', depositAddress: da, signerId: ACCOUNT, standard: 'nep413',
    }, { 'Authorization': `Bearer ${jwt}` });
    if (!ir.d?.intent?.payload) { log('Intent fail:', JSON.stringify(ir.d).slice(0, 200)); return null; }
    const { message, nonce, recipient } = ir.d.intent.payload;

    // Inline signing — no external process call
    const signature = nep413Sign(message, nonce, recipient, pk);

    const sd = { standard: 'nep413', payload: { message, nonce, recipient }, public_key: PUBLIC_KEY, signature };

    // Publish to solver relay
    let intentHash = '';
    const pr = await httpPost('https://solver-relay-v2.chaindefuser.com/rpc', { id: 1, jsonrpc: '2.0', method: 'publish_intent', params: [{ quote_hashes: [], signed_data: sd }] }, { 'X-API-Key': jwt });
    if (pr.d?.result?.status === 'OK') intentHash = pr.d.result.intent_hash || '';
    if (!intentHash) log('Relayer: no intent_hash, trying 1Click backup');

    const subRes = await httpPost('https://1click.chaindefuser.com/v0/submit-intent', { type: 'swap_transfer', signedData: sd }, { 'Authorization': `Bearer ${jwt}` }).catch(() => null);
    if (!intentHash && subRes?.d?.intentHash) intentHash = subRes.d.intentHash;

    log(`  Intent: ${intentHash ? intentHash.slice(0, 16) + '...' : 'unknown'}`);

    let txHash = '';
    for (let i = 0; i < 6; i++) {
      await sleep(5000);
      try {
        const sr = await httpPost('https://solver-relay-v2.chaindefuser.com/rpc', { id: 1, jsonrpc: '2.0', method: 'get_status', params: [{ intent_hash: intentHash }] }, { 'X-API-Key': jwt });
        const st = sr.d?.result?.status;
        if (st === 'SETTLED') { txHash = sr.d?.result?.data?.hash || da; log('  SETTLED'); break; }
      } catch(e) {}
    }

    await sleep(2000);
    await httpPost('https://1click.chaindefuser.com/v0/deposit/submit', { txHash: txHash || da, depositAddress: da }, { 'Authorization': `Bearer ${jwt}` });

    for (let i = 0; i < 12; i++) {
      await sleep(5000);
      try {
        const sr = await httpGet(`https://1click.chaindefuser.com/v0/status?depositAddress=${da}`, { 'Authorization': `Bearer ${jwt}` });
        if (sr?.status === 'SUCCESS') {
          const feeUsd = spreadPct > 0 ? (Number(qAmtOut) / 10 ** to.dec * (to.sym === 'USDC' ? 1 : (prices?.[to.sym]?.p || 0))) * (spreadPct / 100) : 0;
          log(`  ✅ ${sr.swapDetails?.amountOutFormatted || '?'} ${to.sym}`);
          return { ok: true, out: sr.swapDetails?.amountOutFormatted, spread: spreadPct, feeUsd };
        }
        if (sr?.status === 'FAILED' || sr?.status === 'REFUNDED') { log(`  ❌ ${sr.status}`); return { ok: false, spread: spreadPct, feeUsd: 0 }; }
      } catch(e) {}
    }
    return { ok: false, spread: spreadPct, feeUsd: 0 };
  } catch(e) { log('Swap err:', e.message); return null; }
}

async function checkLiquidity(fromId, toId, rawAmount) {
  const { jwt } = loadEnv();
  if (!jwt) return false;
  try {
    const dl = new Date(Date.now() + 86400000).toISOString().replace(/\.\d+Z/, '.000Z');
    const body = {
      dry: true, swapType: 'EXACT_INPUT', depositMode: 'SIMPLE',
      originAsset: fromId, destinationAsset: toId,
      amount: rawAmount,
      slippageTolerance: 100,
      recipient: ACCOUNT, recipientType: 'INTENTS',
      refundTo: ACCOUNT, refundType: 'INTENTS',
      depositType: 'INTENTS', deadline: dl,
    };
    for (let attempt = 0; attempt < 2; attempt++) {
      const r = await httpPost('https://1click.chaindefuser.com/v0/quote', body, { 'Authorization': `Bearer ${jwt}` });
      if (r.d?.quote?.amountOut != null) return true;
      if (attempt === 0) await sleep(2000);
    }
    return false;
  } catch(e) { return null; } // null = network error
}

// ─── Borsh NEP-413 signing (inlined from nep413_sign.js) ───
function borshString(buf, s) {
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([buf, len, b]);
}
function borshFixed(buf, arr) {
  return Buffer.concat([buf, Buffer.from(arr)]);
}
function borshOptionString(buf, s) {
  if (s === null || s === undefined) {
    return Buffer.concat([buf, Buffer.from([0])]);
  }
  const b = Buffer.from(s, 'utf8');
  const len = Buffer.alloc(4);
  len.writeUInt32LE(b.length);
  return Buffer.concat([buf, Buffer.from([1]), len, b]);
}
function borshSerializeNep413(message, nonceBytes, recipient, callbackUrl) {
  let buf = Buffer.alloc(0);
  buf = borshString(buf, message);
  buf = borshFixed(buf, nonceBytes);
  buf = borshString(buf, recipient);
  buf = borshOptionString(buf, callbackUrl || null);
  const prefix = Buffer.alloc(4);
  prefix.writeUInt32LE(2147484061);
  return Buffer.concat([prefix, buf]);
}
function nep413Sign(message, nonceBase64, recipient, privateKeyBase58) {
  const sk = privateKeyBase58.startsWith('ed25519:')
    ? bs58.decode(privateKeyBase58.slice('ed25519:'.length))
    : bs58.decode(privateKeyBase58);
  const nonceBytes = Buffer.from(nonceBase64, 'base64');
  const serialized = borshSerializeNep413(message, nonceBytes, recipient);
  const hash = crypto.createHash('sha256').update(serialized).digest();
  const signature = nacl.sign.detached(hash, sk);
  return 'ed25519:' + bs58.encode(Buffer.from(signature));
}

function canTrade() {
  try { const t = parseInt(fs.readFileSync(LAST_TRADE, 'utf8').trim()); if (!isNaN(t) && Date.now() - t < COOLDOWN_MS) return false; } catch(e) {}
  return true;
}
function markTrade() { try { fs.writeFileSync(LAST_TRADE, Date.now().toString()); } catch(e) {} }

function loadTradeHistory() {
  try {
    const raw = JSON.parse(fs.readFileSync(TRADE_HISTORY_FILE, 'utf8'));
    return Array.isArray(raw) ? raw : [];
  } catch(e) { return []; }
}
function saveTradeHistory(trades) {
  try { fs.writeFileSync(TRADE_HISTORY_FILE, JSON.stringify(trades)); } catch(e) {}
}
function recordTrade(type, sym, usd, pnl, pnlPct, reason, score) {
  const trades = loadTradeHistory();
  trades.push({ ts: Date.now(), type, sym, usd: usd || 0, pnl, pnlPct, reason: reason || '', score: score ?? null });
  saveTradeHistory(trades);
}
function recentlySold(sym) {
  const trades = loadTradeHistory();
  for (let i = trades.length - 1; i >= 0; i--) {
    if (trades[i].sym === sym) return trades[i].type === 'SELL' && Date.now() - trades[i].ts < REBUY_COOLDOWN_MS;
  }
  return false;
}

function buyable(a, failedTokens, routeInv) {
  if (!a || !failedTokens || !routeInv) return false;
  if (a.sc == null || a.sc < 5) return false;
  if (failedTokens.has(a.sym) || !routeInv.has(a.sym) || recentlySold(a.sym)) return false;
  if (a.sc < 6) {
    if (a.vs == null || a.vs < 1.5) return false;
    if (a.m == null || a.m <= 0) return false;
  }
  if (a.r != null && a.r >= 80) return false;
  if (a.sc < 7) {
    if (a.v == null || a.v < 1.0) return false;
    if (a.r != null && a.r >= 70) return false;
  }
  return true;
}

function divergenceBuyable(a, failedTokens, routeInv) {
  if (!a || !failedTokens || !routeInv) return false;
  if (!a.dg || a.sc == null || a.sc < 5) return false;
  if (failedTokens.has(a.sym) || !routeInv.has(a.sym) || recentlySold(a.sym)) return false;
  if (a.v == null || a.v <= 2) return false;
  if (a.e == null || a.e < 0) return false;
  if (a.r != null && a.r >= 80) return false;
  return true;
}

function momentumBuyable(a, failedTokens, routeInv) {
  if (!a || !failedTokens || !routeInv) return false;
  if (failedTokens.has(a.sym) || !routeInv.has(a.sym) || recentlySold(a.sym)) return false;
  if (a.sc == null || a.sc < 4) return false;
  if (a.m == null || a.m <= 0) return false;
  if (a.v == null || a.v < 1) return false;
  if (a.e == null || a.e < 0) return false;
  if (a.r != null && a.r >= 80) return false;
  return true;
}

function accumulationBuyable(a, failedTokens, routeInv) {
  if (!a || !failedTokens || !routeInv) return false;
  if (failedTokens.has(a.sym) || !routeInv.has(a.sym) || recentlySold(a.sym)) return false;
  if (a.sc == null || a.sc < 4) return false;
  if (a.v == null || a.v <= 2) return false;
  if (a.e == null || a.e < 1) return false;
  if (a.ch == null || a.ch <= 3) return false;
  if (a.r != null && a.r >= 80) return false;
  return true;
}

function loadRaisedSyms() {
  try {
    const syms = JSON.parse(fs.readFileSync(RAISED_SYMS_FILE, 'utf8'));
    const now = Date.now();
    for (const [k, v] of Object.entries(syms)) {
      if (now - v > 30 * 60 * 1000) delete syms[k];
    }
    return syms;
  } catch(e) { return {}; }
}

function saveRaisedSyms(syms) {
  const now = Date.now();
  for (const [k, v] of Object.entries(syms)) {
    if (now - v > 30 * 60 * 1000) delete syms[k];
  }
  try { fs.writeFileSync(RAISED_SYMS_FILE, JSON.stringify(syms)); } catch(e) {}
}

function loadFlapSyms() {
  try {
    const syms = JSON.parse(fs.readFileSync(FLAP_FILE, 'utf8'));
    const now = Date.now();
    let changed = false;
    for (const [k, v] of Object.entries(syms)) {
      if (now - v > FLAP_COOLDOWN_MS) { delete syms[k]; changed = true; }
    }
    if (changed) try { fs.writeFileSync(FLAP_FILE, JSON.stringify(syms)); } catch(e) {}
    return syms;
  } catch(e) { return {}; }
}

function loadCostBasis() {
  try {
    const raw = JSON.parse(fs.readFileSync(COST_BASIS_FILE, 'utf8'));
    for (const [k, v] of Object.entries(raw)) {
      if (typeof v === 'number') raw[k] = { cost: v, spread: 0, fee: 0, qty: 0, price: 0 };
    }
    return raw;
  } catch(e) { return {}; }
}
function saveCostBasis(cb) {
  try { fs.writeFileSync(COST_BASIS_FILE, JSON.stringify(cb)); } catch(e) {}
}

function saveFlapSyms(syms) {
  const now = Date.now();
  for (const [k, v] of Object.entries(syms)) {
    if (now - v > FLAP_COOLDOWN_MS) delete syms[k];
  }
  try { fs.writeFileSync(FLAP_FILE, JSON.stringify(syms)); } catch(e) {}
}

const TP_STATE_FILE = path.join(PROJECT, '.tp_state.json');
function loadTpState() {
  try { return JSON.parse(fs.readFileSync(TP_STATE_FILE, 'utf8')); } catch(e) { return {}; }
}
function saveTpState(st) {
  try { fs.writeFileSync(TP_STATE_FILE, JSON.stringify(st)); } catch(e) {}
}

async function validateSell(sym, reason, position, fg, portfolio, holdStartMap) {
  if (!deepseek.hasKey()) return true;
  const tradeHistory = loadTradeHistory();
  const recentTrades = tradeHistory.slice(-10).map(t => 
    `${t.type} ${t.sym} ${t.usd > 0 ? '$' + Math.round(t.usd).toString() : ''}${t.pnl !== undefined && t.pnl !== null ? ' (' + (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(1) + ')' : ''}`
  ).join(', ');
  const holdMs = position?.sym && holdStartMap[position.sym] ? Date.now() - holdStartMap[position.sym] : -1;
  const holdStr = holdMs >= 0 ? Math.round(holdMs / 60000) + 'min' : '?';
  const costBasisLocal = loadCostBasis();
  const cbSym = position?.sym ? costBasisLocal[position.sym] : null;
  const pnlStr = cbSym?.cost > 0 && position?.value > 0 ? ((position.value - cbSym.cost) / cbSym.cost * 100).toFixed(1) + '%' : '?';
  const aiMsg = [
    { role: 'system', content: 'You are a crypto trading assistant. Validate whether SELLING the given token is a good idea. Sell triggers: (1) overbought (RSI>92), (2) low score (<4) — JUNK SELL: triggered after a 30-min timer expires. The AI may approve or reject. If rejected, the timer resets for another 30 min — only reject if the token shows genuine recovery potential (e.g., score improved, momentum turned positive, market conditions changed), (3) sharp drop (MOM=-2), (4) volatile drop (VOL>3x+MOM<0 or VS>3x+price drop), (5) EMA crash (EMA=-2), (6) pump end, (7) emergency crash, (8) risk-off (F&G<30+broad red), (9) rotation (replace weakest), (10) raise USDC (sell to buy better), (11) rotation upgrade: selling an underperforming position (sc<4 OR (VOL<1.0x AND MOM≤0)) to fund a momentum/breakout entry (target VOL>1.5x, MOM>0, EMA≥0) is VALID even if held <2h because dead-volume opportunity cost outweighs the spread, (12) take-profit: staged TP system sells 1/3 at RSI>75 (tier1), 1/3 at RSI>82 (tier2), and all at RSI>92 (tier3). TIER1 AND TIER2 ARE MECHANICAL RISK-MANAGEMENT RULES — approve unless extraordinary circumstances (e.g., token just entered a strong breakout with VOL>2.0x and MOM>0 and price breaking out to new highs). You keep 2/3 of the position after tier1/tier2, so there is still upside exposure. Rejecting TP sells causes positions to be held until they turn junk and lose all profit — this is the main failure pattern to avoid. Low-volume overbought rallies (VOL<1.0x, MOM>0) should STILL be sold — taking partial profit on a low-volume pump is correct risk management. DIVERGENCE RULE: If divergence=YES (bullish divergence), consider HOLDING longer unless other sell signals are overwhelming. If divergence=NO and price is stalling (MOM=0, RSI declining), take profit. VOL=price volatility (price swings), VS=actual trading volume spike. Avoid churn: selling recently-bought tokens early wastes spread. Reply ONLY "YES" or "NO" + brief reason.' },
    { role: 'user', content: `F&G ${fg?.v ?? '?'}/100 ${fg?.t ?? '?'}. SELL ${sym} (${reason}, sc=${position?.score ?? '?'}, RSI=${position?.rsi ?? '?'}, MOM=${position?.mom ?? '?'}, EMA=${position?.e ?? '?'}, VOL=${position?.vol != null ? position.vol.toFixed(1) + 'x' : '?'}, VS=${position?.vs != null ? position.vs.toFixed(1) + 'x' : '?'}, PD=${position?.d ?? '?'}%, P&L=${pnlStr}, held=${holdStr}, divergence=${position?.dg ? 'YES' : 'NO'}). Portfolio: ${(portfolio || []).filter(p => p.value > 0.01).map(p => `${p.sym}=$${p.value.toFixed(0)}`).join(', ') || 'empty'}. Recent trades: ${recentTrades || 'none'}.` },
  ];
  const aiReply = await deepseek.chat(aiMsg, { maxTokens: 100, temperature: 0.1 });
  if (aiReply) log(`  🤖 DS: ${aiReply}`);
  if (aiReply?.startsWith('NO')) return false;
  return true;
}

function loadFailCooldown() {
  try { return JSON.parse(fs.readFileSync(FAIL_COOLDOWN_FILE, 'utf8')); } catch(e) { return {}; }
}

function saveFailCooldown(syms) {
  const now = Date.now();
  for (const [k, v] of Object.entries(syms)) {
    if (now - v > FAIL_COOLDOWN_MS) delete syms[k];
  }
  try { fs.writeFileSync(FAIL_COOLDOWN_FILE, JSON.stringify(syms)); } catch(e) {}
}

function saveFrozenSyms(syms) {
  try { fs.writeFileSync(FROZEN_FILE, JSON.stringify([...syms])); } catch(e) {}
}

function loadPeakTracker() {
  try { return JSON.parse(fs.readFileSync(PEAK_FILE, 'utf8')); } catch(e) { return {}; }
}
function savePeakTracker(p) {
  try { fs.writeFileSync(PEAK_FILE, JSON.stringify({ ...p, updated: new Date().toISOString() })); } catch(e) {}
}

function logRouteChange(sym, event, detail) {
  const msg = `[${new Date().toISOString()}] ${sym} ${event}${detail ? ' — ' + detail : ''}`;
  console.log(`  📋 ${msg}`);
  try { fs.appendFileSync(NO_ROUTE_LOG, msg + '\n'); } catch(e) {}
}

function loadJunkTimers() {
  try { return JSON.parse(fs.readFileSync(JUNK_FILE, 'utf8')); } catch(e) { return {}; }
}

function saveJunkTimers(timers) {
  const now = Date.now();
  for (const [k, v] of Object.entries(timers)) {
    if (now - v >= JUNK_HOLD_MS) delete timers[k];
  }
  try { fs.writeFileSync(JUNK_FILE, JSON.stringify(timers)); } catch(e) {}
}

function loadObTimers() {
  try { return JSON.parse(fs.readFileSync(OB_FILE, 'utf8')); } catch(e) { return {}; }
}

function saveObTimers(timers) {
  const now = Date.now();
  for (const [k, v] of Object.entries(timers)) {
    if (now - v >= OB_HOLD_MS) delete timers[k];
  }
  try { fs.writeFileSync(OB_FILE, JSON.stringify(timers)); } catch(e) {}
}

function loadTopupThrottle() {
  try { return JSON.parse(fs.readFileSync(TOPUP_THROTTLE_FILE, 'utf8')); } catch(e) { return {}; }
}
function saveTopupThrottle(th) {
  const now = Date.now();
  for (const [k, v] of Object.entries(th)) {
    if (now - v >= TOPUP_THROTTLE_MS) delete th[k];
  }
  try { fs.writeFileSync(TOPUP_THROTTLE_FILE, JSON.stringify(th)); } catch(e) {}
}

const ROUTE_INVENTORY_FILE = path.join(PROJECT, '.route_inventory.json');
const ROUTE_INVENTORY_TTL = 30 * 60 * 1000;

function loadRouteInventoryCache() {
  try {
    const raw = JSON.parse(fs.readFileSync(ROUTE_INVENTORY_FILE, 'utf8'));
    if (Date.now() - raw.ts > ROUTE_INVENTORY_TTL) return null;
    return new Set(raw.tradable);
  } catch(e) { return null; }
}

function saveRouteInventoryCache(tradable) {
  try { fs.writeFileSync(ROUTE_INVENTORY_FILE, JSON.stringify({ ts: Date.now(), tradable: [...tradable] })); } catch(e) {}
}

async function buildRouteInventory(portfolio, jwt, routeHealth) {
  const tradable = new Set(['USDC', 'wNEAR']);
  for (const t of portfolio) {
    if (tradable.has(t.sym)) continue;
    const buyAmt = Math.floor(MIN_POSITION_VALUE * 1e6).toString();
    const sellAmt = Math.floor(MIN_POSITION_VALUE * 10 ** t.dec).toString();
    let buyOk = false, sellOk = false, note = '';
    try {
      const dl = new Date(Date.now() + 86400000).toISOString().replace(/\.\d+Z/, '.000Z');
      const buyR = await httpPost('https://1click.chaindefuser.com/v0/quote', {
        dry: true, swapType: 'EXACT_INPUT', depositMode: 'SIMPLE',
        originAsset: USDC_NEAR, destinationAsset: t.id,
        amount: buyAmt, slippageTolerance: 100,
        recipient: ACCOUNT, recipientType: 'INTENTS',
        refundTo: ACCOUNT, refundType: 'INTENTS',
        depositType: 'INTENTS', deadline: dl,
      }, { 'Authorization': `Bearer ${jwt}` });
      buyOk = buyR.d?.quote?.amountOut != null;
      if (!buyOk) { note = buyR.d?.error || 'no buy route'; await sleep(1000); if (routeHealth) routeHealth.push({ t: t.sym, buy: buyOk, sell: sellOk, note }); continue; }
      await sleep(1000);
      const sellR = await httpPost('https://1click.chaindefuser.com/v0/quote', {
        dry: true, swapType: 'EXACT_INPUT', depositMode: 'SIMPLE',
        originAsset: t.id, destinationAsset: USDC_NEAR,
        amount: sellAmt, slippageTolerance: 100,
        recipient: ACCOUNT, recipientType: 'INTENTS',
        refundTo: ACCOUNT, refundType: 'INTENTS',
        depositType: 'INTENTS', deadline: dl,
      }, { 'Authorization': `Bearer ${jwt}` });
      sellOk = sellR.d?.quote?.amountOut != null;
      if (!sellOk) note = sellR.d?.error || 'no sell route';
      if (sellOk) tradable.add(t.sym);
      await sleep(1000);
    } catch(e) { note = e.message?.slice(0, 50) || 'error'; }
    if (routeHealth) routeHealth.push({ t: t.sym, buy: buyOk, sell: sellOk, note });
  }
  saveRouteInventoryCache(tradable);
  return tradable;
}

async function main() {
  log('');
  log('=== AGENT RUN ===');
  const env = loadEnv();
  const canExec = !!(env.jwt && env.pk);
  if (!canExec) log('Monitor-only mode: add JWT to .env to enable swaps');
  else log('Full mode: swap execution enabled');

  const ok = canTrade();
  if (!ok) log('Cooldown active');

  // Fix 1: ensure OHLC cache file exists (populated by first cycle → 0 API calls thereafter)
  try { if (!fs.existsSync(OHLC_CACHE_FILE)) fs.writeFileSync(OHLC_CACHE_FILE, '{}'); } catch(e) {}

  // Route inventory — cache of which tokens have active 1Click swap routes
  let routeInv = canExec ? loadRouteInventoryCache() : null;
  const routeHealth = [];
  if (canExec && !routeInv) {
    log('Building route inventory...');
    routeInv = await buildRouteInventory(PORTFOLIO, env.jwt, routeHealth);
    log(`Route inventory: ${routeInv.size} tradable of ${PORTFOLIO.length}`);
  } else if (canExec) {
    log(`Route inventory: ${routeInv.size} tradable (cached)`);
  } else {
    const all = PORTFOLIO.map(p => p.sym);
    routeInv = new Set(all);
  }
  const routePrev = new Set(routeInv);
  // Progressive route inventory refresh — test unknown tokens each cycle
  if (canExec) {
    const unknown = PORTFOLIO.filter(t => !routeInv.has(t.sym) && !t.sym.endsWith('on') && t.sym !== 'TON');
    if (unknown.length > 0) {
      const batch = unknown.slice(0, 3);
      for (const t of batch) {
        const buyAmt = Math.floor(MIN_POSITION_VALUE * 1e6).toString();
        const sellAmt = Math.floor(MIN_POSITION_VALUE * 10 ** t.dec).toString();
        try {
          const dl = new Date(Date.now() + 86400000).toISOString().replace(/\.\d+Z/, '.000Z');
          const r = await httpPost('https://1click.chaindefuser.com/v0/quote', {
            dry: true, swapType: 'EXACT_INPUT', depositMode: 'SIMPLE',
            originAsset: USDC_NEAR, destinationAsset: t.id,
            amount: buyAmt, slippageTolerance: 100,
            recipient: ACCOUNT, recipientType: 'INTENTS',
            refundTo: ACCOUNT, refundType: 'INTENTS',
            depositType: 'INTENTS', deadline: dl,
          }, { 'Authorization': `Bearer ${env.jwt}` });
          if (r.d?.quote?.amountOut != null) {
            await sleep(1000);
            const s = await httpPost('https://1click.chaindefuser.com/v0/quote', {
              dry: true, swapType: 'EXACT_INPUT', depositMode: 'SIMPLE',
              originAsset: t.id, destinationAsset: USDC_NEAR,
              amount: sellAmt, slippageTolerance: 100,
              recipient: ACCOUNT, recipientType: 'INTENTS',
              refundTo: ACCOUNT, refundType: 'INTENTS',
              depositType: 'INTENTS', deadline: dl,
            }, { 'Authorization': `Bearer ${env.jwt}` });
            if (s.d?.quote?.amountOut != null) {
              log(`  ✅ ${t.sym} route discovered!`);
              logRouteChange(t.sym, 'discovered');
              routeInv.add(t.sym);
            }
          }
        } catch(e) {}
        await sleep(1000);
      }
      saveRouteInventoryCache(routeInv);
    }
  }

  // Market data
  const fg = await fetchFG();
  log(`F&G: ${fg.v}/100 ${fg.t}`);

  const allCgIds = [...new Set(Object.values(CG_IDS))];
  const [cgData, clickPrices] = await Promise.all([fetchCGData(allCgIds), fetch1ClickPrices()]);
  const hasRealScores = Object.keys(cgData).length > 0;

  const STABLE_SYMS = new Set(['USDC', 'USDT', 'USDT0', 'DAI', 'FRAX', 'USDon', 'USAD']);
  const assets = {};

  // Crypto
  for (const [sym, id] of Object.entries(CG_IDS)) {
    const cg = cgData[id];
    const c1 = clickPrices[sym];
    const price = c1?.price ?? cg?.usd ?? null;
    if (price == null) continue;
    const ch = cg?.usd_24h_change ?? 0;
    const vol = cg?.usd_24h_vol ?? 0;
    const mcap = cg?.usd_market_cap ?? 0;
    assets[sym] = { p: price, ch, v: vol, mc: mcap, sc: score(ch, vol, 'c') };
    if (STABLE_SYMS.has(sym)) assets[sym] = { p: 1, ch: 0, v: 0, mc: 0, sc: 0 };
  }

  const healthyPriceData = Object.keys(assets).length >= 30;
  if (!healthyPriceData) {
    log(`⚠️ Degraded mode: only ${Object.keys(assets).length}/${Object.keys(CG_IDS).length} token prices (network issues?) — holding positions, no trades`);
  }

  // ETFs
  let goldChg = 0, mktDown = 0, mktCount = 0;
  const etfData = {};
  for (const [sym, yf] of Object.entries(ETF_MAP)) {
    const d = await fetchYF(yf);
    if (d) {
      etfData[sym] = d;
      const ch = d.p && d.pc ? ((d.p - d.pc) / d.pc) * 100 : 0;
      const vol = d.v?.[d.v.length - 1] || 0;
      assets[sym] = { p: d.p, ch, v: vol, sc: score(ch, vol, 's') };
      if (sym === 'GLDon') goldChg = ch;
    }
    await sleep(300);
    mktCount++;
  }

  // Load failed tokens + last positions from history for RSI + candidate filtering
  let failedTokens = new Set();
  let lastPos = [];
  let fallbackPrices = {};
  try {
    const h = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (Array.isArray(h) && h.length > 0) {
      failedTokens = new Set(h[h.length - 1].failedTokens || []);
      lastPos = (h[h.length - 1].pos || []).filter(p => p.v >= 0.50).map(p => p.s);
      const lastEntry = h[h.length - 1];
      if (lastEntry.pos) {
        for (const p of lastEntry.pos) {
          if (p.q > 0 && p.v > 0) fallbackPrices[p.s] = p.v / p.q;
        }
      }
    }
  } catch(e) {}
  // Ondo ETFs (symbols ending in "on") have no swap routes on 1Click — block all dynamically
  for (const t of PORTFOLIO) {
    if (t.sym.endsWith('on') && t.sym !== 'TON') failedTokens.add(t.sym);
  }
  // 1cs_v1: token IDs are invisible to mt_batch_balance_of — block trading into them
  for (const t of PORTFOLIO) {
    if (t.id.startsWith('1cs_v1:')) failedTokens.add(t.sym);
  }
  const raisedSyms = loadRaisedSyms();
  const costBasis = loadCostBasis();
  const flapSyms = loadFlapSyms();
  const failCooldown = loadFailCooldown();
  let junkTimers = loadJunkTimers();
  let obTimers = loadObTimers();
  let frozenSyms = new Set();
  try { frozenSyms = new Set(JSON.parse(fs.readFileSync(FROZEN_FILE, 'utf8'))); } catch(e) {}
  // Check if any frozen token's route has returned
  for (const sym of [...frozenSyms]) {
    const entry = PORTFOLIO.find(p => p.sym === sym);
    if (!entry || entry.id.startsWith('1cs_v1:')) continue;
    const raw = '1' + '0'.repeat(entry.dec);
    const hasRoute = await checkLiquidity(entry.id, USDC_NEAR, raw);
    if (hasRoute) {
      log(`  ✅ ${sym} route found! Un-freezing`);
      logRouteChange(sym, 'reappeared');
      frozenSyms.delete(sym);
      delete failCooldown[sym];
      if (healthyPriceData) {
        flapSyms[sym] = Date.now();
        saveFlapSyms(flapSyms);
      }
    } else {
      failCooldown[sym] = Date.now();
      log(`  ${sym} frozen: still no swap route`);
    }
  }
  saveFrozenSyms(frozenSyms);
  let totalDeposits = 0;
  try { totalDeposits = JSON.parse(fs.readFileSync(DEPOSITS_FILE, 'utf8')).total || 0; } catch(e) {}
  // Init cooldown for Ondo ETFs so re-check loop skips them immediately
  for (const sym of failedTokens) {
    if (sym.endsWith('on') && sym !== 'TON' && !failCooldown[sym]) {
      failCooldown[sym] = Date.now();
    }
  }
  saveFailCooldown(failCooldown);

  // RSI — held tokens (from history) + top 15 scorers
  const sorted = Object.entries(assets).sort((a, b) => {
    const scDiff = b[1].sc - a[1].sc;
    if (scDiff !== 0) return scDiff;
    return (b[1].ch || 0) - (a[1].ch || 0);
  });
  const top15 = sorted.slice(0, 15).map(e => e[0]);

  const rsis = {};
  const moms = {};
  const vols = {};
  const ems = {};
  const pds = {};
  const vss = {};
  // Sequential fetch: held (for OB detection) + top 5 crypto scorers (buy candidates)
  // ETFs score high on stock market days but have no CG IDs — skip them
  const cryptoScorers = sorted.filter(([sym]) => CG_IDS[sym] && sym !== 'NEAR' && !STABLE_SYMS.has(sym) && routeInv.has(sym)).map(e => e[0]);
  const topDisplaySyms = sorted.filter(([sym]) => routeInv.has(sym) && sym !== 'NEAR').slice(0, 10).map(([sym]) => sym);
  const topDisplayWithCG = topDisplaySyms.filter(sym => CG_IDS[sym]);
  const rsiPriority = [...new Set([...lastPos, ...cryptoScorers.slice(0, 10), ...topDisplayWithCG])];
  const divergences = {};
  for (let i = 0; i < rsiPriority.length; i++) {
    const sym = rsiPriority[i];
    const id = CG_IDS[sym];
    const [{ closes, fromCache }, { prices, volumes }] = await Promise.all([fetchOHLC(id), fetchIntraday(id)]);
    if (closes) rsis[sym] = rsi(closes);
    if (prices) {
      moms[sym] = intradayMom(prices); vols[sym] = volRatio(prices); ems[sym] = ema(prices); pds[sym] = peakDist(prices, sym); vss[sym] = volSpike(prices, volumes);
      divergences[sym] = detectBullishDivergence(prices, 6);
    }
    if (!fromCache) await sleep(i === rsiPriority.length - 1 ? 0 : 3000);
  }
  // ETF RSI from stored data
  for (const [sym, d] of Object.entries(etfData)) {
    if (d?.c?.length >= 14) rsis[sym] = rsi(d.c);
  }

  // Top assets ranked
  const ranked = sorted.map(([sym, a]) => ({ sym, ...a, r: rsis[sym], m: moms[sym], v: vols[sym], e: ems[sym], d: pds[sym], vs: vss[sym], dg: divergences[sym] ?? false }))
    .sort((a, b) => {
      if (b.sc !== a.sc) return b.sc - a.sc;
      const mA = a.m, mB = b.m;
      if (mA !== undefined && mB !== undefined && mA !== mB) return mB - mA;
      return (b.ch || 0) - (a.ch || 0);
    });
  const downCount = ranked.slice(0, 15).filter(a => a.ch < 0).length;

  log('Top 10:');
  const buyableCount = { count: 0 };
  ranked.filter(a => routeInv.has(a.sym) && a.sym !== 'NEAR' && !STABLE_SYMS.has(a.sym)).slice(0, 10).forEach(a => {
    const rsiStr = (a.r !== undefined ? `RSI=${a.r.toFixed(0)}` : 'RS--').padEnd(6);
    const momStr = (a.m !== undefined ? `MOM:${a.m >= 0 ? '+' : ''}${a.m}` : 'MOM:?').padEnd(7);
    const volIcon = a.v !== undefined && a.v !== null ? (a.v > 3 ? '🔥' : a.v > 2 ? '⚡' : '  ') : '  ';
    const volStr = volIcon + (a.v !== undefined && a.v !== null ? `VOL:${a.v.toFixed(1)}x` : 'VOL:?x').padEnd(8);
    const vsIcon = a.vs !== undefined && a.vs !== null ? (a.vs > 3 ? '🔥' : a.vs > 2 ? '⚡' : '  ') : '  ';
    const vsStr = vsIcon + (a.vs !== undefined && a.vs !== null ? `VS:${a.vs.toFixed(1)}x` : 'VS:?x').padEnd(8);
    const emaIcon = a.e !== undefined && a.e !== null ? (a.e === -2 ? '💀' : a.e === 2 ? '🚀' : a.e === -1 ? '📉' : a.e === 1 ? '📈' : '  ') : '';
    const emaStr = emaIcon + (a.e !== undefined && a.e !== null ? `EMA:${a.e >= 0 ? '+' : ''}${a.e}` : '').padEnd(6);
    const pdStr = a.d !== undefined && a.d !== null ? `PD:${a.d.toFixed(1)}%` : '';
    const dgStr = `DG=${a.dg ? 'YES' : 'NO'}`;
    const isBuyable = buyable(a, failedTokens, routeInv) || divergenceBuyable(a, failedTokens, routeInv);
    if (isBuyable) buyableCount.count++;
    log(`  ${a.sym.padEnd(11)} sc=${a.sc}   $${(a.p?.toFixed(4)||'?').padStart(10)}  ${(a.ch?.toFixed(1)||'?').padStart(6)}%  ${rsiStr} ${momStr} ${volStr} ${vsStr} ${emaStr} ${pdStr} ${dgStr} ${isBuyable ? '✅' : '❌'}`);
  });
  log(`  Buyable: ${buyableCount.count}/10`);

  // Portfolio
  let bals = await fetchBals();
  // Remove frozen entries where balance is now 0
  for (const sym of [...frozenSyms]) {
    const bal = bals.find(b => b.sym === sym);
    if (!bal || bal.human <= 0) {
      log(`  ${sym} balance empty, removing from frozen`);
      frozenSyms.delete(sym);
      delete failCooldown[sym];
    }
  }
  saveFrozenSyms(frozenSyms);
  // Recover hidden 1cs_v1: positions (invisible to mt_batch_balance_of)
  if (env.jwt) {
    for (const [sym, cb] of Object.entries(costBasis)) {
      if (cb.qty > 0 && cb.cost > 0) {
        const bal = bals.find(b => b.sym === sym);
        if (!bal || bal.human === 0) {
          const target = PORTFOLIO.find(p => p.sym === sym);
          if (target && target.id.startsWith('1cs_v1:')) {
            log(`  🚨 ${sym} ($${cb.cost.toFixed(2)}) stranded — 1cs_v1 invisible to balance query, recovering...`);
            const raw = BigInt(Math.floor(cb.qty * 10 ** target.dec)).toString();
            const liq = await checkLiquidity(target.id, USDC_NEAR, raw);
            if (liq) {
              if (!await validateSell(sym, 'recovery (' + sym + ' stranded)', null, fg, [], {})) { log(`  Skipped recovery (AI rejected)`); continue; }
              const r = await execSwap(target, { id: USDC_NEAR, sym: 'USDC', dec: 6 }, raw, env.pk, assets);
              tradedThisCycle = true;
              if (r?.ok) {
                const usdcBi = bals.findIndex(b => b.sym === 'USDC');
                if (usdcBi >= 0 && r.out) bals[usdcBi].human += Number(r.out);
                const proceeds = Number(r.out || 0);
                log(`  ✅ Recovered ${sym} → ${r.out} USDC`);
                recordTrade('SELL', sym, proceeds, proceeds - cb.cost, cb.cost > 0 ? (proceeds - cb.cost) / cb.cost * 100 : 0, 'recovery', null);
                delete costBasis[sym];
                delete junkTimers[sym]; delete obTimers[sym];
                saveCostBasis(costBasis);
                const tpStRec = loadTpState(); if (tpStRec[sym]) { delete tpStRec[sym]; saveTpState(tpStRec); }
                markTrade();
              } else {
                log(`  ❌ Recovery sell failed for ${sym}`);
              }
            } else {
              log(`  ❌ ${sym} has no sell route, cannot recover`);
            }
          }
        }
      }
    }
  }
  let hasPositions = bals.filter(b => b.human > 0 || b.sym === 'USDC');
  const nearBal = await fetchNearBal();
  log(`NEAR: ${nearBal.toFixed(3)}`);
  for (const b of hasPositions) log(`  ${b.sym}: ${b.human.toFixed(6)}`);

  // Valuations
  const assetPrice = (sym) => sym === 'USDC' ? 1 : (assets[sym]?.p || fallbackPrices[sym] || 0);
  let pricedPositions = hasPositions.map(h => {
    const p = assetPrice(h.sym);
    return { ...h, price: p, value: p * h.human, score: h.sym === 'USDC' ? 0 : (assets[h.sym]?.sc || 0), ch: assets[h.sym]?.ch, rsi: rsis[h.sym], mom: moms[h.sym], vol: vols[h.sym], e: ems[h.sym], d: pds[h.sym], vs: vss[h.sym], dg: divergences[h.sym] ?? false };
  });
  for (const p of pricedPositions) {
    const cb = costBasis[p.sym];
    if (cb && cb.qty > 0 && p.human > 0) {
      const ratio = p.human / cb.qty;
      if (ratio > 1.2 || ratio < 0.8) {
        log(`  ⚠️ ${p.sym} cost basis reset (qty ${cb.qty.toFixed(4)} → ${p.human.toFixed(4)}, cost ${cb.cost.toFixed(2)} → ${p.value.toFixed(2)})`);
        cb.cost = p.value;
        cb.qty = p.human;
      }
    }
  }
  saveCostBasis(costBasis);
  const totalValue = pricedPositions.reduce((s, p) => s + p.value, 0);
  // exclude USDC from total for decision purposes (it's the stable)
  const frozenPositions = pricedPositions.filter(p => frozenSyms.has(p.sym) && p.value > 0);
  let nonStablePositions = pricedPositions.filter(p => p.sym !== 'USDC' && p.value >= MIN_TRADE && !frozenSyms.has(p.sym));
  let usdcBal = pricedPositions.find(p => p.sym === 'USDC');
  const frozenValue = frozenPositions.reduce((s, p) => s + p.value, 0);
  const investableTotal = totalValue - frozenValue;

  // Track when each position was acquired (prevents flip-flopping)
  let holdStart = {};
  for (const p of nonStablePositions) {
    if (costBasis[p.sym] && !holdStart[p.sym]) holdStart[p.sym] = Date.now() - HOLD_MIN_MS;
  }

  // Route health check for all held positions
  for (const p of nonStablePositions) {
    const hasRoute = await checkLiquidity(p.id, USDC_NEAR, p.raw);
      if (hasRoute === false) {
      log(`  ⚠️ HELD ${p.sym} ($${p.value.toFixed(2)}) has no sell route!`);
      routeHealth.push({ t: p.sym, buy: '?', sell: false, note: 'held: no sell route' });
    } else if (hasRoute === null) {
      log(`  ⚠️ ${p.sym} sell route check failed (network error), keeping position`);
      routeHealth.push({ t: p.sym, buy: '?', sell: null, note: 'held: network error' });
    } else {
      routeHealth.push({ t: p.sym, buy: '?', sell: true, note: 'held: ok' });
    }
  }
  // Re-check failed tokens — if route is back, allow them again (held tokens included: stale failedToken blocks TOPUP)
  for (const sym of [...failedTokens]) {
    if (failCooldown[sym] && Date.now() - failCooldown[sym] < FAIL_COOLDOWN_MS) continue;
    const target = PORTFOLIO.find(p => p.sym === sym);
    if (!target) continue;
    const rawAmount = target.id.startsWith('1cs_v1:') ? '1' : Math.floor(MIN_POSITION_VALUE * 1e6).toString();
    const hasRoute = await checkLiquidity(USDC_NEAR, target.id, rawAmount);
    if (hasRoute) {
      log(`  ✅ ${sym} route restored, removing from failed tokens`);
      failedTokens.delete(sym);
      delete failCooldown[sym];
      saveFailCooldown(failCooldown);
      if (healthyPriceData) {
        flapSyms[sym] = Date.now();
        saveFlapSyms(flapSyms);
      }
      routeHealth.push({ t: sym, buy: true, sell: '?', note: 're-check: buy route back' });
    } else {
      // Re-check found no route — reset cooldown to prevent retry next cycle
      if (hasRoute === null) routeHealth.push({ t: sym, buy: null, sell: '?', note: 're-check: network error' });
      else routeHealth.push({ t: sym, buy: false, sell: '?', note: 're-check: no buy route' });
      failCooldown[sym] = Date.now();
      saveFailCooldown(failCooldown);
    }
  }

  // Apply route-flap penalty (-1 score for recently recovered tokens)
  // Only when price data is healthy — don't penalize if route flap was due to network issues
  if (healthyPriceData) {
    for (const sym of Object.keys(flapSyms)) {
      if (assets[sym]) {
        assets[sym].sc = Math.max(-2, assets[sym].sc - 1);
        log(`  ${sym}: flap penalty applied (sc ${assets[sym].sc + 1} → ${assets[sym].sc})`);
      }
    }
  }

  // Decision
  let action = 'HOLD', reason = '', tpSell = null;

  if (nearBal < GAS_RESERVE) {
    action = 'HOLD'; reason = `Low gas (${nearBal.toFixed(2)} NEAR)`;
  } else if (!healthyPriceData) {
    action = 'HOLD'; reason = 'Degraded mode: price data unreliable';
  } else if (nonStablePositions.length > 0) {
    // Track score dips for junk hold timer
    for (const p of nonStablePositions) {
      if (hasRealScores && p.score >= 4) {
        if (junkTimers[p.sym]) { delete junkTimers[p.sym]; log(`  ${p.sym} recovered (sc=${p.score}), cleared junk timer`); }
      } else if (hasRealScores && p.score < 4 && !p.dg) {
        if (!junkTimers[p.sym]) { junkTimers[p.sym] = Date.now(); log(`  ${p.sym} junk timer started (sc=${p.score})`); }
      }
      // Overbought timer: start when RSI > 92 & sc < 7, clear when condition no longer met
      const isOb = p.rsi !== undefined && p.rsi > 92 && p.score < 7;
      if (isOb) {
        if (!obTimers[p.sym]) { obTimers[p.sym] = Date.now(); log(`  ${p.sym} OB timer started (RSI=${p.rsi.toFixed(0)} sc=${p.score})`); }
      } else {
        if (obTimers[p.sym]) { delete obTimers[p.sym]; log(`  ${p.sym} no longer OB, cleared timer`); }
      }
    }
    saveJunkTimers(junkTimers);
    // Log active junk timers with remaining time
    for (const [sym, ts] of Object.entries(junkTimers)) {
      const remaining = Math.max(0, JUNK_HOLD_MS - (Date.now() - ts));
      const min = Math.floor(remaining / 60000);
      const sec = Math.floor((remaining % 60000) / 1000);
      const pos = nonStablePositions.find(p => p.sym === sym);
      log(`  ⏳ ${sym} junk sell in ~${min}:${sec.toString().padStart(2, '0')} (sc=${pos?.score ?? '?'})`);
    }
    saveObTimers(obTimers);
    // Urgent sells first (OB, sharp drop, volatile drop, EMA crash, pump end, crash)
    for (const p of nonStablePositions) {
      if (p.m !== undefined && p.m === -2) { action = 'SELL'; reason = `${p.sym} sharp drop MOM=${p.m}`; break; }
      if (p.vol !== undefined && p.vol > 3 && p.m !== undefined && p.m < 0 && !p.dg) { action = 'SELL'; reason = `${p.sym} volatile drop VOL=${p.vol.toFixed(1)}x MOM=${p.m}`; break; }
      if (p.e !== undefined && p.e === -2) { action = 'SELL'; reason = `${p.sym} EMA crash`; break; }
      if (p.pd !== undefined && p.pd < -2) { action = 'SELL'; reason = `${p.sym} trailing stop PD=${p.pd.toFixed(1)}%`; break; }
      if (p.pd !== undefined && p.pd > -2 && p.vol !== undefined && p.vol > 2.5 && p.rsi !== undefined && p.rsi > 80 && p.e !== undefined && p.e <= 0) {
        action = 'SELL'; reason = `${p.sym} pump end PD=${p.pd.toFixed(0)}% VOL=${p.vol.toFixed(1)}x RSI=${p.rsi.toFixed(0)}`; break;
      }
      if (costBasis[p.sym]?.pumpEntry && p.pd !== undefined && p.pd >= -1) {
        action = 'SELL'; reason = `${p.sym} pump peak PD=${p.pd.toFixed(1)}%`; break;
      }
      if (p.pd !== undefined && p.pd > -5 && p.e === -2) {
        action = 'SELL'; reason = `${p.sym} crash PD=${p.pd.toFixed(0)}% EMA:-2`; break;
      }
    }
    // Take-profit tiers (after urgent defensive, before rotation)
    if (action === 'HOLD') {
      for (const p of nonStablePositions) {
        if (p.rsi == null) continue;
        const cb = costBasis[p.sym];
        if (!cb?.cost || cb.cost <= 0 || p.value <= 0) continue;
        const pnlPct = (p.value - cb.cost) / cb.cost * 100;
        const tpSt = loadTpState();
        const state = tpSt[p.sym] || {};
        if (p.rsi > 92) { action = 'SELL'; reason = `${p.sym} TP tier3 RSI=${p.rsi.toFixed(0)}`; tpSell = { sym: p.sym, fraction: 1.0, tier: 'tier92' }; break; }
        if (!state.tier82 && p.rsi > 82 && pnlPct > 0) { action = 'SELL'; reason = `${p.sym} TP tier2 RSI=${p.rsi.toFixed(0)}`; tpSell = { sym: p.sym, fraction: 1/3, tier: 'tier82' }; break; }
        if (!state.tier75 && p.rsi > 75 && pnlPct > 0) { action = 'SELL'; reason = `${p.sym} TP tier1 RSI=${p.rsi.toFixed(0)}`; tpSell = { sym: p.sym, fraction: 1/3, tier: 'tier75' }; break; }
      }
    }
    // Then check rotation before marginal junk sell
    if (action === 'HOLD') {
      const worst = nonStablePositions.reduce((w, p) => {
        if (p.dg) return w;
        return p.score < (w?.score ?? Infinity) ? p : w;
      }, null) || nonStablePositions[0];
      if (worst.dg) { log(`  All positions have divergence, skip rotation`); } else {
      const heldTooShort = holdStart[worst.sym] && Date.now() - holdStart[worst.sym] < HOLD_MIN_MS;
      if (heldTooShort) { log(`  ${worst.sym} held < ${HOLD_MIN_MS/60000}min, skip rotate`); }
      const volMomBoost = a => (a.v !== undefined && a.v > 1.5 && a.m !== undefined && a.m > 0 && (a.r === undefined || a.r < 70)) ? 2 : 0;
      const pumpStart = a => a.v !== undefined && a.v > 2.5 && a.e === 2 && a.d !== undefined && a.d < -10 && (a.r === undefined || a.r < 85);
      const earlyPump = a => a.v !== undefined && a.v > 1.8 && a.e >= 0 && a.ch > 2 && (a.r === undefined || a.r < 80) && a.sc >= 3;
      const pumpQualify = a => pumpStart(a) || earlyPump(a);
      const bestNew = !heldTooShort && ranked.find(a => (buyable(a, failedTokens, routeInv) || divergenceBuyable(a, failedTokens, routeInv) || momentumBuyable(a, failedTokens, routeInv) || pumpStart(a) || earlyPump(a) || accumulationBuyable(a, failedTokens, routeInv)) && a.sym !== 'NEAR' && (a.sc >= 6 || (a.sc >= 5 && a.m !== undefined && a.m >= 2) || pumpStart(a) || earlyPump(a) || a.dg || momentumBuyable(a, failedTokens, routeInv) || accumulationBuyable(a, failedTokens, routeInv)) && (a.m === undefined || a.m >= 0) && (a.v === undefined || a.v === null || a.v <= 3 || pumpQualify(a)) && (a.e === undefined || a.e === null || a.e >= 0) && !nonStablePositions.find(p => p.sym === a.sym) && !raisedSyms[a.sym] && PORTFOLIO.find(p => p.sym === a.sym) && ((a.sc + volMomBoost(a)) >= (worst?.score || 0) + 4));
      if (bestNew) {
        const slotOpen = nonStablePositions.length < MAX_POSITIONS;
        const usdcForBuy = usdcBal?.human || 0;
        const canBuyDirect = slotOpen && (usdcForBuy >= MIN_POSITION_VALUE - 0.50 || nonStablePositions.some(p => p.value >= MIN_POSITION_VALUE - usdcForBuy && p.value >= MIN_TRADE));
        if (!canBuyDirect) { action = 'ROTATE'; reason = `${worst.sym} weakest (sc=${worst.score}), rotate to best buyable`; }
      }
      }
    }
    // Junk sell as last resort (only if no rotation target found)
    if (action === 'HOLD') {
      for (const p of nonStablePositions) {
        if (hasRealScores && p.score < 4 && !p.dg && Date.now() - (junkTimers[p.sym] || 0) >= JUNK_HOLD_MS) { action = 'SELL'; reason = `${p.sym} junk sc=${p.score}`; break; }
      }
    }
    // Risk-off: broad market crash → all to USDC
    if (action === 'HOLD' && fg.v < 30 && downCount > 9) {
      action = 'SELL_ALL'; reason = `Risk-off F&G=${fg.v} down=${downCount}/15`;
    }
  }
  // Daily trade cap — limit new entries to reduce churn (sells still fire)
  const dTrades = loadTradeHistory().filter(t => t.type === 'BUY' && Date.now() - t.ts < 86400000).length;
  if (action === 'HOLD' && dTrades >= MAX_DAILY_TRADES && nonStablePositions.length > 0) {
    reason = `Daily buy limit (${dTrades}/${MAX_DAILY_TRADES}), waiting until tomorrow`;
  }
  // If no sell/rotate and room to buy more
  let buyTargetSym;
  if (action === 'HOLD' && nonStablePositions.length < MAX_POSITIONS && (dTrades < MAX_DAILY_TRADES || nonStablePositions.length === 0)) {
    const heldSyms = new Set(nonStablePositions.map(p => p.sym));
    const pumpStart = a => a.v !== undefined && a.v > 2.5 && a.e === 2 && a.d !== undefined && a.d < -10 && (a.r === undefined || a.r < 85);
    const earlyPump = a => a.v !== undefined && a.v > 1.8 && a.e >= 0 && a.ch > 2 && (a.r === undefined || a.r < 80) && a.sc >= 3;
    const pumpQualify = a => pumpStart(a) || earlyPump(a);
    const candidate = ranked.find(a => (buyable(a, failedTokens, routeInv) || divergenceBuyable(a, failedTokens, routeInv) || momentumBuyable(a, failedTokens, routeInv) || pumpStart(a) || earlyPump(a) || accumulationBuyable(a, failedTokens, routeInv)) && a.sym !== 'NEAR' && (a.sc >= 6 || (a.sc >= 5 && a.m !== undefined && a.m >= 2) || pumpStart(a) || earlyPump(a) || a.dg || momentumBuyable(a, failedTokens, routeInv) || accumulationBuyable(a, failedTokens, routeInv)) && (a.m === undefined || a.m >= 0) && (a.v === undefined || a.v === null || a.v <= 3 || pumpQualify(a)) && (a.e === undefined || a.e === null || a.e >= 0) && !heldSyms.has(a.sym) && !raisedSyms[a.sym] && PORTFOLIO.find(p => p.sym === a.sym));
    const usdcForBuy = usdcBal?.human || 0;
    if (candidate && PORTFOLIO.find(p => p.sym === candidate.sym) && usdcForBuy >= MIN_POSITION_VALUE - 0.50) {
      action = 'BUY'; reason = `Buy ${candidate.sym} (sc=${candidate.sc}) #${nonStablePositions.length + 1}/${MAX_POSITIONS}`; buyTargetSym = candidate.sym;
    } else if (candidate && PORTFOLIO.find(p => p.sym === candidate.sym)) {
      // Fresh route check before selling — cache may be stale
      const buyTarget = buyEntry(candidate.sym);
      const routeOk = buyTarget ? await checkLiquidity(USDC_NEAR, buyTarget.id, Math.floor(MIN_POSITION_VALUE * 1e6).toString()) : false;
      if (routeOk === false) {
        reason = `${candidate.sym} buy route expired (cache stale), skipping`;
      } else if (routeOk === null) {
        reason = `${candidate.sym} buy route check failed (network error), skipping`;
      } else {
        // Check if selling a holding could cover the USDC gap
        const gap = MIN_POSITION_VALUE - usdcForBuy;
        const canSell = nonStablePositions.some(p => !p.dg && p.value >= gap && p.value >= MIN_TRADE && candidate.sc >= (p.score || 0) && !raisedSyms[p.sym]);
        if (canSell) {
          action = 'BUY'; reason = `Buy ${candidate.sym} (sc=${candidate.sc}) #${nonStablePositions.length + 1}/${MAX_POSITIONS} (sell to raise USDC)`; buyTargetSym = candidate.sym;
        } else {
          reason = `${candidate.sym} available but not enough accessible value`;
        }
      }
    } else if (candidate) {
      reason = `${candidate.sym} available but not tradeable`;
    } else if (nonStablePositions.length === 0) {
      reason = 'No positions, waiting for crypto opp (sc≥3 RSI<80)';
    } else {
      const heldSet = new Set(nonStablePositions.map(p => p.sym));
      const details = ranked.filter(a => a.sc >= 3).slice(0, 5).map(a => {
        const why = [];
        if (!PORTFOLIO.find(p => p.sym === a.sym)) why.push('not in list');
        if (routeInv.size > 0 && !routeInv.has(a.sym)) why.push('no route');
        if (a.r !== undefined && a.r >= 80) why.push(`RSI=${a.r.toFixed(0)}≥80`);
        if (failedTokens.has(a.sym)) why.push('failed');
        if (heldSet.has(a.sym)) why.push('held');
        if (raisedSyms[a.sym]) why.push('raised');
        return `${a.sym}(sc=${a.sc})${why.length ? ' {' + why.join(',') + '}' : ''}`;
      }).join('; ');
      reason = `No candidate (top: ${details})`;
    }
  }

  // Top-up: at cap with idle USDC, reinvest in best positions below tier max
  if (action === 'HOLD') {
    const usdcForTopup = usdcBal?.human || 0;
    if (usdcForTopup >= MIN_TRADE) {
      const sortedPos = [...nonStablePositions].sort((a, b) => (b.score || 0) - (a.score || 0));
      const grandTotalT = investableTotal;
      const topupThrottle = loadTopupThrottle();
      for (let i = 0; i < sortedPos.length; i++) {
        const pos = sortedPos[i];
        if (pos.score == null || pos.score < TOPUP_SCORE_MIN) continue;
        if (topupThrottle[pos.sym] && Date.now() - topupThrottle[pos.sym] < TOPUP_THROTTLE_MS) continue;
        if (pos.score < 7) {
          const volOk = pos.vol === undefined || pos.vol === null || pos.vol >= 1.0;
          const momOk = pos.mom === undefined || pos.mom === null || pos.mom >= 0;
          const emaOk = pos.e === undefined || pos.e === null || pos.e >= 0;
          if (!volOk && !momOk && !emaOk) continue;
        }
        const pct = tierPct(i, nonStablePositions.length);
        const maxVal = grandTotalT * pct;
        const room = maxVal - pos.value;
        if (room >= MIN_TRADE) {
          action = 'TOPUP'; reason = `Top up ${pos.sym} (sc=${pos.score}) $${room.toFixed(2)} room to ${(pct*100).toFixed(0)}%`;
          break;
        }
      }
    }
  }
  if (!reason && action === 'HOLD') {
    if (nonStablePositions.length >= MAX_POSITIONS) {
      const worst = nonStablePositions.reduce((w, p) => p.score < (w?.score ?? Infinity) ? p : w, nonStablePositions[0]);
      const bestCandidates = ranked.filter(a => a.sc >= 3 && routeInv.has(a.sym) && !STABLE_SYMS.has(a.sym)).slice(0, 3).map(a => `${a.sym}(sc=${a.sc})`).join(', ') || 'none';
      reason = `At cap ${nonStablePositions.length}/${MAX_POSITIONS} (worst=${worst.sym} sc=${worst.score}) | available: ${bestCandidates}`;
    } else {
      reason = 'No sell/rotate triggers, waiting';
    }
  }

  log(`Decision: ${action} — ${reason}`);

  // Execute
  let lastSwapFee = 0, tradedThisCycle = false;
  let newFailedTokens = new Set();
  if (action !== 'HOLD' && ok && canExec) {
    log('Executing...');

    if (action === 'SELL_ALL') {
      for (const p of nonStablePositions) {
        if (p.value < MIN_TRADE) continue;
        const liq = await checkLiquidity(p.id, USDC_NEAR, p.raw);
        if (liq === false) { log(`  ⚠️ ${p.sym} has no sell route, marking failed`); newFailedTokens.add(p.sym); if (routePrev.has(p.sym)) logRouteChange(p.sym, 'disappeared'); continue; }
        if (liq === null) { log(`  ⚠️ ${p.sym} sell route check failed (network error), skipping`); continue; }
        if (!await validateSell(p.sym, reason, p, fg, pricedPositions, holdStart)) { log(`  Skipped (AI rejected)`); if (reason.includes('junk')) { junkTimers[p.sym] = Date.now(); log(`  ${p.sym} junk timer reset (AI rejected)`); } continue; }
        log(`Sell ${p.sym}→USDC...`);
        const r = await execSwap(p, { id: USDC_NEAR, sym: 'USDC', dec: 6 }, p.raw, env.pk, assets);
        tradedThisCycle = true; lastSwapFee = r.feeUsd || 0;
        if (r?.ok) {
          const sellBi = bals.findIndex(b => b.sym === p.sym);
          if (sellBi >= 0) bals[sellBi].human = 0;
          const usdcBi = bals.findIndex(b => b.sym === 'USDC');
          if (usdcBi >= 0 && r.out) bals[usdcBi].human += Number(r.out);
          const scb = costBasis[p.sym];
          if (scb?.cost && r.out) {
            const sp = Number(r.out);
            const spnl = sp - scb.cost;
            log(`  ✅ Sold ${p.sym} → ${r.out} USDC (${spnl >= 0 ? '+' : ''}$${spnl.toFixed(2)}, ${spnl >= 0 ? '+' : ''}${(spnl / scb.cost * 100).toFixed(1)}%) [spread ${r.spread?.toFixed(2) || 0}%${(r.feeUsd || 0) > 0 ? `, fee $${r.feeUsd.toFixed(4)}` : ''}]`);
            recordTrade('SELL', p.sym, sp, spnl, spnl / scb.cost * 100, 'risk-off', p.score);
          }
          delete costBasis[p.sym]; delete junkTimers[p.sym]; delete obTimers[p.sym]; saveCostBasis(costBasis); const tpStSa = loadTpState(); if (tpStSa[p.sym]) { delete tpStSa[p.sym]; saveTpState(tpStSa); } delete holdStart[p.sym]; markTrade(); break;
        }
        else log(`  Sell skipped (spread ${r?.spread?.toFixed(1) || '?'}%)`);
      }
    } else if (action === 'SELL') {
      const p = nonStablePositions.find(x => reason.startsWith(x.sym));
      if (p) {
        const isTpPartial = tpSell?.sym === p.sym && tpSell.fraction > 0 && tpSell.fraction < 1.0;
        const rawToSell = isTpPartial
          ? (BigInt(p.raw) * BigInt(Math.round(tpSell.fraction * 1e12)) / 1000000000000n).toString()
          : p.raw;
        if (isTpPartial && BigInt(rawToSell) <= 0n) { log(`  TP fraction too small, skipping`); }
        else {
        const liq = await checkLiquidity(p.id, USDC_NEAR, rawToSell);
        if (liq === false) { log(`  ⚠️ ${p.sym} has no sell route, skipping`); newFailedTokens.add(p.sym); if (routePrev.has(p.sym)) logRouteChange(p.sym, 'disappeared'); }
        else if (liq === null) { log(`  ⚠️ ${p.sym} sell route check failed (network error), skipping`); }
        else {
          if (!await validateSell(p.sym, reason, p, fg, pricedPositions, holdStart)) { log(`  Skipped (AI rejected)`); if (reason.includes('junk')) { junkTimers[p.sym] = Date.now(); log(`  ${p.sym} junk timer reset (AI rejected)`); } } else {
          log(`Sell ${p.sym}→USDC...`);
          const r = await execSwap(p, { id: USDC_NEAR, sym: 'USDC', dec: 6 }, rawToSell, env.pk, assets);
          tradedThisCycle = true; lastSwapFee = r.feeUsd || 0;
          if (r?.ok) {
            if (isTpPartial) {
              const rawSell = BigInt(rawToSell);
              const rawTotal = BigInt(p.raw);
              const rawRemaining = rawTotal - rawSell;
              const rawRemainingStr = rawRemaining.toString();
              const sellDec = PORTFOLIO.find(x => x.sym === p.sym)?.dec || 18;
              const usdcBi = bals.findIndex(b => b.sym === 'USDC');
              if (usdcBi >= 0 && r.out) bals[usdcBi].human += Number(r.out);
              const sellBi = bals.findIndex(b => b.sym === p.sym);
              if (sellBi >= 0) { bals[sellBi].raw = rawRemainingStr; bals[sellBi].human = Number(rawRemaining) / 10 ** sellDec; }
              const nsIdx = nonStablePositions.findIndex(x => x.sym === p.sym);
              if (nsIdx >= 0) { nonStablePositions[nsIdx].raw = rawRemainingStr; nonStablePositions[nsIdx].human = Number(rawRemaining) / 10 ** sellDec; }
              if (costBasis[p.sym]) {
                const digits = rawTotal.toString().length;
                const scale = 10n ** BigInt(Math.max(0, digits - 12));
                const rawSellScaled = Number(rawSell / scale);
                const rawTotalScaled = Number(rawTotal / scale);
                const soldFrac = rawTotalScaled > 0 ? rawSellScaled / rawTotalScaled : 0;
                const soldCost = costBasis[p.sym].cost * soldFrac;
                const proceeds = Number(r.out) || 0;
                const pnl = proceeds - soldCost;
                log(`  ✅ TP partial ${p.sym} → ${r.out} USDC (${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}) [spread ${r.spread?.toFixed(2) || 0}%${(r.feeUsd || 0) > 0 ? `, fee $${r.feeUsd.toFixed(4)}` : ''}]`);
                recordTrade('SELL', p.sym, proceeds, pnl, soldCost > 0 ? pnl / soldCost * 100 : 0, reason.split(' ').slice(1).join(' '), p.score);
                costBasis[p.sym].cost *= (1 - soldFrac);
                costBasis[p.sym].qty *= (1 - soldFrac);
                saveCostBasis(costBasis);
              }
              const tpSt = loadTpState();
              tpSt[p.sym] = { ...(tpSt[p.sym] || {}), [tpSell.tier]: true };
              saveTpState(tpSt);
            } else {
              const sellBi = bals.findIndex(b => b.sym === p.sym);
              if (sellBi >= 0) bals[sellBi].human = 0;
              const usdcBi = bals.findIndex(b => b.sym === 'USDC');
              if (usdcBi >= 0 && r.out) bals[usdcBi].human += Number(r.out);
              const scb2 = costBasis[p.sym];
              if (scb2?.cost && r.out) {
                const sp2 = Number(r.out);
                const spnl2 = sp2 - scb2.cost;
                log(`  ✅ Sold ${p.sym} → ${r.out} USDC (${spnl2 >= 0 ? '+' : ''}$${spnl2.toFixed(2)}, ${spnl2 >= 0 ? '+' : ''}${(spnl2 / scb2.cost * 100).toFixed(1)}%) [spread ${r.spread?.toFixed(2) || 0}%${(r.feeUsd || 0) > 0 ? `, fee $${r.feeUsd.toFixed(4)}` : ''}]`);
                recordTrade('SELL', p.sym, sp2, spnl2, spnl2 / scb2.cost * 100, reason.split(' ').slice(1).join(' '), p.score);
              }
              delete costBasis[p.sym]; delete junkTimers[p.sym]; delete obTimers[p.sym]; saveCostBasis(costBasis); const tpSf = loadTpState(); if (tpSf[p.sym]) { delete tpSf[p.sym]; saveTpState(tpSf); } delete holdStart[p.sym];
            }
          }
          if (!r?.ok) log(`  Sell skipped (spread ${r?.spread?.toFixed(1) || '?'}%)`);
          }
        }
        }
      }
    } else if (action === 'REBALANCE') {
      const p = nonStablePositions.find(x => reason.startsWith(x.sym));
      if (p) {
        const rebalSorted = [...nonStablePositions].sort((a, b) => (b.score || 0) - (a.score || 0));
        const rebalRank = rebalSorted.findIndex(x => x.sym === p.sym);
        const rebalTier = tierPct(rebalRank >= 0 ? Math.min(rebalRank, 2) : 2, nonStablePositions.length);
        const liq = await checkLiquidity(p.id, USDC_NEAR, p.raw);
        if (liq === false) { log(`  ⚠️ ${p.sym} has no sell route, cannot rebalance`); newFailedTokens.add(p.sym); if (routePrev.has(p.sym)) logRouteChange(p.sym, 'disappeared'); }
        else if (liq === null) { log(`  ⚠️ ${p.sym} sell route check failed (network error), cannot rebalance`); }
        else {
          const heldSyms = new Set(nonStablePositions.map(x => x.sym));
          let buyBest = null;
          for (const best of ranked) {
        if (!(best.sc >= 6 || (best.sc >= 5 && best.m !== undefined && best.m >= 2))) {
          if (!best.dg || best.sc < 5) break;
        }
            if ((!buyable(best, failedTokens, routeInv) && !divergenceBuyable(best, failedTokens, routeInv)) || best.sym === p.sym || raisedSyms[best.sym]) continue;
            if (heldSyms.has(best.sym)) {
              const curVal = nonStablePositions.find(x => x.sym === best.sym)?.value || 0;
              const grandTotal = investableTotal;
              const sorted = [...nonStablePositions].sort((a, b) => (b.score || 0) - (a.score || 0));
              const rankIdx = sorted.findIndex(x => x.sym === best.sym);
              const maxPct = tierPct(rankIdx, nonStablePositions.length);
              const maxAllowed = grandTotal * maxPct;
              if (curVal >= maxAllowed) continue;
            }
            const target = buyEntry(best.sym);
            if (!target) continue;
            const est = Math.floor(Math.max(MIN_POSITION_VALUE, (usdcBal?.human || 0) * 0.3) * 1e6).toString();
            const routeOk = await checkLiquidity(USDC_NEAR, target.id, est);
            if (routeOk) { buyBest = best; break; }
            log(`  ⚠️ ${best.sym} no buy route, skipping`);
          }
          if (!buyBest) {
            log(`  No buyable target found, rebalance skipped`);
          } else {
            if (!await validateSell(p.sym, reason, p, fg, pricedPositions, holdStart)) { log(`  Rebalance skipped (AI rejected)`); } else {
            log(`Rebalance ${p.sym}→USDC...`);
            const r = await execSwap(p, { id: USDC_NEAR, sym: 'USDC', dec: 6 }, p.raw, env.pk, assets);
            tradedThisCycle = true; lastSwapFee = r.feeUsd || 0;
            if (r?.ok) {
              const outUsd = r.out ? Number(r.out) : (p.value * (1 - (r.spread || 0) / 100));
              usdcBal = { human: usdcBal ? usdcBal.human + outUsd : outUsd };
              const idx = nonStablePositions.findIndex(x => x.sym === p.sym);
              if (idx >= 0) nonStablePositions.splice(idx, 1);
              const sellBi2 = bals.findIndex(b => b.sym === p.sym);
              if (sellBi2 >= 0) bals[sellBi2].human = 0;
              const usdcBi2 = bals.findIndex(b => b.sym === 'USDC');
              if (usdcBi2 >= 0 && r.out) bals[usdcBi2].human += Number(r.out);
              const scbR = costBasis[p.sym];
              if (scbR?.cost && r.out) {
                const spR = Number(r.out);
                const spnlR = spR - scbR.cost;
                log(`  ✅ Sold ${p.sym} → ${r.out} USDC (${spnlR >= 0 ? '+' : ''}$${spnlR.toFixed(2)}, ${spnlR >= 0 ? '+' : ''}${(spnlR / scbR.cost * 100).toFixed(1)}%) [spread ${r.spread?.toFixed(2) || 0}%${(r.feeUsd || 0) > 0 ? `, fee $${r.feeUsd.toFixed(4)}` : ''}]`);
                recordTrade('SELL', p.sym, spR, spnlR, spnlR / scbR.cost * 100, 'rebalance', p.score);
              }
              raisedSyms[p.sym] = Date.now();
              saveRaisedSyms(raisedSyms);
              delete costBasis[p.sym];
              delete junkTimers[p.sym]; delete obTimers[p.sym];
              saveCostBasis(costBasis);
              const tpStRb = loadTpState(); if (tpStRb[p.sym]) { delete tpStRb[p.sym]; saveTpState(tpStRb); }
              const target = buyEntry(buyBest.sym);
              if (target && usdcBal.human >= MIN_POSITION_VALUE) {
                const grandTotal = investableTotal;
                let buyUsd = Math.max(MIN_POSITION_VALUE, Math.min(usdcBal.human, grandTotal * rebalTier));
                const amt2 = Math.floor(buyUsd * 1e6);
                if (amt2 >= Math.floor(MIN_POSITION_VALUE * 1e6)) {
                  log(`Rebalance into ${buyBest.sym} $${buyUsd.toFixed(2)} (#${nonStablePositions.length + 1}/${MAX_POSITIONS})...`);
                  const r2 = await execSwap({ id: USDC_NEAR, sym: 'USDC', dec: 6 }, target, amt2.toString(), env.pk, assets);
                  tradedThisCycle = true; lastSwapFee = (lastSwapFee || 0) + (r2.feeUsd || 0);
                  if (r2?.ok) {
                    const usdcBi3 = bals.findIndex(b => b.sym === 'USDC');
                    if (usdcBi3 >= 0) bals[usdcBi3].human -= buyUsd;
                    const buyBi = bals.findIndex(b => b.sym === buyBest.sym);
                    if (buyBi >= 0 && r2.out) bals[buyBi].human += Number(r2.out);
                    raisedSyms[buyBest.sym] = Date.now();
                    saveRaisedSyms(raisedSyms);
                    const prevRb = costBasis[buyBest.sym];
                    const outRb = Number(r2.out) || 0;
                    costBasis[buyBest.sym] = {
                      cost: (prevRb?.cost || 0) + buyUsd,
                      spread: prevRb ? ((prevRb.cost * (prevRb.spread || 0) + buyUsd * (r2?.spread || 0)) / (prevRb.cost + buyUsd)) : (r2?.spread || 0),
                      fee: (prevRb?.fee || 0) + (r2?.feeUsd || 0),
                      qty: (prevRb?.qty || 0) + outRb,
                      price: outRb > 0 ? buyUsd / outRb : (prevRb?.price || 0),
                    };
                    saveCostBasis(costBasis);
                    markTrade();
                    log(`  ✅ Rebalance complete: ${p.sym}→${buyBest.sym}`);
                    recordTrade('BUY', buyBest.sym, buyUsd, null, null, 'rebalance', buyBest.sc);
                  }
                }
              }
            } else {
              log(`  Rebalance skipped (spread ${r?.spread?.toFixed(1) || '?'}%)`);
            }
            }
          }
        }
      }
    } else if (action === 'ROTATE') {
      const worst = nonStablePositions.reduce((w, p) => p.score < (w?.score ?? Infinity) ? p : w, nonStablePositions[0]);
      const worstSorted = [...nonStablePositions].sort((a, b) => (b.score || 0) - (a.score || 0));
      const worstRank = worstSorted.findIndex(p => p.sym === worst.sym);
      const worstTier = tierPct(worstRank >= 0 ? Math.min(worstRank, 2) : 2, nonStablePositions.length);
      const liq = await checkLiquidity(worst.id, USDC_NEAR, worst.raw);
      if (liq === false) { log(`  ⚠️ ${worst.sym} has no sell route, cannot rotate`); newFailedTokens.add(worst.sym); if (routePrev.has(worst.sym)) logRouteChange(worst.sym, 'disappeared'); }
      else if (liq === null) { log(`  ⚠️ ${worst.sym} sell route check failed (network error), cannot rotate`); }
      else {
        const heldSyms = new Set(nonStablePositions.map(p => p.sym));
        let buyBest = null;
        for (const best of ranked) {
          if (!(best.sc >= 6 || (best.sc >= 5 && best.m !== undefined && best.m >= 2))) break;
          if (!buyable(best, failedTokens, routeInv) || raisedSyms[best.sym]) continue;
          if (best.sym === worst.sym) continue;
          if (heldSyms.has(best.sym)) {
            const curVal = nonStablePositions.find(p => p.sym === best.sym)?.value || 0;
            const grandTotal = investableTotal;
            const sorted = [...nonStablePositions].sort((a, b) => (b.score || 0) - (a.score || 0));
            const rankIdx = sorted.findIndex(p => p.sym === best.sym);
            const maxPct = tierPct(rankIdx, nonStablePositions.length);
            const maxAllowed = grandTotal * maxPct;
            if (curVal >= maxAllowed) continue;
          }
          const target = buyEntry(best.sym);
          if (!target) continue;
          const est = Math.floor(Math.max(MIN_POSITION_VALUE, (usdcBal?.human || 0) * 0.3) * 1e6).toString();
          const routeOk = await checkLiquidity(USDC_NEAR, target.id, est);
          if (routeOk) { buyBest = best; break; }
          log(`  ⚠️ ${best.sym} no buy route, skipping`);
        }
        // Quality check: for sc < 7, require vol > 1.0 or mom > 0 or ema >= 0
        if (buyBest && buyBest.sc < 7) {
          const volOk = buyBest.v === undefined || buyBest.v === null || buyBest.v >= 1.0;
          const momOk = buyBest.m === undefined || buyBest.m === null || buyBest.m > 0;
          const emaOk = buyBest.e === undefined || buyBest.e === null || buyBest.e >= 0;
          if (!volOk && !momOk && !emaOk) {
            log(`  ${buyBest.sym} quality check failed (VOL=${buyBest.v?.toFixed(1)||'?'} MOM=${buyBest.m??'?'} EMA=${buyBest.e??'?'}), fallback to USDC`);
            buyBest = null;
          }
        }
        if (!buyBest) {
          // Fallback: no good rotation target, sell weakest to USDC
          if (!await validateSell(worst.sym, reason, worst, fg, pricedPositions, holdStart)) { log(`  Rotate→USDC skipped (AI rejected)`); } else {
          log(`Rotate→USDC: sell ${worst.sym} (no good rotation target)...`);
          const r = await execSwap(worst, { id: USDC_NEAR, sym: 'USDC', dec: 6 }, worst.raw, env.pk, assets);
          tradedThisCycle = true; lastSwapFee = r.feeUsd || 0;
          if (r?.ok) {
            const outUsd = r.out ? Number(r.out) : (worst.value * (1 - (r.spread || 0) / 100));
            usdcBal = { human: usdcBal ? usdcBal.human + outUsd : outUsd };
            const idx = nonStablePositions.findIndex(p => p.sym === worst.sym);
            if (idx >= 0) nonStablePositions.splice(idx, 1);
            const sellRBi = bals.findIndex(b => b.sym === worst.sym);
            if (sellRBi >= 0) bals[sellRBi].human = 0;
            const usdcRBi = bals.findIndex(b => b.sym === 'USDC');
            if (usdcRBi >= 0 && r.out) bals[usdcRBi].human += Number(r.out);
            const scbRo = costBasis[worst.sym];
            if (scbRo?.cost && r.out) {
              const spRo = Number(r.out);
              const spnlRo = spRo - scbRo.cost;
              log(`  ✅ Sold ${worst.sym} → ${r.out} USDC (${spnlRo >= 0 ? '+' : ''}$${spnlRo.toFixed(2)}, ${spnlRo >= 0 ? '+' : ''}${(spnlRo / scbRo.cost * 100).toFixed(1)}%) [spread ${r.spread?.toFixed(2) || 0}%${(r.feeUsd || 0) > 0 ? `, fee $${r.feeUsd.toFixed(4)}` : ''}]`);
              recordTrade('SELL', worst.sym, spRo, spnlRo, spnlRo / scbRo.cost * 100, 'rotate-usdc', worst.score);
            }
            raisedSyms[worst.sym] = Date.now();
            saveRaisedSyms(raisedSyms);
            delete costBasis[worst.sym];
            delete junkTimers[worst.sym]; delete obTimers[worst.sym];
            saveCostBasis(costBasis);
            const tpStRo = loadTpState(); if (tpStRo[worst.sym]) { delete tpStRo[worst.sym]; saveTpState(tpStRo); }
            delete holdStart[worst.sym];
            markTrade();
            log(`  ✅ Rotate→USDC complete: ${worst.sym} → USDC`);
          } else {
            log(`  Rotate→USDC skipped (spread ${r?.spread?.toFixed(1) || '?'}%)`);
          }
          }
        } else {
          const buyTarget = buyEntry(buyBest.sym);
          if (!buyTarget) {
            log(`  ⚠️ ${buyBest.sym} not buyable, rotate skipped`);
          } else {
            if (!await validateSell(worst.sym, reason, worst, fg, pricedPositions, holdStart)) { log(`  Rotate skipped (AI rejected)`); } else {
            log(`Rotate ${worst.sym}→USDC...`);
            const r = await execSwap(worst, { id: USDC_NEAR, sym: 'USDC', dec: 6 }, worst.raw, env.pk, assets);
            tradedThisCycle = true; lastSwapFee = r.feeUsd || 0;
            if (r?.ok) {
              const outUsd = r.out ? Number(r.out) : (worst.value * (1 - (r.spread || 0) / 100));
              usdcBal = { human: usdcBal ? usdcBal.human + outUsd : outUsd };
              const idx = nonStablePositions.findIndex(p => p.sym === worst.sym);
              if (idx >= 0) nonStablePositions.splice(idx, 1);
              const sellRBi = bals.findIndex(b => b.sym === worst.sym);
              if (sellRBi >= 0) bals[sellRBi].human = 0;
              const usdcRBi = bals.findIndex(b => b.sym === 'USDC');
              if (usdcRBi >= 0 && r.out) bals[usdcRBi].human += Number(r.out);
              const scbRo = costBasis[worst.sym];
              if (scbRo?.cost && r.out) {
                const spRo = Number(r.out);
                const spnlRo = spRo - scbRo.cost;
                log(`  ✅ Sold ${worst.sym} → ${r.out} USDC (${spnlRo >= 0 ? '+' : ''}$${spnlRo.toFixed(2)}, ${spnlRo >= 0 ? '+' : ''}${(spnlRo / scbRo.cost * 100).toFixed(1)}%) [spread ${r.spread?.toFixed(2) || 0}%${(r.feeUsd || 0) > 0 ? `, fee $${r.feeUsd.toFixed(4)}` : ''}]`);
                recordTrade('SELL', worst.sym, spRo, spnlRo, spnlRo / scbRo.cost * 100, 'rotate', worst.score);
              }
              raisedSyms[worst.sym] = Date.now();
              saveRaisedSyms(raisedSyms);
              delete costBasis[worst.sym];
              delete junkTimers[worst.sym]; delete obTimers[worst.sym];
              saveCostBasis(costBasis);
              const tpStRo = loadTpState(); if (tpStRo[worst.sym]) { delete tpStRo[worst.sym]; saveTpState(tpStRo); }
              delete holdStart[worst.sym];
              const target = buyEntry(buyBest.sym);
              if (target && usdcBal.human >= MIN_POSITION_VALUE) {
                const grandTotal = investableTotal;
                let buyUsd = Math.max(MIN_POSITION_VALUE, Math.min(usdcBal.human, grandTotal * worstTier));
                const amt2 = Math.floor(buyUsd * 1e6);
                if (amt2 >= Math.floor(MIN_POSITION_VALUE * 1e6)) {
                  log(`Rotate into ${buyBest.sym} $${buyUsd.toFixed(2)} (#${nonStablePositions.length + 1}/${MAX_POSITIONS})...`);
                  const r2 = await execSwap({ id: USDC_NEAR, sym: 'USDC', dec: 6 }, target, amt2.toString(), env.pk, assets);
                  tradedThisCycle = true; lastSwapFee = (lastSwapFee || 0) + (r2.feeUsd || 0);
                  if (r2?.ok) {
                    const usdcRBi2 = bals.findIndex(b => b.sym === 'USDC');
                    if (usdcRBi2 >= 0) bals[usdcRBi2].human -= buyUsd;
                    const buyRBi = bals.findIndex(b => b.sym === buyBest.sym);
                    if (buyRBi >= 0 && r2.out) bals[buyRBi].human += Number(r2.out);
                    raisedSyms[buyBest.sym] = Date.now();
                    saveRaisedSyms(raisedSyms);
                    const prevRt = costBasis[buyBest.sym];
                    const outRt = Number(r2.out) || 0;
                    costBasis[buyBest.sym] = {
                      cost: (prevRt?.cost || 0) + buyUsd,
                      spread: prevRt ? ((prevRt.cost * (prevRt.spread || 0) + buyUsd * (r2?.spread || 0)) / (prevRt.cost + buyUsd)) : (r2?.spread || 0),
                      fee: (prevRt?.fee || 0) + (r2?.feeUsd || 0),
                      qty: (prevRt?.qty || 0) + outRt,
                      price: outRt > 0 ? buyUsd / outRt : (prevRt?.price || 0),
                    };
                    saveCostBasis(costBasis);
                    markTrade();
                    holdStart[buyBest.sym] = Date.now();
                    log(`  ✅ Rotate complete: ${worst.sym}→${buyBest.sym}`);
                    recordTrade('BUY', buyBest.sym, buyUsd, null, null, 'rotate', buyBest.sc);
                  }
                }
              }
            } else {
              log(`  Rotate skipped (spread ${r?.spread?.toFixed(1) || '?'}%)`);
            }
            }
          }
        }
      }
    } else if (action === 'BUY') {
      let soldSyms = new Set();
      if ((!usdcBal || usdcBal.human < MIN_POSITION_VALUE - 0.50) && nonStablePositions.length > 0) {
        const slotIdxR = Math.min(nonStablePositions.length, 2);
        const grandTotalR = investableTotal;
        const targetBuyUsd = Math.max(MIN_POSITION_VALUE, grandTotalR * tierPct(slotIdxR, nonStablePositions.length + 1));
        const shortfall = Math.max(0, targetBuyUsd - (usdcBal?.human || 0));
        const sellCandidates = [...nonStablePositions].filter(p => !raisedSyms[p.sym] && (!holdStart[p.sym] || Date.now() - holdStart[p.sym] >= HOLD_MIN_MS)).sort((a, b) => (a.score || 999) - (b.score || 999) || (b.rsi || 0) - (a.rsi || 0));
        for (const sellP of sellCandidates) {
          if (sellP.value < MIN_TRADE) continue;
          const sellPrice = assets[sellP.sym]?.p || 0;
          const sellDec = PORTFOLIO.find(p => p.sym === sellP.sym)?.dec || 18;
          const isFullSell = shortfall <= 0 || shortfall >= sellP.value || sellPrice <= 0;
          let rawToSell = sellP.raw;
          if (!isFullSell) {
            const rawNeeded = BigInt(Math.floor((shortfall / sellPrice) * 10 ** sellDec));
            rawToSell = rawNeeded > BigInt(sellP.raw) ? sellP.raw : rawNeeded.toString();
            if (BigInt(rawToSell) < BigInt(Math.floor(0.5 * 1e6))) continue;
          }
          const liq = await checkLiquidity(sellP.id, USDC_NEAR, rawToSell);
          if (liq === false) { log(`  ⚠️ ${sellP.sym} no sell route, cannot raise USDC`); continue; }
          else if (liq === null) { log(`  ⚠️ ${sellP.sym} sell route check failed (network error), cannot raise USDC`); continue; }
          if (!await validateSell(sellP.sym, 'raise USDC (' + (buyTargetSym || '?') + ')', sellP, fg, pricedPositions, holdStart)) { log(`  Raise USDC skipped (AI rejected)`); continue; }
          log(`  Raise USDC: sell ${sellP.sym} ($${isFullSell ? sellP.value.toFixed(2) : shortfall.toFixed(2)})...`);
          const r = await execSwap(sellP, { id: USDC_NEAR, sym: 'USDC', dec: 6 }, rawToSell, env.pk, assets);
          tradedThisCycle = true; lastSwapFee = (lastSwapFee || 0) + (r.feeUsd || 0);
          if (r?.ok) {
            const outUsd = r.out ? Number(r.out) : (isFullSell ? sellP.value : shortfall) * (1 - (r.spread || 0) / 100);
            usdcBal = { human: usdcBal ? usdcBal.human + outUsd : outUsd };
            const sellBu = bals.findIndex(b => b.sym === sellP.sym);
            if (isFullSell) {
              const scbFS = costBasis[sellP.sym];
              if (scbFS?.cost && r.out) {
                const proceedsFs = Number(r.out);
                const pnlFs = proceedsFs - scbFS.cost;
                log(`  ✅ Sold ${sellP.sym} → ${r.out} USDC (${pnlFs >= 0 ? '+' : ''}$${pnlFs.toFixed(2)}, ${pnlFs >= 0 ? '+' : ''}${(pnlFs / scbFS.cost * 100).toFixed(1)}%) [spread ${r.spread?.toFixed(2) || 0}%${(r.feeUsd || 0) > 0 ? `, fee $${r.feeUsd.toFixed(4)}` : ''}]`);
                recordTrade('SELL', sellP.sym, proceedsFs, pnlFs, pnlFs / scbFS.cost * 100, 'raise USDC', sellP.score);
              }
              const idx = nonStablePositions.findIndex(p => p.sym === sellP.sym);
              if (idx >= 0) nonStablePositions.splice(idx, 1);
              if (sellBu >= 0) bals[sellBu].human = 0;
              soldSyms.add(sellP.sym);
              raisedSyms[sellP.sym] = Date.now();
              saveRaisedSyms(raisedSyms);
              delete costBasis[sellP.sym];
              delete junkTimers[sellP.sym]; delete obTimers[sellP.sym];
              saveCostBasis(costBasis);
              const tpStRa = loadTpState(); if (tpStRa[sellP.sym]) { delete tpStRa[sellP.sym]; saveTpState(tpStRa); }
              delete holdStart[sellP.sym];
            } else {
              const originalRawTotal = BigInt(sellP.raw);
              if (costBasis[sellP.sym]) {
                const rawSellNum = BigInt(rawToSell);
                const digits = originalRawTotal.toString().length;
                const scale = 10n ** BigInt(Math.max(0, digits - 12));
                const rawSellScaled = Number(rawSellNum / scale);
                const rawTotalScaled = Number(originalRawTotal / scale);
                const soldFrac = rawTotalScaled > 0 ? rawSellScaled / rawTotalScaled : 0;
                const soldCost = costBasis[sellP.sym].cost * soldFrac;
                const proceedsPs = Number(r.out) || 0;
                const pnlPs = proceedsPs - soldCost;
                log(`  ✅ Sold partial ${sellP.sym} → ${r.out} USDC (${pnlPs >= 0 ? '+' : ''}$${pnlPs.toFixed(2)}, ${pnlPs >= 0 ? '+' : ''}${(pnlPs / (soldCost || 1) * 100).toFixed(1)}%) [spread ${r.spread?.toFixed(2) || 0}%${(r.feeUsd || 0) > 0 ? `, fee $${r.feeUsd.toFixed(4)}` : ''}]`);
                recordTrade('SELL', sellP.sym, proceedsPs, pnlPs, soldCost > 0 ? pnlPs / soldCost * 100 : 0, 'raise USDC (partial)', sellP.score);
                costBasis[sellP.sym].cost *= (1 - soldFrac);
                costBasis[sellP.sym].qty *= (1 - soldFrac);
                saveCostBasis(costBasis);
              }
              if (sellBu >= 0) {
                const rawRemaining = originalRawTotal - BigInt(rawToSell);
                bals[sellBu].raw = rawRemaining.toString();
                bals[sellBu].human = Number(rawRemaining) / 10 ** sellDec;
                const nsp = nonStablePositions.find(p => p.sym === sellP.sym);
                if (nsp) { nsp.raw = bals[sellBu].raw; nsp.human = bals[sellBu].human; }
              }
            }
            const usdcBu = bals.findIndex(b => b.sym === 'USDC');
            if (usdcBu >= 0 && r.out) bals[usdcBu].human += Number(r.out);
            log(`  USDC raised to $${usdcBal.human.toFixed(2)}`);
          } else {
            log(`  Raise USDC failed for ${sellP.sym}${r ? ' (spread ' + r.spread?.toFixed(1) + '%)' : ''}`);
            raisedSyms[sellP.sym] = Date.now(); saveRaisedSyms(raisedSyms);
          }
          break;
        }
      }
      if (!usdcBal || usdcBal.human < MIN_POSITION_VALUE - 0.50) {
        action = 'HOLD';
      }
      const heldSyms = new Set([...nonStablePositions.map(p => p.sym), ...soldSyms]);
      const aiRejected = new Set();
      // Try the decision's candidate first, fall back to ranked scan
      const pumpStart = a => a.v !== undefined && a.v > 2.5 && a.e === 2 && a.d !== undefined && a.d < -10 && (a.r === undefined || a.r < 85);
      const earlyPump = a => a.v !== undefined && a.v > 1.8 && a.e >= 0 && a.ch > 2 && (a.r === undefined || a.r < 80) && a.sc >= 3;
      const pumpQualify = a => pumpStart(a) || earlyPump(a);
      async function tryBuy(sym) {
        const best = ranked.find(a => a.sym === sym);
        if (!best) return false;
        const buyableOk = buyable(best, failedTokens, routeInv) || divergenceBuyable(best, failedTokens, routeInv) || momentumBuyable(best, failedTokens, routeInv) || pumpStart(best) || earlyPump(best) || accumulationBuyable(best, failedTokens, routeInv);
        const qualityOk = best.sc >= 6 || (best.sc >= 5 && best.m !== undefined && best.m >= 2) || pumpStart(best) || earlyPump(best) || best.dg || momentumBuyable(best, failedTokens, routeInv) || accumulationBuyable(best, failedTokens, routeInv);
        if (!buyableOk) { log(`  ⏭️ ${sym} not buyable (sc=${best.sc}, vs=${best.vs != null ? best.vs.toFixed(1) : '?'}, m=${best.m ?? '?'}, e=${best.e ?? '?'})`); return false; }
        if (!qualityOk) { log(`  ⏭️ ${sym} fails quality gate (sc=${best.sc}, m=${best.m ?? '?'}, dg=${best.dg ? 'Y' : 'N'})`); return false; }
        if (raisedSyms[best.sym]) { log(`  ⏭️ ${sym} recently raised, skipping`); return false; }
        if (heldSyms.has(best.sym)) { log(`  ⏭️ ${sym} already held`); return false; }
        const target = buyEntry(best.sym);
        if (!target) { log(`  ⏭️ ${sym} not in portfolio`); return false; }
        if (!usdcBal || usdcBal.human < MIN_POSITION_VALUE - 0.50) { log(`  ⏭️ ${sym} insufficient USDC ($${usdcBal?.human?.toFixed(2) || 0})`); return false; }
        const slotIdx = Math.min(nonStablePositions.length, 2);
        const grandTotal = investableTotal;
        const isMomBuy = momentumBuyable(best, failedTokens, routeInv) && !buyable(best, failedTokens, routeInv);
        const isAccumBuy = accumulationBuyable(best, failedTokens, routeInv) && !buyable(best, failedTokens, routeInv) && !momentumBuyable(best, failedTokens, routeInv);
        let buyUsd = Math.max(MIN_POSITION_VALUE - 0.50, Math.min(usdcBal.human, grandTotal * (isMomBuy || isAccumBuy ? 0.25 : tierPct(slotIdx, nonStablePositions.length + 1))));
        const amt = Math.floor(buyUsd * 1e6);
        if (amt < Math.floor((MIN_POSITION_VALUE - 0.50) * 1e6)) { log(`  ⏭️ ${sym} amount too small ($${buyUsd.toFixed(2)})`); return false; }
        const liq = await checkLiquidity(USDC_NEAR, target.id, amt.toString());
        if (liq !== true) { if (liq === false) { log(`  ⚠️ ${sym} no buy route`); newFailedTokens.add(sym); if (routePrev.has(sym)) logRouteChange(sym, 'disappeared'); } else if (liq === null) { log(`  ⚠️ ${sym} buy route check failed (network error), skipping`); } return false; }
        const sellCheck = await checkLiquidity(target.id, USDC_NEAR, '1' + '0'.repeat(target.dec));
        if (sellCheck !== true) { routeHealth.push({ t: sym, buy: true, sell: sellCheck === null ? null : false, note: sellCheck === null ? 'buy-check: sell route network error' : 'buy-check: no sell route' }); log(`  ⚠️ ${sym} no sell route, skipping buy`); if (sellCheck === false) { newFailedTokens.add(sym); if (routePrev.has(sym)) logRouteChange(sym, 'disappeared'); } return false; }
        routeHealth.push({ t: sym, buy: true, sell: true, note: 'buy-check: both routes ok' });
        // AI validation
        const ruleTriggered = earlyPump(best) || pumpStart(best);
        if (deepseek.hasKey()) {
          const aiMsg = [
             { role: 'system', content: 'You are a crypto trading assistant for a momentum/scoring strategy. Validate whether buying the given token is a good idea. Our buy signals: (1) high score (sc>=7), (2) earlyPump (VOL>1.8x or VS>2x, EMA>=0, 24h>2%), (3) pumpStart (heavy VOL>2.5x or VS>2.5x, EMA=+2, deep dip), (4) strong trend (sc>=6, EMA>=+1, PD<-5% dip in uptrend), (5) momentum entry (sc>=3, VOL>1x, MOM>0, EMA>=0 - partial position at 25% capital). CRITICAL RULES: Normal entries require sc>=5. Momentum entries (sc>=3 with VOL>1x, MOM>0, EMA>=0) are allowed as partial positions. For sc>=6 tokens: volume spike (VS) and positive momentum (MOM) are NOT required — the strong daily score already confirms quality; trust the trend, especially on dips (PD negative) with EMA>=+1. For sc<6 tokens: VS>1.5x and MOM>0 are still required. divergence=YES is a STRONG CONFIRMATION (price lower low + RSI higher low over last 10 candles). divergence=NO is acceptable for sc>=6 tokens with strong EMA or momentum. AVOID: Tokens with sc<5 (unless momentum entry criteria met). Tokens with no route, failing fundamentals, or obvious scams. Reply ONLY with "YES" or "NO" followed by a brief reason.' },
            { role: 'user', content: `F&G ${fg.v}/100 ${fg.t}. BUY ${best.sym} (sc=${best.sc}, RSI=${best.r ?? '?'}, MOM=${best.m ?? '?'}, EMA=${best.e ?? '?'}, VOL=${best.v != null ? best.v.toFixed(1) + 'x' : '?'}, VS=${best.vs != null ? best.vs.toFixed(1) + 'x' : '?'}, PD=${best.d ?? '?'}%, divergence=${best.dg ? 'YES' : 'NO'}, ${best.ch >= 0 ? '+' : ''}${best.ch?.toFixed(1) || '?'}% 24h, rule: ${ruleTriggered ? earlyPump(best) ? 'earlyPump' : 'pumpStart' : 'scoring'}). Portfolio: ${pricedPositions.filter(p => p.value > 0.01).map(p => `${p.sym}=$${p.value.toFixed(0)}`).join(', ') || 'empty'}. Recent trades: ${loadTradeHistory().slice(-10).map(t => `${t.type} ${t.sym}${t.pnl !== undefined && t.pnl !== null ? ' (' + (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(1) + ')' : ''}`).join(', ') || 'none'}.` },
          ];
          const aiReply = await deepseek.chat(aiMsg, { maxTokens: 100, temperature: 0.1 });
          if (!aiReply) { log(`  ⚠️ DeepSeek unreachable, skipping buy`); aiRejected.add(sym); return false; }
          if (aiReply.startsWith('NO')) { log(`  🤖 ${aiReply}`); aiRejected.add(sym); return false; }
          log(`  🤖 ${aiReply}`);
        } else {
          log(`  ⚠️ DeepSeek not configured, skipping AI buy validation`);
        }
        log(`Buy ${best.sym} $${buyUsd.toFixed(2)} (#${nonStablePositions.length + 1}/${MAX_POSITIONS})...`);
        const r = await execSwap({ id: USDC_NEAR, sym: 'USDC', dec: 6 }, target, amt.toString(), env.pk, assets);
        tradedThisCycle = true; if (r?.feeUsd || r?.spread) lastSwapFee += (r.feeUsd || 0);
        if (!r?.ok) { log(`  Buy skipped (spread ${r?.spread?.toFixed(1) || '?'}%)`); return false; }
          const outQty = Number(r.out) || 0;
          if (buyUsd <= 0 || outQty <= 0) { log(`  ⚠️ ${sym} cost basis invalid (buyUsd=${buyUsd}, outQty=${outQty}), skipping`); markTrade(); return true; }
          const usdcB2 = bals.findIndex(b => b.sym === 'USDC');
          if (usdcB2 >= 0) bals[usdcB2].human -= buyUsd;
          const buyB2 = bals.findIndex(b => b.sym === target.sym);
          if (buyB2 >= 0 && r.out) bals[buyB2].human += Number(r.out);
          raisedSyms[target.sym] = Date.now(); saveRaisedSyms(raisedSyms);
          const isPumpEntry = pumpStart(best) || earlyPump(best);
          const prevCb = costBasis[target.sym];
          costBasis[target.sym] = {
            cost: (prevCb?.cost || 0) + buyUsd,
            spread: prevCb ? ((prevCb.cost * (prevCb.spread || 0) + buyUsd * (r?.spread || 0)) / (prevCb.cost + buyUsd)) : (r?.spread || 0),
            fee: (prevCb?.fee || 0) + (r?.feeUsd || 0),
            qty: (prevCb?.qty || 0) + outQty,
            price: outQty > 0 ? buyUsd / outQty : (prevCb?.price || 0),
            pumpEntry: isPumpEntry || (prevCb?.pumpEntry || false),
          };
          saveCostBasis(costBasis);
          const buyPrice = outQty > 0 ? buyUsd / outQty : 0;
          log(`  Cost: $${buyUsd.toFixed(2)} @ $${buyPrice.toFixed(4)}/ea [spread ${r?.spread?.toFixed(2) || 0}%${(r?.feeUsd || 0) > 0 ? `, fee $${r.feeUsd.toFixed(4)}` : ''}]`);
          recordTrade('BUY', target.sym, buyUsd, null, null, reason, best.sc);
          holdStart[target.sym] = Date.now();
          markTrade(); return true;
      }
      if (buyTargetSym) await tryBuy(buyTargetSym);
    } else if (action === 'TOPUP') {
      const topupSym = reason.split(' ')[2];
      const target = buyEntry(topupSym);
      const pos = nonStablePositions.find(p => p.sym === topupSym);
      if (!target) { log(`  ⏭️ ${topupSym} not found in portfolio, skipping topup`); }
      else if (!pos) { log(`  ⏭️ ${topupSym} not held, skipping topup`); }
      else if (failedTokens.has(topupSym)) { log(`  ⏭️ ${topupSym} in failedTokens, skipping topup`); }
      else if (!usdcBal || usdcBal?.human < MIN_TRADE) { log(`  ⏭️ USDC insufficient ($${(usdcBal?.human || 0).toFixed(2)}) for topup`); }
      else {
        const grandTotal = investableTotal;
        const sortedPos = [...nonStablePositions].sort((a, b) => (b.score || 0) - (a.score || 0));
        const rank = sortedPos.findIndex(p => p.sym === topupSym);
        const maxVal = grandTotal * tierPct(rank, nonStablePositions.length);
        const room = maxVal - pos.value;
        let buyUsd = Math.max(MIN_TRADE, Math.min(usdcBal.human, room));
        const amt = Math.floor(buyUsd * 1e6);
        if (amt >= Math.floor(MIN_TRADE * 1e6)) {
          const liq = await checkLiquidity(USDC_NEAR, target.id, amt.toString());
          if (liq === false) { log(`  ⚠️ ${topupSym} no buy route`); }
          else if (liq === null) { log(`  ⚠️ ${topupSym} buy route check failed (network error), skipping`); }
          else {
            log(`Top up ${topupSym} $${buyUsd.toFixed(2)} (room to $${(room + pos.value).toFixed(2)})...`);
            // AI validation
            let deepseekOk = true;
            if (deepseek.hasKey()) {
              const cbSym = costBasis[topupSym];
              const pnlStr = cbSym?.cost > 0 && pos?.value > 0 ? ((pos.value - cbSym.cost) / cbSym.cost * 100).toFixed(1) + '%' : '?';
              const holdMs = holdStart[topupSym] ? Date.now() - holdStart[topupSym] : -1;
              const holdStr = holdMs >= 0 ? Math.round(holdMs / 60000) + 'min' : '?';
              const recentTrades = loadTradeHistory().slice(-5).map(t =>
                `${t.type} ${t.sym}${t.pnl !== undefined && t.pnl !== null ? ' (' + (t.pnl >= 0 ? '+' : '') + t.pnl.toFixed(1) + ')' : ''}`
              ).join(', ') || 'none';
              const portfolioStr = pricedPositions.filter(p => p.value > 0.01).map(p => `${p.sym}=$${p.value.toFixed(0)}`).join(', ') || 'empty';
              const aiMsg = [
                 { role: 'system', content: 'You are a crypto trading assistant for a momentum/scoring strategy. Validate whether TOPPING-UP (buying more of) an existing position is a good idea. This is not a new position — we already hold this token and are adding capital to reach target allocation. Our buy signals: (1) high score (sc>=7), (2) earlyPump (VOL>1.8x or VS>2x, EMA>=0, 24h>2%), (3) pumpStart (heavy VOL>2.5x or VS>2.5x, EMA=+2, deep dip), (4) strong trend (sc>=6, EMA>=+1, PD<-5% dip in uptrend), (5) momentum entry (sc>=3, VOL>1x, MOM>0, EMA>=0). Normal entries require sc>=5. For sc>=6 tokens: volume and momentum are NOT required — the strong score confirms quality. AVOID: Tokens with sc<5 (unless momentum entry criteria met), overbought RSI>85, or failing fundamentals. Reply ONLY "YES" or "NO" + brief reason.' },
                { role: 'user', content: `F&G ${fg.v}/100 ${fg.t}. TOPUP ${topupSym} (sc=${pos.score ?? '?'}, RSI=${pos.rsi ?? '?'}, MOM=${pos.mom ?? '?'}, EMA=${pos.e ?? '?'}, VOL=${pos.vol != null ? (typeof pos.vol === 'number' ? pos.vol.toFixed(1) : pos.vol) : '?'}x, P&L=${pnlStr}, held=${holdStr}). Adding $${buyUsd.toFixed(2)} to $${pos.value.toFixed(2)} position. Portfolio: ${portfolioStr}. Recent trades: ${recentTrades}.` },
              ];
              const aiReply = await deepseek.chat(aiMsg, { maxTokens: 100, temperature: 0.1 });
              if (!aiReply) { log(`  ⚠️ DeepSeek unreachable, skipping topup`); deepseekOk = false; }
              if (aiReply?.startsWith('NO')) { log(`  🤖 ${aiReply}`); deepseekOk = false; }
              if (deepseekOk && aiReply) log(`  🤖 ${aiReply}`);
            } else {
              log(`  ⚠️ DeepSeek not configured, skipping AI topup validation`);
            }
            if (deepseekOk) {
            const r = await execSwap({ id: USDC_NEAR, sym: 'USDC', dec: 6 }, target, amt.toString(), env.pk, assets);
            tradedThisCycle = true; if (r?.feeUsd || r?.spread) lastSwapFee += (r.feeUsd || 0);
            if (r?.ok) {
              const usdcBi = bals.findIndex(b => b.sym === 'USDC');
              if (usdcBi >= 0) bals[usdcBi].human -= buyUsd;
              const buyBi = bals.findIndex(b => b.sym === target.sym);
              if (buyBi >= 0 && r.out) bals[buyBi].human += Number(r.out);
              const prevCb = costBasis[target.sym];
              const outQty = Number(r.out) || 0;
              costBasis[target.sym] = {
                cost: (prevCb?.cost || 0) + buyUsd,
                spread: prevCb ? ((prevCb.cost * (prevCb.spread || 0) + buyUsd * (r?.spread || 0)) / (prevCb.cost + buyUsd)) : (r?.spread || 0),
                fee: (prevCb?.fee || 0) + (r?.feeUsd || 0),
                qty: (prevCb?.qty || 0) + outQty,
                price: outQty > 0 ? buyUsd / outQty : (prevCb?.price || 0),
              };
              saveCostBasis(costBasis);
              markTrade();
              const topupThrottle = loadTopupThrottle();
              topupThrottle[target.sym] = Date.now();
              saveTopupThrottle(topupThrottle);
              const buyPrice = outQty > 0 ? buyUsd / outQty : 0;
              log(`  Cost: $${buyUsd.toFixed(2)} @ $${buyPrice.toFixed(4)}/ea [spread ${r?.spread?.toFixed(2) || 0}%${(r?.feeUsd || 0) > 0 ? `, fee $${r.feeUsd.toFixed(4)}` : ''}]`);
            } else {
              log(`  Top up skipped${r ? ' (spread ' + r.spread?.toFixed(1) + '%)' : ''}`);
            }
          }
        }
      }
    }
  }
} else if (action !== 'HOLD' && !canExec) {
    log(`Would ${action} but monitor-only (add JWT to .env)`);
  } else if (action !== 'HOLD' && !ok) {
    log(`Would trade but cooldown`);
  }

  // Recompute portfolio from in-memory bals after trades
  if (action !== 'HOLD' && ok && canExec) {
    hasPositions = bals.filter(b => b.human > 0 || b.sym === 'USDC');
    pricedPositions = hasPositions.map(h => {
      const p = assetPrice(h.sym);
    return { ...h, price: p, value: p * h.human, score: h.sym === 'USDC' ? 0 : (assets[h.sym]?.sc || 0), ch: assets[h.sym]?.ch, rsi: rsis[h.sym], mom: moms[h.sym], vol: vols[h.sym], vs: vss[h.sym], e: ems[h.sym], d: pds[h.sym], dg: divergences[h.sym] ?? false };
  });
  }

  // Portfolio summary + P&L (excludes frozen and native NEAR)
  const fundTotal = pricedPositions.filter(p => !frozenSyms.has(p.sym)).reduce((s, p) => s + p.value, 0);

  // Deposit tracking — manual only (auto-detection disabled: too many false positives from frozen fund recoveries)
  // Update deposits.json manually when new external deposits are made.

  let history = [];
  try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch(e) {}
  if (!Array.isArray(history)) history = [];
  const last = history.length > 0 ? history[history.length - 1] : null;
  const prevTotal = last ? last.total : INITIAL_VALUE;
  let accruedFees = last ? (last.totalFees || 0) : 0;
  // Use the first fund-only entry (no 'near' field) as baseline for Δstart
  const firstFundEntry = history.find(h => !h.near && h.total > 0);
  const initFundVal = firstFundEntry ? firstFundEntry.total : INITIAL_VALUE;
  const initDeposits = firstFundEntry ? (firstFundEntry.deposits || 0) : 0;
  const prevDeposits = last ? (last.deposits || 0) : 0;
  const adjCurrent = fundTotal - totalDeposits;
  const adjInit = initFundVal - initDeposits;
  const adjPrev = prevTotal - prevDeposits;
  const pnlFromInit = adjCurrent - adjInit;
  const pnlFromInitPct = adjInit > 0 ? (pnlFromInit / adjInit) * 100 : 0;
  const pnlFromPrev = adjCurrent - adjPrev;
  const pnlFromPrevPct = adjPrev > 0 ? (pnlFromPrev / adjPrev) * 100 : 0;

  // Daily (Athens midnight = UTC-3h) and Weekly (Monday Athens midnight) performance
  const nowMs = Date.now();
  const athensOffset = 3 * 3600000;
  const athensDate = new Date(nowMs + athensOffset);
  const athensY = athensDate.getUTCFullYear();
  const athensM = athensDate.getUTCMonth();
  const athensD = athensDate.getUTCDate();
  const athensMidnightUtc = Date.UTC(athensY, athensM, athensD) - athensOffset;
  const athensDow = athensDate.getUTCDay();
  const daysSinceMonday = athensDow === 0 ? 6 : athensDow - 1;
  const mondayMidnightUtc = athensMidnightUtc - daysSinceMonday * 86400000;

  const monthMidnightUtc = Date.UTC(athensY, athensM, 1) - athensOffset;

  const dailyEntry = history.find(h => new Date(h.t).getTime() >= athensMidnightUtc)
    || [...history].reverse().find(h => new Date(h.t).getTime() < athensMidnightUtc)
    || firstFundEntry;
  const weeklyEntry = daysSinceMonday === 0 ? dailyEntry : (history.find(h => new Date(h.t).getTime() >= mondayMidnightUtc)
    || [...history].reverse().find(h => new Date(h.t).getTime() < mondayMidnightUtc)
    || firstFundEntry);
  const monthlyEntry = history.find(h => new Date(h.t).getTime() >= monthMidnightUtc)
    || [...history].reverse().find(h => new Date(h.t).getTime() < monthMidnightUtc)
    || firstFundEntry;
  const adjDaily = (dailyEntry?.total || 0) - (dailyEntry?.deposits || 0);
  const adjWeekly = (weeklyEntry?.total || 0) - (weeklyEntry?.deposits || 0);
  const adjMonthly = (monthlyEntry?.total || 0) - (monthlyEntry?.deposits || 0);
  const dailyPnl = adjCurrent - adjDaily;
  const dailyPnlPct = (dailyEntry?.total || 0) > 0 ? (dailyPnl / (dailyEntry?.total || 1)) * 100 : 0;
  const weeklyPnl = adjCurrent - adjWeekly;
  const weeklyPnlPct = (weeklyEntry?.total || 0) > 0 ? (weeklyPnl / (weeklyEntry?.total || 1)) * 100 : 0;
  const monthlyPnl = adjCurrent - adjMonthly;
  const monthlyPnlPct = (monthlyEntry?.total || 0) > 0 ? (monthlyPnl / (monthlyEntry?.total || 1)) * 100 : 0;

  // Accumulate swap fees
  if (typeof lastSwapFee === 'number' && lastSwapFee > 0) accruedFees += lastSwapFee;

  // Merge new failed tokens into existing list
  for (const s of newFailedTokens) {
    failedTokens.add(s);
    failCooldown[s] = Date.now();
  }
  saveFailCooldown(failCooldown);
  saveJunkTimers(junkTimers);
  saveObTimers(obTimers);
  const now = new Date();
  history.push({ t: now.toISOString(), total: fundTotal, deposits: totalDeposits, totalFees: accruedFees, failedTokens: [...failedTokens], pos: pricedPositions.filter(p => !frozenSyms.has(p.sym) && p.value > 0).map(p => ({ s: p.sym, q: p.human, v: p.value })) });
  // keep all history — no pruning
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2)); } catch(e) {}

  log('── Portfolio ──');
  for (const p of pricedPositions) {
    if (p.value >= 0.01 || p.sym === 'USDC') {
      if (frozenSyms.has(p.sym)) continue;
      const cb = costBasis[p.sym];
      let pnlStr = '';
      if (cb !== undefined && cb !== null && cb.cost !== undefined && cb.cost > 0) {
        const pnl = p.value - cb.cost;
        const pnlPct = (pnl / cb.cost) * 100;
        const buyInfo = ` [buy: ${cb.spread?.toFixed(2) || '0.00'}% spread, $${cb.fee?.toFixed(4) || '0.0000'} fee]`;
        pnlStr = ` (${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}, ${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)${buyInfo}`;
      }
      log(`  ${p.sym}: ${p.human.toFixed(p.sym==='USDC'?2:p.sym==='NEAR'?3:6)} × $${p.price.toFixed(4)} = $${p.value.toFixed(2)}${pnlStr}`);
    }
  }
  const pnlStr = (pnlFromPrev >= 0 ? '+' : '') + pnlFromPrev.toFixed(2);
  const pnlPctStr = (pnlFromPrevPct >= 0 ? '+' : '') + pnlFromPrevPct.toFixed(2);
  const initPnlStr = (pnlFromInit >= 0 ? '+' : '') + pnlFromInit.toFixed(2);
  const initPnlPctStr = (pnlFromInitPct >= 0 ? '+' : '') + pnlFromInitPct.toFixed(2);
  const perf = adjCurrent - adjInit + accruedFees;
  const dailyPerfStr = (dailyPnl >= 0 ? '+' : '') + dailyPnl.toFixed(2);
  const dailyPerfPctStr = (dailyPnlPct >= 0 ? '+' : '') + dailyPnlPct.toFixed(2);
  const weeklyPerfStr = (weeklyPnl >= 0 ? '+' : '') + weeklyPnl.toFixed(2);
  const weeklyPerfPctStr = (weeklyPnlPct >= 0 ? '+' : '') + weeklyPnlPct.toFixed(2);
  const monthlyPerfStr = (monthlyPnl >= 0 ? '+' : '') + monthlyPnl.toFixed(2);
  const monthlyPerfPctStr = (monthlyPnlPct >= 0 ? '+' : '') + monthlyPnlPct.toFixed(2);
  log(`  Total: $${fundTotal.toFixed(2)} | Δprev: ${pnlStr} (${pnlPctStr}%) | Δstart: ${initPnlStr} (${initPnlPctStr}%)`);
  log(`  Daily: ${dailyPerfStr} (${dailyPerfPctStr}%) | Weekly: ${weeklyPerfStr} (${weeklyPerfPctStr}%) | Monthly: ${monthlyPerfStr} (${monthlyPerfPctStr}%) | Fees: $${accruedFees.toFixed(2)} | Perf: $${perf.toFixed(2)}`);
  if (totalDeposits > 0) log(`  Deposited: $${totalDeposits.toFixed(2)}`);
  if (nearBal > 0.01) {
    const nearPx = assetPrice('wNEAR');
    log('── Gas ──');
    log(`  ${nearBal.toFixed(3)} NEAR ($${(nearBal * nearPx).toFixed(2)})`);
  }
  if (frozenPositions.length > 0) {
    log('── Frozen funds ──');
    for (const p of frozenPositions) {
      const label = p.sym === 'NEAR' ? 'NEAR (BSC)' : p.sym;
      log(`  ${label}: ${p.human.toFixed(3)} × $${p.price.toFixed(4)} = $${p.value.toFixed(2)}`);
    }
  }
  log('── ─────── ──');

  // Research log — append snapshot each run
  try {
    const fgLabel = typeof fg === 'object' && fg !== null ? `${fg.v}` : '?';
    const fgText = typeof fg === 'object' && fg !== null ? `${fg.t}` : '?';
    const research = {
      t: new Date().toISOString(),
      fg: fgLabel,
      fgc: fgText,
      goldChg,
      downCount,
      routes: routeInv ? routeInv.size : 0,
      top: ranked.slice(0, 15).map(a => ({
        sym: a.sym, p: a.p, ch: a.ch, sc: a.sc, rsi: a.r, mom: a.m, vol: a.v, ema: a.e, pd: a.d, vs: a.vs, mc: a.mc
      })),
      portfolio: {
        total: pricedPositions.reduce((s, p) => s + p.value, 0),
        pos: pricedPositions.filter(p => p.value > 0.01).map(p => {
          const cb = costBasis[p.sym];
          return {
            sym: p.sym, qty: p.human, val: p.value,
            cost: cb ? cb.cost : null,
            score: p.score, rsi: p.rsi, mom: p.mom, ema: p.e, pd: p.d
          };
        })
      },
      frozen: frozenPositions.length > 0 ? frozenPositions.map(p => ({ sym: p.sym, qty: p.human, val: p.value })) : undefined,
      nearBal,
      decision: action,
      reason
    };
    let rl = [];
    try { rl = JSON.parse(fs.readFileSync(RESEARCH_FILE, 'utf8')); } catch(e) {}
    if (!Array.isArray(rl)) rl = [];
    rl.push(research);
    fs.writeFileSync(RESEARCH_FILE, JSON.stringify(rl));
  } catch(e) { log('Research log err:', e.message); }

  // Route health log
  if (routeHealth.length > 0) {
    try {
      const ts = new Date().toISOString();
      let rh = [];
      try { rh = JSON.parse(fs.readFileSync(ROUTE_HEALTH_FILE, 'utf8')); } catch(e) {}
      if (!Array.isArray(rh)) rh = [];
      for (const e of routeHealth) rh.push({ ...e, t: ts });
      fs.writeFileSync(ROUTE_HEALTH_FILE, JSON.stringify(rh));
    } catch(e) { log('Route health err:', e.message); }
  }

  // AI advisor
  if (deepseek.hasKey()) {
    const posStr = pricedPositions.filter(p => p.value > 0.01).map(p => {
      const parts = [`${p.sym}=$${p.value.toFixed(2)}`];
      if (p.score != null) parts.push(`sc=${p.score}`);
      if (p.rsi != null) parts.push(`RSI=${p.rsi.toFixed(0)}`);
      if (p.mom != null) parts.push(`MOM=${p.mom >= 0 ? '+' : ''}${p.mom}`);
      if (p.vol != null) parts.push(`VOL=${p.vol.toFixed(1)}x`);
      if (p.vs != null) parts.push(`VS=${p.vs.toFixed(1)}x`);
      if (p.e != null) parts.push(`EMA=${p.e >= 0 ? '+' : ''}${p.e}`);
      if (p.d != null) parts.push(`PD=${p.d.toFixed(1)}%`);
      if (p.dg != null && !p.sym.startsWith('USDC')) parts.push(`DG=${p.dg ? 'YES' : 'NO'}`);
      return parts.join(' ');
    }).join('; ');
    const topCandidates = ranked.filter(a => routeInv.has(a.sym) && a.sym !== 'NEAR' && !STABLE_SYMS.has(a.sym));
    const top3 = topCandidates.slice(0, 3);
    const top8 = topCandidates.slice(0, 8);
    const topList = top3.map(a =>
      `${a.sym}(sc=${a.sc || '?'}, ${a.ch != null ? (a.ch >= 0 ? '+' : '') + a.ch.toFixed(1) + '%' : '?'}, DG=${a.dg ? 'YES' : 'NO'})`
    ).join(', ');
    const assetMetrics = topCandidates.slice(0, 10).map(a => {
      const p = [];
      p.push(`sc=${a.sc || '?'}`);
      if (a.r != null) p.push(`RSI=${a.r.toFixed(0)}`);
      if (a.m != null) p.push(`MOM=${a.m >= 0 ? '+' : ''}${a.m}`);
      if (a.v != null) p.push(`VOL=${a.v.toFixed(1)}x`);
      if (a.vs != null) p.push(`VS=${a.vs.toFixed(1)}x`);
      if (a.e != null) p.push(`EMA=${a.e >= 0 ? '+' : ''}${a.e}`);
      if (a.d != null) p.push(`PD=${a.d.toFixed(1)}%`);
      if (a.ch != null) p.push(`ch=${a.ch >= 0 ? '+' : ''}${a.ch.toFixed(1)}%`);
      p.push(`DG=${a.dg ? 'YES' : 'NO'}`);
      return `${(a.sym + ':').padEnd(10)} ${p.join(', ')}`;
    }).join('\n');
    const greenCount = top8.filter(a => a.ch != null && a.ch > 0).length;
    const avgCh = top8.length > 0 ? top8.reduce((s, a) => s + (a.ch || 0), 0) / top8.length : 0;
    const breadth = `${greenCount}/${top8.length} green, avg ${avgCh >= 0 ? '+' : ''}${avgCh.toFixed(2)}%`;
    const topEmaSignals = ranked.slice(0, 15).filter(a => a.e != null).map(a => a.e);
    const bullCount = topEmaSignals.filter(e => e >= 0).length;
    const mktTrend = topEmaSignals.length === 0 ? 'neutral' :
      bullCount / topEmaSignals.length > 0.6 ? 'bullish' :
      bullCount / topEmaSignals.length < 0.3 ? 'bearish' : 'neutral';
    const capital = (investableTotal - (usdcBal?.value || 0)).toFixed(2);
    const perfStr = `Start ${pnlFromInit >= 0 ? '+' : ''}${pnlFromInitPct.toFixed(2)}% | Daily ${dailyPnl >= 0 ? '+' : ''}${dailyPnlPct.toFixed(2)}% | Month ${monthlyPnl >= 0 ? '+' : ''}${monthlyPnlPct.toFixed(2)}%`;
    const ts = new Date().toISOString().replace('T', ' ').slice(0, 19);
    let prevTop = '', prevTs = '';
    try {
      const snap = JSON.parse(fs.readFileSync(path.join(PROJECT, '.advisor_snapshot.json'), 'utf8'));
      prevTop = snap.top || '';
      prevTs = snap.ts || '';
    } catch(e) {}
    const msg = [
      { role: 'system', content: 'You are a crypto trading advisor auditing an automated trading agent. Your task is to critically evaluate the agent\'s decision against the provided market data.\n\nCRITICAL RULES:\n1. Never call a trend "bullish" unless at least 60% of top assets are green with volume > 1.5x\n2. Distinguish between accumulation (volume up + price up) and low-volume bounces (volume down + price flat/up)\n3. F&G < 20 alone is NOT a buy signal - require at least two additional confirmations\n4. Use the RSI, MOM, VOL, VS, EMA, and PD values from the data - do not claim they\'re missing\n5. If you can\'t make a confident recommendation, say "NO TRADE - conditions unclear"\n\nYou must:\n1. Identify whether the agent\'s decision was correct, wrong, or incomplete given market conditions\n2. Explain WHY using specific metrics (RSI, MOM, VOL, VS, EMA, PD, F&G)\n3. Flag any missed opportunities or false signals in the data\n4. Suggest ONE concrete improvement to the agent\'s decision logic\n\nBe decisive. Avoid vague language like "monitor" or "could be". If you can\'t confidently recommend a trade, say "NO TRADE" and explain why.' },
      { role: 'user', content: `MARKET CONTEXT:\n- Fear & Greed: ${fg.v}/100 (${fg.t})\n- Trend: ${mktTrend}\n- Breadth: ${breadth}\n\nAGENT DECISION:\n- Action: ${action || 'HOLD'}\n- Reasoning: ${reason || 'no reason given'}\n\nPORTFOLIO:\n- Position: ${posStr || 'empty'}\n- Capital: $${capital}\n- Value: $${fundTotal.toFixed(2)}\n- Performance: ${perfStr}\n\nTOP ASSETS (${ts}):\n${topList || 'none'}\n\nASSET METRICS:\n${assetMetrics || 'none'}\n\nHISTORICAL (${prevTs || 'N/A'}):\n${prevTop || 'none'}\n\nTASK:\nAnalyze if the agent's HOLD decision was correct given:\n\n1. Are any assets showing genuine accumulation? (VOL > 1.5x AND price up > 1% AND MOM > 0)\n2. Are any assets showing distribution? (VOL > 1.5x AND price flat/down AND MOM < 0)\n3. Are any assets oversold? (RSI < 30 AND VOL > 1.5x - potential bounce)\n4. Are any assets breaking out? (RSI > 70 AND VOL > 2x - momentum continuation)\n5. Is EMA direction supporting the move? (EMA:+0 = neutral, EMA:+1 = bullish, EMA:-1 = bearish)\n6. Is PD (potential drop) signaling risk? (PD > -10% = high risk of further downside)\n7. Are any existing positions ready for profit-taking? Check each position\'s P&L (from posStr), RSI (overbought >70), MOM (turning negative after a run-up), VOL (declining volume on a rally = weak exit signal). Flag specific positions to sell if P&L > 5% AND (RSI > 70 OR MOM ≤ 0).\n\nProvide structured output:\nDECISION: [AGREE/DISAGREE/PARTIALLY]\nREASONING: [2-3 sentences with specific metrics from the data]\nMISSED OPPORTUNITY: [Yes/No - if Yes, which asset and why]\nIMPROVEMENT SUGGESTION: [1 specific rule change]` },
    ];
    const reply = await deepseek.chat(msg, { maxTokens: 600 });
    if (reply) { log(''); log('='.repeat(105)); log('  AI ADVISOR'); log('='.repeat(105)); log(`  ${reply}`); }
    try { fs.writeFileSync(path.join(PROJECT, '.advisor_snapshot.json'), JSON.stringify({ top: topList, ts: new Date().toISOString() })); } catch(e) {}
  }

  log('=== DONE ===');
}

main().catch(e => log('ERR:', e.message));

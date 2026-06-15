#!/usr/bin/env node
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const { execFileSync } = require('child_process');

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
const MAX_SPREAD_PCT = 4.0;

const FLAP_COOLDOWN_MS = 30 * 60 * 1000;   // route-flap penalty duration
const FLAP_FILE = path.join(PROJECT, '.route_flap.json');
const COST_BASIS_FILE = path.join(PROJECT, '.cost_basis.json');
const FAIL_COOLDOWN_MS = 60 * 60 * 1000;   // wait 1h before re-checking a failed token
const FAIL_COOLDOWN_FILE = path.join(PROJECT, '.fail_cooldown.json');

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
  IMX: 'immutable-x', APE: 'apecoin', BLUR: 'blur',
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
      if (i < 2 && (e.message?.includes('EAI_AGAIN') || e.message?.includes('ECONNRESET') || e.message?.includes('ETIMEDOUT'))) {
        await sleep(2000); continue;
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
      r.on('end', () => { try { res({ s: r.statusCode, d: JSON.parse(d) }); } catch(e) { res({ s: r.statusCode, d }); } });
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
      if (i < 2 && (e.message?.includes('EAI_AGAIN') || e.message?.includes('ECONNRESET') || e.message?.includes('ETIMEDOUT'))) {
        await sleep(2000); continue;
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
let cgCache = { data: null, ts: 0 };

async function fetchCGData(ids) {
  const now = Date.now();
  if (cgCache.data && now - cgCache.ts < CG_CACHE_TTL) {
    return cgCache.data;
  }
  if (!ids.length) return {};
  try {
    const r = await httpGet(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`);
    log('CG prices:', Object.keys(r).join(','));
    cgCache = { data: r, ts: now };
    return r;
  } catch(e) {
    log('CG price err:', e.message);
    if (cgCache.data) {
      log('  Using cached CG prices');
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
  try { const d = await httpGet(`https://api.coingecko.com/api/v3/coins/${id}/ohlc?days=14&vs_currency=usd`); return Array.isArray(d) ? d.map(c => c[4]).filter(p => p > 0) : null; }
  catch(e) { return null; }
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
  try {
    const r = await httpPost('https://rpc.mainnet.near.org', { jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'call_function', account_id: 'intents.near', method_name: 'mt_batch_balance_of', args_base64: args, finality: 'optimistic' } });
    if (!r.d?.result?.result) return PORTFOLIO.map(p => ({ ...p, raw: '0', human: 0 }));
    const parsed = JSON.parse(Buffer.from(r.d.result.result, 'base64').toString());
    // mt_batch_balance_of returns a flat array of balance strings in token_ids order
    return PORTFOLIO.map((p, i) => {
      const raw = Array.isArray(parsed) ? (parsed[i] || '0') : '0';
      return { ...p, raw, human: Number(BigInt(raw)) / 10 ** p.dec };
    });
  } catch(e) { log('Bal fetch err:', e.message); return PORTFOLIO.map(p => ({ ...p, raw: '0', human: 0 })); }
}

async function fetchNearBal() {
  try {
    const r = await httpPost('https://rpc.mainnet.near.org', { jsonrpc: '2.0', id: 1, method: 'query', params: { request_type: 'view_account', account_id: ACCOUNT, finality: 'optimistic' } });
    return Number(BigInt(r.d?.result?.amount || '0')) / 1e24;
  } catch(e) { return 0; }
}

async function execSwap(from, to, amount, pk, prices) {
  const { jwt } = loadEnv();
  if (!jwt) return null;
  const dl = new Date(Date.now() + 86400000).toISOString().replace(/\.\d+Z/, '.000Z');
  try {
    const qr = await httpPost('https://1click.chaindefuser.com/v0/quote', {
      dry: false, swapType: 'EXACT_INPUT', depositMode: 'SIMPLE',
      originAsset: from.id, destinationAsset: to.id,
      amount: amount.toString(),
      slippageTolerance: 100,
      recipient: ACCOUNT, recipientType: 'INTENTS',
      refundTo: ACCOUNT, refundType: 'INTENTS',
      depositType: 'INTENTS', deadline: dl,
    }, { 'Authorization': `Bearer ${jwt}` });
    if (!qr.d?.quote?.depositAddress) { log('Quote fail:', JSON.stringify(qr.d).slice(0, 200)); return null; }
    const da = qr.d.quote.depositAddress;
    const qAmtIn = qr.d.quote.amountIn || amount;
    const qAmtOut = qr.d.quote.amountOut || '0';

    // Spread check
    let spreadPct = 0;
    if (prices) {
      const pIn = from.sym === 'USDC' ? 1 : (prices[from.sym]?.p || 0);
      const pOut = to.sym === 'USDC' ? 1 : (prices[to.sym]?.p || 0);
      const inUSD = Number(qAmtIn) / 10 ** from.dec * pIn;
      const outUSD = Number(qAmtOut) / 10 ** to.dec * pOut;
      if (inUSD > 0) {
        spreadPct = Math.max(0, (1 - outUSD / inUSD) * 100);
        log(`  Spread: ${spreadPct.toFixed(2)}%`);
        if (spreadPct > MAX_SPREAD_PCT) {
          log(`  Spread ${spreadPct.toFixed(1)}% > ${MAX_SPREAD_PCT}%, skipping`);
          return { ok: false, spread: spreadPct, feeUsd: 0 };
        }
      }
    }

    log(`  Swap ${from.sym}→${to.sym} addr=${da.slice(0, 16)}...`);

    const ir = await httpPost('https://1click.chaindefuser.com/v0/generate-intent', {
      type: 'swap_transfer', depositAddress: da, signerId: ACCOUNT, standard: 'nep413',
    }, { 'Authorization': `Bearer ${jwt}` });
    if (!ir.d?.intent?.payload) { log('Intent fail:', JSON.stringify(ir.d).slice(0, 200)); return null; }
    const { message, nonce, recipient } = ir.d.intent.payload;

    // Sign via temp file to avoid shell escaping issues
    const tmpFile = path.join(PROJECT, '.sign_tmp.json');
    fs.writeFileSync(tmpFile, JSON.stringify({ message, nonce, recipient, pk }));
    const out = execFileSync('node', [path.join(PROJECT, 'nep413_sign.js'), 'sign', message, nonce, recipient, pk], {
      encoding: 'utf8', maxBuffer: 1024,
    });
    try { fs.unlinkSync(tmpFile); } catch(e) {}
    const sig = JSON.parse(out.trim()).signature;

    const sd = { standard: 'nep413', payload: { message, nonce, recipient }, public_key: PUBLIC_KEY, signature: sig };

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
    const r = await httpPost('https://1click.chaindefuser.com/v0/quote', {
      dry: true, swapType: 'EXACT_INPUT', depositMode: 'SIMPLE',
      originAsset: fromId, destinationAsset: toId,
      amount: rawAmount,
      slippageTolerance: 100,
      recipient: ACCOUNT, recipientType: 'INTENTS',
      refundTo: ACCOUNT, refundType: 'INTENTS',
      depositType: 'INTENTS', deadline: dl,
    }, { 'Authorization': `Bearer ${jwt}` });
    return r.d?.quote?.amountOut != null;
  } catch(e) { return false; }
}

function canTrade() {
  try { const t = parseInt(fs.readFileSync(LAST_TRADE, 'utf8').trim()); if (!isNaN(t) && Date.now() - t < COOLDOWN_MS) return false; } catch(e) {}
  return true;
}
function markTrade() { try { fs.writeFileSync(LAST_TRADE, Date.now().toString()); } catch(e) {} }

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
  try { return JSON.parse(fs.readFileSync(FLAP_FILE, 'utf8')); } catch(e) { return {}; }
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

async function buildRouteInventory(portfolio, jwt) {
  const tradable = new Set(['USDC', 'wNEAR']);
  for (const t of portfolio) {
    if (tradable.has(t.sym)) continue;
    const rawAmt = Math.floor(MIN_POSITION_VALUE * 1e6).toString();
    try {
      const dl = new Date(Date.now() + 86400000).toISOString().replace(/\.\d+Z/, '.000Z');
      const r = await httpPost('https://1click.chaindefuser.com/v0/quote', {
        dry: true, swapType: 'EXACT_INPUT', depositMode: 'SIMPLE',
        originAsset: USDC_NEAR, destinationAsset: t.id,
        amount: rawAmt, slippageTolerance: 100,
        recipient: ACCOUNT, recipientType: 'INTENTS',
        refundTo: ACCOUNT, refundType: 'INTENTS',
        depositType: 'INTENTS', deadline: dl,
      }, { 'Authorization': `Bearer ${jwt}` });
      if (r.d?.quote?.amountOut != null) tradable.add(t.sym);
      await sleep(200);
    } catch(e) {}
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

  // Route inventory — cache of which tokens have active 1Click swap routes
  let routeInv = canExec ? loadRouteInventoryCache() : null;
  if (canExec && !routeInv) {
    log('Building route inventory...');
    routeInv = await buildRouteInventory(PORTFOLIO, env.jwt);
    log(`Route inventory: ${routeInv.size} tradable of ${PORTFOLIO.length}`);
  } else if (canExec) {
    log(`Route inventory: ${routeInv.size} tradable (cached)`);
  } else {
    const all = PORTFOLIO.map(p => p.sym);
    routeInv = new Set(all);
  }

  // Progressive route inventory refresh — test unknown tokens each cycle
  if (canExec) {
    const unknown = PORTFOLIO.filter(t => !routeInv.has(t.sym) && !t.sym.endsWith('on') && t.sym !== 'TON');
    if (unknown.length > 0) {
      const batch = unknown.slice(0, 3);
      for (const t of batch) {
        const rawAmt = Math.floor(MIN_POSITION_VALUE * 1e6).toString();
        try {
          const dl = new Date(Date.now() + 86400000).toISOString().replace(/\.\d+Z/, '.000Z');
          const r = await httpPost('https://1click.chaindefuser.com/v0/quote', {
            dry: true, swapType: 'EXACT_INPUT', depositMode: 'SIMPLE',
            originAsset: USDC_NEAR, destinationAsset: t.id,
            amount: rawAmt, slippageTolerance: 100,
            recipient: ACCOUNT, recipientType: 'INTENTS',
            refundTo: ACCOUNT, refundType: 'INTENTS',
            depositType: 'INTENTS', deadline: dl,
          }, { 'Authorization': `Bearer ${env.jwt}` });
          if (r.d?.quote?.amountOut != null) {
            log(`  ✅ ${t.sym} route discovered!`);
            routeInv.add(t.sym);
          }
        } catch(e) {}
        await sleep(200);
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

  const assets = {};

  // Crypto
  for (const [sym, id] of Object.entries(CG_IDS)) {
    const cg = cgData[id];
    const c1 = clickPrices[sym];
    const price = c1?.price ?? cg?.usd ?? null;
    if (price == null) continue;
    const ch = cg?.usd_24h_change ?? 0;
    const vol = cg?.usd_24h_vol ?? 0;
    assets[sym] = { p: price, ch, v: vol, sc: score(ch, vol, 'c') };
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
  try {
    const h = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8'));
    if (Array.isArray(h) && h.length > 0) {
      failedTokens = new Set(h[h.length - 1].failedTokens || []);
      lastPos = (h[h.length - 1].pos || []).map(p => p.s);
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
  // Init cooldown for Ondo ETFs so re-check loop skips them immediately
  for (const sym of failedTokens) {
    if (sym.endsWith('on') && sym !== 'TON' && !failCooldown[sym]) {
      failCooldown[sym] = Date.now();
    }
  }
  saveFailCooldown(failCooldown);

  // RSI — held tokens (from history) + top 15 scorers
  const sorted = Object.entries(assets).sort((a, b) => b[1].sc - a[1].sc);
  const top15 = sorted.slice(0, 15).map(e => e[0]);
  const rsiFor = [...new Set([...lastPos, ...top15])].filter(s => CG_IDS[s] && CG_IDS[s] !== 'near');

  const rsis = {};
  for (const sym of rsiFor) {
    const id = CG_IDS[sym];
    const c = await fetchOHLC(id);
    if (c) rsis[sym] = rsi(c);
    await sleep(5000);
  }
  // ETF RSI from stored data
  for (const [sym, d] of Object.entries(etfData)) {
    if (d?.c?.length >= 14) rsis[sym] = rsi(d.c);
  }

  // Top assets ranked
  const ranked = sorted.map(([sym, a]) => ({ sym, ...a, r: rsis[sym] }));
  const downCount = ranked.slice(0, 15).filter(a => a.ch < 0).length;

  log('Top 5:');
  ranked.filter(a => routeInv.has(a.sym)).slice(0, 5).forEach(a => log(`  ${a.sym}: sc=${a.sc} $${a.p?.toFixed(4)||'?'} ${a.ch?.toFixed(1)||'?'}% RS${a.r !== undefined ? 'I='+a.r.toFixed(0) : '--'}`));

  // Portfolio
  let bals = await fetchBals();
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
              const r = await execSwap(target, { id: USDC_NEAR, sym: 'USDC', dec: 6 }, raw, env.pk, assets);
              if (r?.ok) {
                const usdcBi = bals.findIndex(b => b.sym === 'USDC');
                if (usdcBi >= 0 && r.out) bals[usdcBi].human += Number(r.out);
                log(`  ✅ Recovered ${sym} → ${r.out} USDC`);
                delete costBasis[sym];
                saveCostBasis(costBasis);
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
  let hasPositions = bals.filter(b => b.human > 0);
  const nearBal = await fetchNearBal();
  log(`NEAR: ${nearBal.toFixed(3)}`);
  for (const b of hasPositions) log(`  ${b.sym}: ${b.human.toFixed(6)}`);

  // Valuations
  let pricedPositions = hasPositions.map(h => {
    const p = h.sym === 'USDC' ? 1 : (assets[h.sym]?.p || 0);
    return { ...h, price: p, value: p * h.human, score: h.sym === 'USDC' ? 0 : (assets[h.sym]?.sc || 0), ch: assets[h.sym]?.ch, rsi: rsis[h.sym] };
  });
  const totalValue = pricedPositions.reduce((s, p) => s + p.value, 0);
  // exclude USDC from total for decision purposes (it's the stable)
  let nonStablePositions = pricedPositions.filter(p => p.sym !== 'USDC' && p.value >= MIN_TRADE);
  let usdcBal = pricedPositions.find(p => p.sym === 'USDC');
  // wNEAR in intents is a tradeable position — include in allocation math
  const investableTotal = totalValue;

  // Track when each position was acquired (prevents flip-flopping)
  let holdStart = {};
  for (const p of nonStablePositions) {
    if (costBasis[p.sym]) holdStart[p.sym] = Date.now() - HOLD_MIN_MS;
  }

  // Route health check for all held positions
  for (const p of nonStablePositions) {
    const hasRoute = await checkLiquidity(p.id, USDC_NEAR, p.raw);
    if (!hasRoute) {
      log(`  ⚠️ HELD ${p.sym} ($${p.value.toFixed(2)}) has no sell route!`);
      failedTokens.add(p.sym);
    }
  }
  // Re-check failed tokens that are NOT held — if route is back, allow them again
  const heldSyms = new Set(nonStablePositions.map(p => p.sym));
  for (const sym of [...failedTokens]) {
    if (heldSyms.has(sym)) continue;
    if (failCooldown[sym] && Date.now() - failCooldown[sym] < FAIL_COOLDOWN_MS) continue;
    const target = PORTFOLIO.find(p => p.sym === sym);
    if (!target) continue;
    if (target.id.startsWith('1cs_v1:')) continue;
    const hasRoute = await checkLiquidity(USDC_NEAR, target.id, Math.floor(MIN_POSITION_VALUE * 1e6).toString());
    if (hasRoute) {
      log(`  ✅ ${sym} route restored, removing from failed tokens`);
      failedTokens.delete(sym);
      delete failCooldown[sym];
      saveFailCooldown(failCooldown);
      flapSyms[sym] = Date.now();
      saveFlapSyms(flapSyms);
    } else {
      // Re-check found no route — reset cooldown to prevent retry next cycle
      failCooldown[sym] = Date.now();
      saveFailCooldown(failCooldown);
    }
  }

  // Apply route-flap penalty (-1 score for recently recovered tokens)
  for (const sym of Object.keys(flapSyms)) {
    if (assets[sym]) {
      assets[sym].sc = Math.max(-2, assets[sym].sc - 1);
      log(`  ${sym}: flap penalty applied (sc ${assets[sym].sc + 1} → ${assets[sym].sc})`);
    }
  }

  // Decision
  let action = 'HOLD', reason = '';

  if (nearBal < GAS_RESERVE) {
    action = 'HOLD'; reason = `Low gas (${nearBal.toFixed(2)} NEAR)`;
  } else if (nonStablePositions.length > 0) {
    // Check each existing position for weakness first
    for (const p of nonStablePositions) {
      if (p.rsi !== undefined && p.rsi > 92 && p.score < 7) { action = 'SELL'; reason = `${p.sym} OB RSI=${p.rsi.toFixed(0)} sc=${p.score}`; break; }
      // Junk sell: exit positions that fall below sc=4 (only when CG data is fresh)
      if (hasRealScores && p.score < 4) { action = 'SELL'; reason = `${p.sym} junk sc=${p.score}`; break; }
    }
    // Check rotation if no immediate sell
    if (action === 'HOLD') {
      const worst = nonStablePositions.reduce((w, p) => p.score < (w?.score ?? Infinity) ? p : w, nonStablePositions[0]);
      const heldTooShort = holdStart[worst.sym] && Date.now() - holdStart[worst.sym] < HOLD_MIN_MS;
      if (heldTooShort) { log(`  ${worst.sym} held < ${HOLD_MIN_MS/60000}min, skip rotate`); }
      const bestNew = !heldTooShort && ranked.find(a => a.sc >= 3 && (a.r === undefined || a.r < 92) && !failedTokens.has(a.sym) && !nonStablePositions.find(p => p.sym === a.sym) && !raisedSyms[a.sym] && PORTFOLIO.find(p => p.sym === a.sym) && routeInv.has(a.sym) && a.sc >= (worst?.score || 0) + 1);
      if (bestNew) {
        const slotOpen = nonStablePositions.length < MAX_POSITIONS;
        const usdcForBuy = usdcBal?.human || 0;
        const canBuyDirect = slotOpen && (usdcForBuy >= MIN_POSITION_VALUE || nonStablePositions.some(p => p.value >= MIN_POSITION_VALUE - usdcForBuy && p.value >= MIN_TRADE));
        if (!canBuyDirect) { action = 'ROTATE'; reason = `${worst.sym} weakest (sc=${worst.score}), rotate to best buyable`; }
      }
    }
    // Risk-off: broad market crash → all to USDC
    if (action === 'HOLD' && fg.v < 30 && downCount > 9) {
      action = 'SELL_ALL'; reason = `Risk-off F&G=${fg.v} down=${downCount}/15`;
    }
  }
  // If no sell/rotate and room to buy more
  if (action === 'HOLD' && nonStablePositions.length < MAX_POSITIONS) {
    const heldSyms = new Set(nonStablePositions.map(p => p.sym));
    const candidate = ranked.find(a => a.sc >= 4 && (a.r === undefined || a.r < 92) && !failedTokens.has(a.sym) && !heldSyms.has(a.sym) && !raisedSyms[a.sym] && PORTFOLIO.find(p => p.sym === a.sym) && routeInv.has(a.sym));
    const usdcForBuy = usdcBal?.human || 0;
    if (candidate && PORTFOLIO.find(p => p.sym === candidate.sym) && usdcForBuy >= MIN_POSITION_VALUE) {
      action = 'BUY'; reason = `Buy ${candidate.sym} (sc=${candidate.sc}) #${nonStablePositions.length + 1}/${MAX_POSITIONS}`;
    } else if (candidate && PORTFOLIO.find(p => p.sym === candidate.sym)) {
      // Check if selling a holding could cover the USDC gap
      const gap = MIN_POSITION_VALUE - usdcForBuy;
      const canSell = nonStablePositions.some(p => p.value >= gap && p.value >= MIN_TRADE && candidate.sc >= (p.score || 0));
      if (canSell) {
        action = 'BUY'; reason = `Buy ${candidate.sym} (sc=${candidate.sc}) #${nonStablePositions.length + 1}/${MAX_POSITIONS} (sell to raise USDC)`;
      } else {
        reason = `${candidate.sym} available but not enough accessible value`;
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
    if (usdcForTopup >= MIN_POSITION_VALUE) {
      const sortedPos = [...nonStablePositions].sort((a, b) => (b.score || 0) - (a.score || 0));
      const grandTotalT = investableTotal;
      for (let i = 0; i < sortedPos.length; i++) {
        const pos = sortedPos[i];
        const pct = tierPct(i, nonStablePositions.length);
        const maxVal = grandTotalT * pct;
        const room = maxVal - pos.value;
        if (room >= MIN_POSITION_VALUE) {
          action = 'TOPUP'; reason = `Top up ${pos.sym} (sc=${pos.score}) $${room.toFixed(2)} room to ${(pct*100).toFixed(0)}%`;
          break;
        }
      }
    }
  }
  if (!reason && action === 'HOLD') {
    if (nonStablePositions.length >= MAX_POSITIONS) {
      const worst = nonStablePositions.reduce((w, p) => p.score < (w?.score ?? Infinity) ? p : w, nonStablePositions[0]);
      const bestCandidates = ranked.filter(a => a.sc >= 3 && routeInv.has(a.sym)).slice(0, 3).map(a => `${a.sym}(sc=${a.sc})`).join(', ') || 'none';
      reason = `At cap ${nonStablePositions.length}/${MAX_POSITIONS} (worst=${worst.sym} sc=${worst.score}) | available: ${bestCandidates}`;
    } else {
      reason = 'No sell/rotate triggers, waiting';
    }
  }

  log(`Decision: ${action} — ${reason}`);

  // Execute
  let lastSwapFee = 0;
  let newFailedTokens = new Set();
  if (action !== 'HOLD' && ok && canExec) {
    log('Executing...');

    if (action === 'SELL_ALL') {
      for (const p of nonStablePositions) {
        if (p.value < MIN_TRADE) continue;
        const liq = await checkLiquidity(p.id, USDC_NEAR, p.raw);
        if (!liq) { log(`  ⚠️ ${p.sym} has no sell route, marking failed`); newFailedTokens.add(p.sym); continue; }
        log(`Sell ${p.sym}→USDC...`);
        const r = await execSwap(p, { id: USDC_NEAR, sym: 'USDC', dec: 6 }, p.raw, env.pk, assets);
        if (r?.feeUsd || r?.spread) lastSwapFee = r.feeUsd || 0;
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
          }
          delete costBasis[p.sym]; saveCostBasis(costBasis); delete holdStart[p.sym]; markTrade(); break;
        }
        else log(`  Sell skipped (spread ${r?.spread?.toFixed(1) || '?'}%)`);
      }
    } else if (action === 'SELL') {
      const p = nonStablePositions.find(x => reason.startsWith(x.sym));
      if (p) {
        const liq = await checkLiquidity(p.id, USDC_NEAR, p.raw);
        if (!liq) { log(`  ⚠️ ${p.sym} has no sell route, skipping`); newFailedTokens.add(p.sym); }
        else {
          log(`Sell ${p.sym}→USDC...`);
          const r = await execSwap(p, { id: USDC_NEAR, sym: 'USDC', dec: 6 }, p.raw, env.pk, assets);
          if (r?.feeUsd || r?.spread) lastSwapFee = r.feeUsd || 0;
          if (r?.ok) {
            const sellBi = bals.findIndex(b => b.sym === p.sym);
            if (sellBi >= 0) bals[sellBi].human = 0;
            const usdcBi = bals.findIndex(b => b.sym === 'USDC');
            if (usdcBi >= 0 && r.out) bals[usdcBi].human += Number(r.out);
            const scb2 = costBasis[p.sym];
            if (scb2?.cost && r.out) {
              const sp2 = Number(r.out);
              const spnl2 = sp2 - scb2.cost;
              log(`  ✅ Sold ${p.sym} → ${r.out} USDC (${spnl2 >= 0 ? '+' : ''}$${spnl2.toFixed(2)}, ${spnl2 >= 0 ? '+' : ''}${(spnl2 / scb2.cost * 100).toFixed(1)}%) [spread ${r.spread?.toFixed(2) || 0}%${(r.feeUsd || 0) > 0 ? `, fee $${r.feeUsd.toFixed(4)}` : ''}]`);
            }
            delete costBasis[p.sym]; saveCostBasis(costBasis); delete holdStart[p.sym];
          }
          if (!r?.ok) log(`  Sell skipped (spread ${r?.spread?.toFixed(1) || '?'}%)`);
        }
      }
    } else if (action === 'REBALANCE') {
      const p = nonStablePositions.find(x => reason.startsWith(x.sym));
      if (p) {
        const rebalSorted = [...nonStablePositions].sort((a, b) => (b.score || 0) - (a.score || 0));
        const rebalRank = rebalSorted.findIndex(x => x.sym === p.sym);
        const rebalTier = tierPct(rebalRank >= 0 ? Math.min(rebalRank, 2) : 2, nonStablePositions.length);
        const liq = await checkLiquidity(p.id, USDC_NEAR, p.raw);
        if (!liq) { log(`  ⚠️ ${p.sym} has no sell route, cannot rebalance`); newFailedTokens.add(p.sym); }
        else {
          const heldSyms = new Set(nonStablePositions.map(x => x.sym));
          let buyBest = null;
          for (const best of ranked) {
        if (best.sc < 4) break;
            if (best.sym === p.sym || failedTokens.has(best.sym) || raisedSyms[best.sym] || (best.r !== undefined && best.r >= 80) || !routeInv.has(best.sym)) continue;
            if (heldSyms.has(best.sym)) {
              const curVal = nonStablePositions.find(x => x.sym === best.sym)?.value || 0;
              const grandTotal = investableTotal;
              const sorted = [...nonStablePositions].sort((a, b) => (b.score || 0) - (a.score || 0));
              const rankIdx = sorted.findIndex(x => x.sym === best.sym);
              const maxPct = tierPct(rankIdx, nonStablePositions.length);
              const maxAllowed = grandTotal * maxPct;
              if (curVal >= maxAllowed) continue;
            }
            const target = PORTFOLIO.find(x => x.sym === best.sym);
            if (!target) continue;
            const est = Math.floor(Math.max(MIN_POSITION_VALUE, (usdcBal?.human || 0) * 0.3) * 1e6).toString();
            const routeOk = await checkLiquidity(USDC_NEAR, target.id, est);
            if (routeOk) { buyBest = best; break; }
            log(`  ⚠️ ${best.sym} no buy route, skipping`);
          }
          if (!buyBest) {
            log(`  No buyable target found, rebalance skipped`);
          } else {
            log(`Rebalance ${p.sym}→USDC...`);
            const r = await execSwap(p, { id: USDC_NEAR, sym: 'USDC', dec: 6 }, p.raw, env.pk, assets);
            if (r?.feeUsd || r?.spread) lastSwapFee = r.feeUsd || 0;
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
              }
              raisedSyms[p.sym] = Date.now();
              saveRaisedSyms(raisedSyms);
              delete costBasis[p.sym];
              saveCostBasis(costBasis);
              const target = PORTFOLIO.find(x => x.sym === buyBest.sym);
              if (target && usdcBal.human >= MIN_POSITION_VALUE) {
                const grandTotal = investableTotal;
                let buyUsd = Math.max(MIN_POSITION_VALUE, Math.min(usdcBal.human, grandTotal * rebalTier));
                const amt2 = Math.floor(buyUsd * 1e6);
                if (amt2 >= Math.floor(MIN_POSITION_VALUE * 1e6)) {
                  log(`Rebalance into ${buyBest.sym} $${buyUsd.toFixed(2)} (#${nonStablePositions.length + 1}/${MAX_POSITIONS})...`);
                  const r2 = await execSwap({ id: USDC_NEAR, sym: 'USDC', dec: 6 }, target, amt2.toString(), env.pk, assets);
                  if (r2?.feeUsd || r2?.spread) (typeof lastSwapFee === 'number' ? lastSwapFee += (r2.feeUsd || 0) : lastSwapFee = (r2.feeUsd || 0));
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
                      spread: r2?.spread || prevRb?.spread || 0,
                      fee: (prevRb?.fee || 0) + (r2?.feeUsd || 0),
                      qty: (prevRb?.qty || 0) + outRb,
                      price: outRb > 0 ? buyUsd / outRb : (prevRb?.price || 0),
                    };
                    saveCostBasis(costBasis);
                    markTrade();
                    log(`  ✅ Rebalance complete: ${p.sym}→${buyBest.sym}`);
                  }
                }
              }
            } else {
              log(`  Rebalance skipped (spread ${r?.spread?.toFixed(1) || '?'}%)`);
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
      if (!liq) { log(`  ⚠️ ${worst.sym} has no sell route, cannot rotate`); newFailedTokens.add(worst.sym); }
      else {
        const heldSyms = new Set(nonStablePositions.map(p => p.sym));
        let buyBest = null;
        for (const best of ranked) {
          if (best.sc < 3) break;
          if (failedTokens.has(best.sym) || raisedSyms[best.sym] || (best.r !== undefined && best.r >= 80) || !routeInv.has(best.sym)) continue;
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
          const target = PORTFOLIO.find(p => p.sym === best.sym);
          if (!target) continue;
          const est = Math.floor(Math.max(MIN_POSITION_VALUE, (usdcBal?.human || 0) * 0.3) * 1e6).toString();
          const routeOk = await checkLiquidity(USDC_NEAR, target.id, est);
          if (routeOk) { buyBest = best; break; }
          log(`  ⚠️ ${best.sym} no buy route, skipping`);
        }
        if (!buyBest) {
          log(`  No buyable target found, rotate skipped`);
        } else {
          log(`Rotate ${worst.sym}→USDC...`);
          const r = await execSwap(worst, { id: USDC_NEAR, sym: 'USDC', dec: 6 }, worst.raw, env.pk, assets);
          if (r?.feeUsd || r?.spread) lastSwapFee = r.feeUsd || 0;
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
            }
            raisedSyms[worst.sym] = Date.now();
            saveRaisedSyms(raisedSyms);
            delete costBasis[worst.sym];
            saveCostBasis(costBasis);
            delete holdStart[worst.sym];
            const target = PORTFOLIO.find(p => p.sym === buyBest.sym);
            if (target && usdcBal.human >= MIN_POSITION_VALUE) {
              const grandTotal = investableTotal;
              let buyUsd = Math.max(MIN_POSITION_VALUE, Math.min(usdcBal.human, grandTotal * worstTier));
              const amt2 = Math.floor(buyUsd * 1e6);
              if (amt2 >= Math.floor(MIN_POSITION_VALUE * 1e6)) {
                log(`Rotate into ${buyBest.sym} $${buyUsd.toFixed(2)} (#${nonStablePositions.length + 1}/${MAX_POSITIONS})...`);
                const r2 = await execSwap({ id: USDC_NEAR, sym: 'USDC', dec: 6 }, target, amt2.toString(), env.pk, assets);
                if (r2?.feeUsd || r2?.spread) (typeof lastSwapFee === 'number' ? lastSwapFee += (r2.feeUsd || 0) : lastSwapFee = (r2.feeUsd || 0));
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
                    spread: r2?.spread || prevRt?.spread || 0,
                    fee: (prevRt?.fee || 0) + (r2?.feeUsd || 0),
                    qty: (prevRt?.qty || 0) + outRt,
                    price: outRt > 0 ? buyUsd / outRt : (prevRt?.price || 0),
                  };
                  saveCostBasis(costBasis);
                  markTrade();
                  holdStart[buyBest.sym] = Date.now();
                  log(`  ✅ Rotate complete: ${worst.sym}→${buyBest.sym}`);
                }
              }
            }
          } else {
            log(`  Rotate skipped (spread ${r?.spread?.toFixed(1) || '?'}%)`);
          }
        }
      }
    } else if (action === 'BUY') {
      let soldSyms = new Set();
      if ((!usdcBal || usdcBal.human < MIN_POSITION_VALUE) && nonStablePositions.length > 0) {
        const slotIdxR = Math.min(nonStablePositions.length, 2);
        const grandTotalR = investableTotal;
        const targetBuyUsd = Math.max(MIN_POSITION_VALUE, grandTotalR * tierPct(slotIdxR, nonStablePositions.length + 1));
        const shortfall = Math.max(0, targetBuyUsd - (usdcBal?.human || 0));
        const sellCandidates = [...nonStablePositions].filter(p => !raisedSyms[p.sym]).sort((a, b) => (a.score || 999) - (b.score || 999));
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
          if (!liq) { log(`  ⚠️ ${sellP.sym} no sell route, cannot raise USDC`); continue; }
          log(`  Raise USDC: sell ${sellP.sym} ($${isFullSell ? sellP.value.toFixed(2) : shortfall.toFixed(2)})...`);
          const r = await execSwap(sellP, { id: USDC_NEAR, sym: 'USDC', dec: 6 }, rawToSell, env.pk, assets);
          if (r?.feeUsd || r?.spread) lastSwapFee = (lastSwapFee || 0) + (r.feeUsd || 0);
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
              }
              const idx = nonStablePositions.findIndex(p => p.sym === sellP.sym);
              if (idx >= 0) nonStablePositions.splice(idx, 1);
              if (sellBu >= 0) bals[sellBu].human = 0;
              soldSyms.add(sellP.sym);
              raisedSyms[sellP.sym] = Date.now();
              saveRaisedSyms(raisedSyms);
              delete costBasis[sellP.sym];
              saveCostBasis(costBasis);
              delete holdStart[sellP.sym];
            } else {
              if (sellBu >= 0) {
                const rawRemaining = BigInt(bals[sellBu].raw) - BigInt(rawToSell);
                bals[sellBu].raw = rawRemaining.toString();
                bals[sellBu].human = Number(rawRemaining) / 10 ** sellDec;
                const nsp = nonStablePositions.find(p => p.sym === sellP.sym);
                if (nsp) { nsp.raw = bals[sellBu].raw; nsp.human = bals[sellBu].human; }
              }
              if (costBasis[sellP.sym]) {
                const rawSellNum = Number(BigInt(rawToSell));
                const rawTotalNum = Number(BigInt(sellP.raw));
                const soldFrac = rawTotalNum > 0 ? rawSellNum / rawTotalNum : 0;
                const soldCost = costBasis[sellP.sym].cost * soldFrac;
                const proceedsPs = Number(r.out) || 0;
                const pnlPs = proceedsPs - soldCost;
                log(`  ✅ Sold partial ${sellP.sym} → ${r.out} USDC (${pnlPs >= 0 ? '+' : ''}$${pnlPs.toFixed(2)}, ${pnlPs >= 0 ? '+' : ''}${(pnlPs / (soldCost || 1) * 100).toFixed(1)}%) [spread ${r.spread?.toFixed(2) || 0}%${(r.feeUsd || 0) > 0 ? `, fee $${r.feeUsd.toFixed(4)}` : ''}]`);
                costBasis[sellP.sym].cost *= (1 - soldFrac);
                costBasis[sellP.sym].qty *= (1 - soldFrac);
                saveCostBasis(costBasis);
              }
            }
            const usdcBu = bals.findIndex(b => b.sym === 'USDC');
            if (usdcBu >= 0 && r.out) bals[usdcBu].human += Number(r.out);
            log(`  USDC raised to $${usdcBal.human.toFixed(2)}`);
          } else {
            log(`  Raise USDC failed for ${sellP.sym}${r ? ' (spread ' + r.spread?.toFixed(1) + '%)' : ''}`);
          }
          break;
        }
      }
      const heldSyms = new Set([...nonStablePositions.map(p => p.sym), ...soldSyms]);
      const tried = new Set();
      for (const best of ranked) {
        if (best.sc < 3) break;
        if (tried.has(best.sym) || failedTokens.has(best.sym) || raisedSyms[best.sym] || (best.r !== undefined && best.r >= 80) || !routeInv.has(best.sym)) continue;
        if (heldSyms.has(best.sym)) continue;
        tried.add(best.sym);
        const target = PORTFOLIO.find(p => p.sym === best.sym);
        if (!target) continue;
        if (!usdcBal || usdcBal.human < MIN_POSITION_VALUE) continue;
        const slotIdx = Math.min(nonStablePositions.length, 2);
        const grandTotal = investableTotal;
        let buyUsd = Math.max(MIN_POSITION_VALUE, Math.min(usdcBal.human, grandTotal * tierPct(slotIdx, nonStablePositions.length + 1)));
        const amt = Math.floor(buyUsd * 1e6);
        if (amt < Math.floor(MIN_POSITION_VALUE * 1e6)) break;
        const liq = await checkLiquidity(USDC_NEAR, target.id, amt.toString());
        if (!liq) { log(`  ⚠️ ${best.sym} no buy route`); newFailedTokens.add(best.sym); continue; }
        log(`Buy ${best.sym} $${buyUsd.toFixed(2)} (#${nonStablePositions.length + 1}/${MAX_POSITIONS})...`);
        const r = await execSwap({ id: USDC_NEAR, sym: 'USDC', dec: 6 }, target, amt.toString(), env.pk, assets);
        if (r?.feeUsd || r?.spread) lastSwapFee += (r.feeUsd || 0);
        if (r?.ok) {
          const usdcB2 = bals.findIndex(b => b.sym === 'USDC');
          if (usdcB2 >= 0) bals[usdcB2].human -= buyUsd;
          const buyB2 = bals.findIndex(b => b.sym === target.sym);
          if (buyB2 >= 0 && r.out) bals[buyB2].human += Number(r.out);
          raisedSyms[target.sym] = Date.now(); saveRaisedSyms(raisedSyms);
          const prevCb = costBasis[target.sym];
          const outQty = Number(r.out) || 0;
            costBasis[target.sym] = {
            cost: (prevCb?.cost || 0) + buyUsd,
            spread: r?.spread || prevCb?.spread || 0,
            fee: (prevCb?.fee || 0) + (r?.feeUsd || 0),
            qty: (prevCb?.qty || 0) + outQty,
            price: outQty > 0 ? buyUsd / outQty : (prevCb?.price || 0),
          };
          saveCostBasis(costBasis);
          const buyPrice = outQty > 0 ? buyUsd / outQty : 0;
          log(`  Cost: $${buyUsd.toFixed(2)} @ $${buyPrice.toFixed(4)}/ea [spread ${r?.spread?.toFixed(2) || 0}%${(r?.feeUsd || 0) > 0 ? `, fee $${r.feeUsd.toFixed(4)}` : ''}]`);
          holdStart[target.sym] = Date.now();
          markTrade(); break;
        } else {
          if (r === null) newFailedTokens.add(best.sym);
          log(`  Buy skipped (spread ${r?.spread?.toFixed(1) || '?'}%)`);
        }
      }
    } else if (action === 'TOPUP') {
      const topupSym = reason.split(' ')[2];
      const target = PORTFOLIO.find(p => p.sym === topupSym);
      const pos = nonStablePositions.find(p => p.sym === topupSym);
      if (target && pos && usdcBal?.human >= MIN_POSITION_VALUE) {
        const grandTotal = investableTotal;
        const sortedPos = [...nonStablePositions].sort((a, b) => (b.score || 0) - (a.score || 0));
        const rank = sortedPos.findIndex(p => p.sym === topupSym);
        const maxVal = grandTotal * tierPct(rank, nonStablePositions.length);
        const room = maxVal - pos.value;
        let buyUsd = Math.max(MIN_POSITION_VALUE, Math.min(usdcBal.human, room));
        const amt = Math.floor(buyUsd * 1e6);
        if (amt >= Math.floor(MIN_POSITION_VALUE * 1e6)) {
          const liq = await checkLiquidity(USDC_NEAR, target.id, amt.toString());
          if (!liq) { log(`  ⚠️ ${topupSym} no buy route`); }
          else {
            log(`Top up ${topupSym} $${buyUsd.toFixed(2)} (room to $${(room + pos.value).toFixed(2)})...`);
            const r = await execSwap({ id: USDC_NEAR, sym: 'USDC', dec: 6 }, target, amt.toString(), env.pk, assets);
            if (r?.feeUsd || r?.spread) lastSwapFee += (r.feeUsd || 0);
            if (r?.ok) {
              const usdcBi = bals.findIndex(b => b.sym === 'USDC');
              if (usdcBi >= 0) bals[usdcBi].human -= buyUsd;
              const buyBi = bals.findIndex(b => b.sym === target.sym);
              if (buyBi >= 0 && r.out) bals[buyBi].human += Number(r.out);
              const prevCb = costBasis[target.sym];
              const outQty = Number(r.out) || 0;
              costBasis[target.sym] = {
                cost: (prevCb?.cost || 0) + buyUsd,
                spread: r?.spread || prevCb?.spread || 0,
                fee: (prevCb?.fee || 0) + (r?.feeUsd || 0),
                qty: (prevCb?.qty || 0) + outQty,
                price: outQty > 0 ? buyUsd / outQty : (prevCb?.price || 0),
              };
              saveCostBasis(costBasis);
              markTrade();
              const buyPrice = outQty > 0 ? buyUsd / outQty : 0;
              log(`  Cost: $${buyUsd.toFixed(2)} @ $${buyPrice.toFixed(4)}/ea [spread ${r?.spread?.toFixed(2) || 0}%${(r?.feeUsd || 0) > 0 ? `, fee $${r.feeUsd.toFixed(4)}` : ''}]`);
            } else {
              log(`  Top up skipped${r ? ' (spread ' + r.spread?.toFixed(1) + '%)' : ''}`);
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
    hasPositions = bals.filter(b => b.human > 0);
    pricedPositions = hasPositions.map(h => {
      const p = h.sym === 'USDC' ? 1 : (assets[h.sym]?.p || 0);
      return { ...h, price: p, value: p * h.human, score: h.sym === 'USDC' ? 0 : (assets[h.sym]?.sc || 0), ch: assets[h.sym]?.ch, rsi: rsis[h.sym] };
    });
  }

  // Portfolio summary + P&L
  const nearPrice = assets['wNEAR']?.p || 0;
  const nearValue = nearBal * nearPrice;
  const allValues = [...pricedPositions.map(p => p.value), nearValue];
  const grandTotal = allValues.reduce((s, v) => s + v, 0);

  let history = [];
  try { history = JSON.parse(fs.readFileSync(HISTORY_FILE, 'utf8')); } catch(e) {}
  if (!Array.isArray(history)) history = [];
  const last = history.length > 0 ? history[history.length - 1] : null;
  const prevTotal = last ? last.total : INITIAL_VALUE;
  let accruedFees = last ? (last.totalFees || 0) : 0;
  const pnlFromInit = grandTotal - INITIAL_VALUE;
  const pnlFromInitPct = INITIAL_VALUE > 0 ? (pnlFromInit / INITIAL_VALUE) * 100 : 0;
  const pnlFromPrev = grandTotal - prevTotal;
  const pnlFromPrevPct = prevTotal > 0 ? (pnlFromPrev / prevTotal) * 100 : 0;

  // Accumulate swap fees
  if (typeof lastSwapFee === 'number' && lastSwapFee > 0) accruedFees += lastSwapFee;

  // Merge new failed tokens into existing list
  for (const s of newFailedTokens) {
    failedTokens.add(s);
    failCooldown[s] = Date.now();
  }
  saveFailCooldown(failCooldown);
  const now = new Date();
  history.push({ t: now.toISOString(), total: grandTotal, totalFees: accruedFees, near: nearValue, nearBal, failedTokens: [...failedTokens], pos: pricedPositions.filter(p => p.value > 0).map(p => ({ s: p.sym, q: p.human, v: p.value })) });
  history = history.slice(-100);
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2)); } catch(e) {}

  log('── Portfolio ──');
  for (const p of pricedPositions) {
    if (p.value > 0 || p.human > 0) {
      const cb = costBasis[p.sym];
      let pnlStr = '';
      if (cb !== undefined && cb !== null && cb.cost !== undefined && cb.cost > 0) {
        const pnl = p.value - cb.cost;
        const pnlPct = (pnl / cb.cost) * 100;
        const feeStr = cb.fee > 0 ? `, $${cb.fee.toFixed(4)} fee` : '';
        const spreadStr = cb.spread > 0 ? ` [buy: ${cb.spread.toFixed(2)}% spread${feeStr}]` : '';
        pnlStr = ` (${pnl >= 0 ? '+' : ''}$${pnl.toFixed(2)}, ${pnl >= 0 ? '+' : ''}${pnlPct.toFixed(1)}%)${spreadStr}`;
      }
      log(`  ${p.sym}: ${p.human.toFixed(p.sym==='USDC'?2:p.sym==='NEAR'?3:6)} × $${p.price.toFixed(4)} = $${p.value.toFixed(2)}${pnlStr}`);
    }
  }
  if (nearBal > 0) log(`  NEAR: ${nearBal.toFixed(3)} × $${nearPrice.toFixed(2)} = $${nearValue.toFixed(2)}`);
  const pnlStr = (pnlFromPrev >= 0 ? '+' : '') + pnlFromPrev.toFixed(2);
  const pnlPctStr = (pnlFromPrevPct >= 0 ? '+' : '') + pnlFromPrevPct.toFixed(2);
  const initPnlStr = (pnlFromInit >= 0 ? '+' : '') + pnlFromInit.toFixed(2);
  const initPnlPctStr = (pnlFromInitPct >= 0 ? '+' : '') + pnlFromInitPct.toFixed(2);
  const perf = grandTotal - INITIAL_VALUE + accruedFees;
  log(`  Total: $${grandTotal.toFixed(2)} | Δprev: ${pnlStr} (${pnlPctStr}%) | Δstart: ${initPnlStr} (${initPnlPctStr}%) | Fees: $${accruedFees.toFixed(2)} | Perf: $${perf.toFixed(2)}`);
  log('── ─────── ──');

  log('=== DONE ===');
}

main().catch(e => log('ERR:', e.message));

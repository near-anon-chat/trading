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
const MAX_POSITIONS = 3;
const MIN_POSITION_VALUE = 5.0;
const MAX_SPREAD_PCT = 4.0;

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
const CG_FALLBACKS = { KAITO: 'kaito', VVV: 'venice-token', AURORA: 'aurora-near', GNO: 'gnosis', XAUT: 'tether-gold', MON: 'mon-protocol' };
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

function httpGet(url, hdrs = {}) {
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

function httpPost(url, data, hdrs = {}) {
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

const sleep = ms => new Promise(r => setTimeout(r, ms));

async function fetchFG() {
  try {
    const f = await httpGet('https://api.alternative.me/fng/');
    return { v: parseInt(f?.data?.[0]?.value || 50), t: f?.data?.[0]?.value_classification || '?' };
  } catch(e) { return { v: 50, t: '?' }; }
}

async function fetchCGData(ids) {
  if (!ids.length) return {};
  try {
    const r = await httpGet(`https://api.coingecko.com/api/v3/simple/price?ids=${ids.join(',')}&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true`);
    log('CG prices:', Object.keys(r).join(','));
    return r;
  } catch(e) {
    log('CG price err:', e.message);
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

function canTrade() {
  try { const t = parseInt(fs.readFileSync(LAST_TRADE, 'utf8').trim()); if (!isNaN(t) && Date.now() - t < COOLDOWN_MS) return false; } catch(e) {}
  return true;
}
function markTrade() { try { fs.writeFileSync(LAST_TRADE, Date.now().toString()); } catch(e) {} }

async function main() {
  log('=== AGENT RUN ===');
  const env = loadEnv();
  const canExec = !!(env.jwt && env.pk);
  if (!canExec) log('Monitor-only mode: add JWT to .env to enable swaps');
  else log('Full mode: swap execution enabled');

  const ok = canTrade();
  if (!ok) log('Cooldown active');

  // Market data
  const fg = await fetchFG();
  log(`F&G: ${fg.v}/100 ${fg.t}`);

  const allCgIds = [...new Set(Object.values(CG_IDS))];
  const [cgData, clickPrices] = await Promise.all([fetchCGData(allCgIds), fetch1ClickPrices()]);

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
  // omdep.near tokens confirmed no swap routes on 1Click
  for (const sym of ['GLDon', 'TLTon', 'AGGon', 'USDon']) failedTokens.add(sym);

  // RSI — held tokens (from history) + top 15 scorers
  const sorted = Object.entries(assets).sort((a, b) => b[1].sc - a[1].sc);
  const top15 = sorted.slice(0, 15).map(e => e[0]);
  const rsiFor = [...new Set([...lastPos, ...top15])].filter(s => CG_IDS[s] && CG_IDS[s] !== 'near');

  const rsis = {};
  for (const sym of rsiFor) {
    const id = CG_IDS[sym];
    const c = await fetchOHLC(id);
    if (c) rsis[sym] = rsi(c);
    await sleep(2000);
  }
  // ETF RSI from stored data
  for (const [sym, d] of Object.entries(etfData)) {
    if (d?.c?.length >= 14) rsis[sym] = rsi(d.c);
  }

  // Top assets ranked
  const ranked = sorted.map(([sym, a]) => ({ sym, ...a, r: rsis[sym] }));
  const downCount = ranked.slice(0, 15).filter(a => a.ch < 0).length;

  log('Top 5:');
  ranked.slice(0, 5).forEach(a => log(`  ${a.sym}: sc=${a.sc} $${a.p?.toFixed(4)||'?'} ${a.ch?.toFixed(1)||'?'}% RS${a.r !== undefined ? 'I='+a.r.toFixed(0) : '--'}`));

  // Portfolio
  const bals = await fetchBals();
  const hasPositions = bals.filter(b => b.human > 0.0001);
  const nearBal = await fetchNearBal();
  log(`NEAR: ${nearBal.toFixed(3)}`);
  for (const b of hasPositions) log(`  ${b.sym}: ${b.human.toFixed(6)}`);

  // Valuations
  const pricedPositions = hasPositions.map(h => {
    const p = h.sym === 'USDC' ? 1 : (assets[h.sym]?.p || 0);
    return { ...h, price: p, value: p * h.human, score: h.sym === 'USDC' ? 0 : (assets[h.sym]?.sc || 0), ch: assets[h.sym]?.ch, rsi: rsis[h.sym] };
  });
  const totalValue = pricedPositions.reduce((s, p) => s + p.value, 0);
  // exclude USDC from total for decision purposes (it's the stable)
  const nonStablePositions = pricedPositions.filter(p => p.sym !== 'USDC' && p.value >= MIN_TRADE);
  const usdcBal = pricedPositions.find(p => p.sym === 'USDC');

  // Decision
  let action = 'HOLD', reason = '';

  if (nearBal < GAS_RESERVE) {
    action = 'HOLD'; reason = `Low gas (${nearBal.toFixed(2)} NEAR)`;
  } else if (nonStablePositions.length > 0) {
    // Check each existing position for weakness first
    for (const p of nonStablePositions) {
      if (p.rsi !== undefined && p.rsi > 85) { action = 'SELL'; reason = `${p.sym} OB RSI=${p.rsi.toFixed(0)}`; break; }
      // Only trust score-based sell if price data is fresh (24h_change was actually fetched)
      if (p.score < 1 && p.ch !== undefined && p.ch !== null && p.ch !== 0) { action = 'SELL'; reason = `${p.sym} weak sc=${p.score}`; break; }
    }
    // Check rotation if no immediate sell
    if (action === 'HOLD') {
      const worst = nonStablePositions.reduce((w, p) => p.score < (w?.score ?? Infinity) ? p : w, nonStablePositions[0]);
      const bestNew = ranked.find(a => a.sc >= 3 && (a.r === undefined || a.r < 80) && !failedTokens.has(a.sym) && !nonStablePositions.find(p => p.sym === a.sym) && a.sc >= (worst?.score || 0) + 3);
      if (bestNew) { action = 'ROTATE'; reason = `${bestNew.sym}(${bestNew.sc}) > ${worst.sym}(${worst.score})`; }
    }
  }
  // If no sell/rotate and room to buy more
  if (action === 'HOLD' && nonStablePositions.length < MAX_POSITIONS) {
    const heldSyms = new Set(nonStablePositions.map(p => p.sym));
    const candidate = ranked.find(a => a.sc >= 3 && (a.r === undefined || a.r < 80) && !failedTokens.has(a.sym) && !heldSyms.has(a.sym));
    const usdcForBuy = usdcBal?.human || 0;
    if (candidate && PORTFOLIO.find(p => p.sym === candidate.sym) && usdcForBuy >= MIN_POSITION_VALUE) {
      action = 'BUY'; reason = `Buy ${candidate.sym} (sc=${candidate.sc}) #${nonStablePositions.length + 1}/${MAX_POSITIONS}`;
    } else if (candidate) {
      reason = `${candidate.sym} available but not tradeable or too small buy`;
    } else if (nonStablePositions.length === 0) {
      reason = 'No positions, waiting for crypto opp (sc≥3 RSI<80)';
    } else {
      reason = `Holding ${nonStablePositions.length}/${MAX_POSITIONS}, no better candidate found`;
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
        log(`Sell ${p.sym}→USDC...`);
        const r = await execSwap(p, { id: USDC_NEAR, sym: 'USDC', dec: 6 }, p.raw, env.pk, assets);
        if (r?.feeUsd || r?.spread) lastSwapFee = r.feeUsd || 0;
        if (r?.ok) { markTrade(); break; }
        else log(`  Sell skipped (spread ${r?.spread?.toFixed(1) || '?'}%)`);
      }
    } else if (action === 'SELL') {
      const p = nonStablePositions.find(x => reason.startsWith(x.sym));
      if (p) {
        log(`Sell ${p.sym}→USDC...`);
        const r = await execSwap(p, { id: USDC_NEAR, sym: 'USDC', dec: 6 }, p.raw, env.pk, assets);
        if (r?.feeUsd || r?.spread) lastSwapFee = r.feeUsd || 0;
        if (r?.ok) markTrade();
        else log(`  Sell skipped (spread ${r?.spread?.toFixed(1) || '?'}%)`);
      }
    } else if (action === 'ROTATE') {
      const worst = nonStablePositions.reduce((w, p) => p.score < (w?.score ?? Infinity) ? p : w, nonStablePositions[0]);
      log(`Rotate ${worst.sym}→USDC...`);
      const r = await execSwap(worst, { id: USDC_NEAR, sym: 'USDC', dec: 6 }, worst.raw, env.pk, assets);
      if (r?.feeUsd || r?.spread) lastSwapFee = r.feeUsd || 0;
      if (r?.ok) markTrade();
      else log(`  Rotate skipped (spread ${r?.spread?.toFixed(1) || '?'}%)`);
    } else if (action === 'BUY') {
      const heldSyms = new Set(nonStablePositions.map(p => p.sym));
      const tried = new Set();
      for (const best of ranked) {
        if (best.sc < 3) break;
        if (tried.has(best.sym) || heldSyms.has(best.sym) || failedTokens.has(best.sym) || (best.r !== undefined && best.r >= 80)) continue;
        tried.add(best.sym);
        const target = PORTFOLIO.find(p => p.sym === best.sym);
        if (!target) continue;
        if (!(usdcBal?.human > MIN_POSITION_VALUE / (assets[best.sym]?.p || 1))) continue;
        let buyUsd = 0;
        if (nonStablePositions.length === 0) {
          buyUsd = usdcBal.human * 0.6;
        } else if (nonStablePositions.length === 1) {
          buyUsd = Math.min(MIN_POSITION_VALUE, usdcBal.human - 0.5);
        } else {
          buyUsd = usdcBal.human - 0.5;
        }
        const amt = Math.floor(buyUsd * 1e6);
        if (amt < Math.floor(MIN_POSITION_VALUE * 1e6)) break;
        log(`Buy ${best.sym} $${buyUsd.toFixed(2)} (#${nonStablePositions.length + 1}/${MAX_POSITIONS})...`);
        const r = await execSwap({ id: USDC_NEAR, sym: 'USDC', dec: 6 }, target, amt.toString(), env.pk, assets);
        if (r?.feeUsd || r?.spread) lastSwapFee = r.feeUsd || 0;
        if (r?.ok) { markTrade(); break; }
        else {
          if (r === null) newFailedTokens.add(best.sym);
          log(`  Buy skipped (spread ${r?.spread?.toFixed(1) || '?'}%)`);
        }
      }
    }
  } else if (action !== 'HOLD' && !canExec) {
    log(`Would ${action} but monitor-only (add JWT to .env)`);
  } else if (action !== 'HOLD' && !ok) {
    log(`Would trade but cooldown`);
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
  for (const s of newFailedTokens) failedTokens.add(s);
  const now = new Date();
  history.push({ t: now.toISOString(), total: grandTotal, totalFees: accruedFees, near: nearValue, nearBal, failedTokens: [...failedTokens], pos: pricedPositions.filter(p => p.value > 0).map(p => ({ s: p.sym, q: p.human, v: p.value })) });
  history = history.slice(-100);
  try { fs.writeFileSync(HISTORY_FILE, JSON.stringify(history, null, 2)); } catch(e) {}

  log('── Portfolio ──');
  for (const p of pricedPositions) {
    if (p.value > 0 || p.human > 0) log(`  ${p.sym}: ${p.human.toFixed(p.sym==='USDC'?2:p.sym==='NEAR'?3:6)} × $${p.price.toFixed(4)} = $${p.value.toFixed(2)}`);
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

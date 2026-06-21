const https = require('https');
const fs = require('fs');

const MOM_CACHE_FILE = __dirname + '/.ohlc_cache.json';
const deepseek = require('./lib/deepseek.js');

const UA = 'Mozilla/5.0 OpenCode-Trading-Screener/1.0';

const cg = (path) => new Promise((resolve, reject) => {
  https.get('https://api.coingecko.com' + path, { headers: { 'Accept': 'application/json', 'User-Agent': UA } }, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      if (res.statusCode === 429) { reject(new Error('RATE_LIMITED')); return; }
      if (res.statusCode !== 200) { reject(new Error('CG ' + res.statusCode)); return; }
      try { resolve(JSON.parse(d)); } catch(e) { reject(new Error(d.slice(0,200))); }
    });
  }).on('error', reject);
});

async function fetchIntraday(id) {
  const cacheKey = `intra_${id}_${new Date().toISOString().slice(0, 10)}`;
  try {
    const cache = JSON.parse(fs.readFileSync(MOM_CACHE_FILE, 'utf8'));
    if (cache[cacheKey]) return cache[cacheKey];
  } catch(e) {}
  try {
    const d = await cg('/api/v3/coins/' + id + '/market_chart?vs_currency=usd&days=1');
    const prices = Array.isArray(d?.prices) ? d.prices.map(p => p[1]).filter(p => p > 0) : null;
    if (prices && prices.length >= 36) {
      try {
        let cache = {};
        try { cache = JSON.parse(fs.readFileSync(MOM_CACHE_FILE, 'utf8')); } catch(e) {}
        cache[cacheKey] = prices;
        fs.writeFileSync(MOM_CACHE_FILE, JSON.stringify(cache));
      } catch(e) {}
    }
    return prices;
  } catch(e) { return null; }
}

const yf = (symbol, range = '1mo') => new Promise((resolve, reject) => {
  https.get('https://query1.finance.yahoo.com/v8/finance/chart/' + symbol + '?interval=1d&range=' + range, { headers: { 'User-Agent': UA } }, res => {
    let d = '';
    res.on('data', c => d += c);
    res.on('end', () => {
      if (res.statusCode !== 200) { reject(new Error('YF ' + res.statusCode)); return; }
      try { resolve(JSON.parse(d).chart.result?.[0]); } catch(e) { reject(new Error(d.slice(0,200))); }
    });
  }).on('error', reject);
});

const sleep = ms => new Promise(r => setTimeout(r, ms));

const ONDO = {
  GOOGLon: 'GOOGL', SPYon: 'SPY', QQQon: 'QQQ', NVDAon: 'NVDA',
  AAPLon: 'AAPL', MSFTon: 'MSFT', TSLAon: 'TSLA', AMZNon: 'AMZN',
  METAon: 'META', GLDon: 'GLD', IAUon: 'IAU', SLVon: 'SLV',
  AGGon: 'AGG', TLTon: 'TLT', USDon: 'DX-Y.NYB'
};

function loadRouteInventory() {
  try {
    const raw = JSON.parse(fs.readFileSync(__dirname + '/.route_inventory.json', 'utf8'));
    return new Set(raw.tradable);
  } catch(e) { return new Set(); }
}

function loadCostBasis() {
  try {
    return JSON.parse(fs.readFileSync(__dirname + '/.cost_basis.json', 'utf8'));
  } catch(e) { return {}; }
}

function loadPortfolioHistory() {
  try {
    const hist = JSON.parse(fs.readFileSync(__dirname + '/portfolio_history.json', 'utf8'));
    return hist.length > 0 ? hist[hist.length - 1] : null;
  } catch(e) { return null; }
}

function buildHoldings(costBasis, latestSnapshot) {
  const holdings = {};
  if (!latestSnapshot?.pos) return holdings;
  for (const pos of latestSnapshot.pos) {
    if (pos.q <= 0 || pos.v < 0.50) continue;
    const cb = costBasis[pos.s];
    holdings[pos.s] = {
      amount: pos.q,
      buyPrice: cb ? cb.cost / cb.qty : null,
      chain: 'near'
    };
  }
  return holdings;
}

function scoreToken(chg, vol, type) {
  let s = 0;
  if (chg > 10) s += 5;
  else if (chg > 5) s += 3;
  else if (chg > 2) s += 2;
  else if (chg > 0) s += 1;
  else if (chg > -5) s -= 1;
  else s -= 2;
  if (vol > 5e8) s += 3;
  else if (vol > 5e7) s += 2;
  else if (vol > 5e6) s += 1;
  if (type === 'stock') s += 2;
  return s;
}

function computeRSI(closes) {
  if (closes.length < 15) return null;
  const gains = [], losses = [];
  for (let i = 1; i < closes.length; i++) {
    const diff = closes[i] - closes[i-1];
    gains.push(diff > 0 ? diff : 0);
    losses.push(diff < 0 ? -diff : 0);
  }
  const last14g = gains.slice(-14);
  const last14l = losses.slice(-14);
  const avgG = last14g.reduce((a, b) => a + b, 0) / 14;
  const avgL = last14l.reduce((a, b) => a + b, 0) / 14;
  if (avgL === 0 && avgG > 0) return 100;
  if (avgL === 0 && avgG === 0) return 50;
  const rs = avgG / avgL;
  return 100 - (100 / (1 + rs));
}

function intradayMom(prices) {
  if (!prices || prices.length < 36) return null;
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

async function main() {
  let fg = '?', fgc = '?';
  try {
    const f = await new Promise((res) => {
      https.get('https://api.alternative.me/fng/', { headers: { 'User-Agent': UA } }, r => { let d=''; r.on('data',c=>d+=c); r.on('end',()=>{try{res(JSON.parse(d))}catch(e){res(null)}}); }).on('error',()=>res(null));
    });
    fg = f?.data?.[0]?.value || '?'; fgc = f?.data?.[0]?.value_classification || '?';
  } catch(e) {}
  console.log('=== MARKET SENTIMENT ===');
  console.log('Fear & Greed: ' + fg + '/100 (' + fgc + ')\n');

  const routeInv = loadRouteInventory();
  console.log('Tradable routes: ' + routeInv.size + '\n');

  const tokens = require('./tokens.json');
  if (!tokens || !tokens.length) { console.error('Run: fetch fresh tokens from 1Click API'); return; }

  let coinList = [];
  try {
    const cached = require('fs').existsSync('./coinList.json') ? require('./coinList.json') : null;
    if (cached && cached.length) { coinList = cached; } else {
      coinList = await cg('/api/v3/coins/list');
      require('fs').writeFileSync(__dirname + '/coinList.json', JSON.stringify(coinList));
    }
  } catch(e) { console.error('CoinGecko list failed:', e.message); return; }

  const symMap = {};
  const uniqueSyms = [...new Set(tokens.map(t => t.symbol))].filter(s => !ONDO[s]);
  uniqueSyms.forEach(sym => {
    const m = coinList.filter(c => c.symbol === sym.toLowerCase().trim());
    if (m.length) symMap[sym] = m[0];
  });

  const ids = [...new Set(Object.values(symMap).map(v => v.id))];
  const prices = {};
  console.log('Fetching crypto prices (' + ids.length + ' tokens)...');
  for (let i = 0; i < ids.length; i += 20) {
    const batch = ids.slice(i, i + 20);
    try {
      const data = await cg('/api/v3/simple/price?ids=' + batch.join(',') + '&vs_currencies=usd&include_24hr_change=true&include_24hr_vol=true&include_market_cap=true');
      Object.assign(prices, data);
    } catch(e) { if (e.message === 'RATE_LIMITED') { console.log('  Rate limited, waiting 90s...'); await sleep(90000); i -= 20; continue; } }
    await sleep(5000);
  }

  const cryptoResults = [];
  Object.entries(symMap).forEach(([sym, info]) => {
    const d = prices[info.id];
    if (d?.usd) {
      cryptoResults.push({
        symbol: sym, name: info.name, type: 'crypto',
        price: d.usd, change24h: d.usd_24h_change || 0,
        volume24h: d.usd_24h_vol || 0, marketCap: d.usd_market_cap || 0
      });
    }
  });

  const ondoResults = [];
  console.log('Fetching stock/ETF prices (' + Object.keys(ONDO).length + ' symbols)...');
  for (const [nearSym, yfSym] of Object.entries(ONDO)) {
    try {
      const result = await yf(yfSym, '1mo');
      if (!result) continue;
      const meta = result.meta;
      const q = result.indicators.quote?.[0];
      const closes = result.indicators.adjclose?.[0]?.adjclose || q?.close || [];
      const volumes = q?.volume || [];
      let latestClose = meta.regularMarketPrice;
      let prevClose = meta.chartPreviousClose;
      let change24h = 0;
      if (latestClose && prevClose) { change24h = ((latestClose - prevClose) / prevClose) * 100; }
      const validCloses = closes.filter(c => c !== null);
      const validVolumes = volumes.filter(v => v !== null);
      ondoResults.push({
        symbol: nearSym, name: meta.longName || yfSym, type: 'stock',
        price: latestClose, change24h,
        volume24h: validVolumes[validVolumes.length-1] || 0,
        marketCap: 0, _closes: validCloses
      });
    } catch(e) {}
    await sleep(500);
  }

  const allResults = [...cryptoResults, ...ondoResults]
    .filter(r => r.price > 1e-8)
    .map(r => ({
      ...r,
      score: scoreToken(r.change24h, r.volume24h, r.type),
      tradable: routeInv.has(r.symbol)
    }))
    .sort((a, b) => b.score - a.score);

  console.log('\n' + '='.repeat(105));
  console.log('      ALL TRADING OPPORTUNITIES — CRYPTO + ETFs');
  console.log('='.repeat(105));
  console.log('#  Symbol      Price           24h Delta     Volume     Type  Score Route');
  console.log('-  ' + '-'.repeat(100));

  allResults.slice(0, 25).forEach((r, i) => {
    const ch = r.change24h >= 0 ? '+' : '';
    const vol = r.volume24h >= 1e9 ? (r.volume24h/1e9).toFixed(1)+'B' : r.volume24h >= 1e6 ? (r.volume24h/1e6).toFixed(0)+'M' : (r.volume24h/1e3).toFixed(0)+'K';
    const typeP = r.type === 'stock' ? 'ETF' : 'CRYPTO';
    const pStr = r.price >= 100 ? r.price.toFixed(2) : r.price >= 1 ? r.price.toFixed(4) : r.price.toFixed(8);
    const routeTag = r.tradable ? 'YES' : 'no';
    console.log((i+1).toString().padStart(2) + '. ' + r.symbol.padEnd(9) + ' $' + pStr.padStart(14) + ' ' + ch + r.change24h.toFixed(2).padStart(7) + '%  ' + vol.padStart(8) + ' ' + typeP.padEnd(7) + ' ' + r.score.toString().padStart(3) + ' ' + routeTag);
  });

  console.log('\n' + '-'.repeat(105));
  console.log('RSI-14 (top 8)');
  console.log('-'.repeat(105));

  const rsiMap = {};
  const momMap = {};

  for (const r of allResults.slice(0, 8)) {
    if (r._closes && r._closes.length >= 15) {
      const closes = r._closes.filter(c => c && c > 0).slice(-15);
      if (closes.length < 15) { continue; }
      const rsi = computeRSI(closes);
      if (rsi === null) continue;
      const info = symMap[r.symbol];
      let mom = null;
      if (info) {
        const prices = await fetchIntraday(info.id);
        if (prices) mom = intradayMom(prices);
      }
      momMap[r.symbol] = mom;
      rsiMap[r.symbol] = rsi;
      const dir = r.change24h > 0 ? '+' + r.change24h.toFixed(1) + '%' : r.change24h.toFixed(1) + '%';
      const sig = rsi > 70 ? 'OVERBOUGHT' : rsi < 30 ? 'OVERSOLD' : 'neutral';
      const momStr = mom !== null ? ' MOM:' + (mom >= 0 ? '+' : '') + mom : '';
      console.log(r.symbol.padEnd(9) + ' $' + r.price.toFixed(2).padStart(12) + '  RSI(14): ' + rsi.toFixed(1).padStart(6) + momStr + '  ' + dir.padStart(8) + '  ' + sig);
    } else {
      let closes = [];
      let info = null;
      if (r.type === 'stock') {
        const yfSym = ONDO[r.symbol];
        if (!yfSym) { continue; }
        try {
          const chart = await yf(yfSym, '2mo');
          const raw = chart?.indicators?.quote?.[0]?.close?.filter(c => c) || [];
          closes = raw.filter(c => c && c > 0);
        } catch(e) { continue; }
        await sleep(1000);
      } else {
        info = symMap[r.symbol];
        if (!info) { continue; }
        try {
          let chart;
          for (let attempts = 0; attempts < 3; attempts++) {
            try { chart = await cg('/api/v3/coins/' + info.id + '/ohlc?days=14&vs_currency=usd'); break; }
            catch(e) { if (e.message === 'RATE_LIMITED' && attempts < 2) { console.log('  CG OHLC rate limited, waiting 60s...'); await sleep(60000); continue; } throw e; }
          }
          if (!chart || chart.length < 15) { continue; }
          closes = chart.map(c => c[4]).filter(p => p && p > 0);
        } catch(e) { if (e.message !== 'RATE_LIMITED') console.log(r.symbol + ' -- ' + e.message.slice(0,30)); continue; }
        await sleep(3000);
      }
      if (closes.length < 15) { continue; }
      const rsi = computeRSI(closes);
      if (rsi === null) continue;
      let mom = null;
      if (info) {
        const prices = await fetchIntraday(info.id);
        if (prices) mom = intradayMom(prices);
      }
      momMap[r.symbol] = mom;
      rsiMap[r.symbol] = rsi;
      const dir = r.change24h > 0 ? '+' + r.change24h.toFixed(1) + '%' : r.change24h.toFixed(1) + '%';
      const sig = rsi > 70 ? 'OVERBOUGHT' : rsi < 30 ? 'OVERSOLD' : 'neutral';
      const momStr = mom !== null ? ' MOM:' + (mom >= 0 ? '+' : '') + mom : '';
      console.log(r.symbol.padEnd(9) + ' $' + (r.price > 100 ? r.price.toFixed(2) : r.price.toFixed(6)).toString().padStart(12) + '  RSI(14): ' + rsi.toFixed(1).padStart(6) + momStr + '  ' + dir.padStart(8) + '  ' + sig);
    }
  }

  console.log('\n' + '-'.repeat(105));
  console.log('  24H SWING CANDIDATES (score>=2, RSI<70, vol>$1M)');
  console.log('-'.repeat(105));

  const swingCandidates = allResults
    .filter(r => r.score >= 2 && r.price > 0.0001 && r.volume24h > 1_000_000)
    .filter(r => !(r.symbol in rsiMap) || rsiMap[r.symbol] < 70)
    .sort((a, b) => b.change24h - a.change24h)
    .slice(0, 10);

  if (swingCandidates.length === 0) {
    console.log('  No candidates meet criteria.');
  } else {
    swingCandidates.forEach((r, i) => {
      const ch = r.change24h >= 0 ? '+' : '';
      const rsiStr = rsiMap[r.symbol] !== undefined ? rsiMap[r.symbol].toFixed(1) : '  --';
      const mom = momMap[r.symbol];
      const momStr = mom !== undefined && mom !== null ? ' MOM:' + (mom >= 0 ? '+' : '') + mom : '';
      const volStr = r.volume24h >= 1e9 ? (r.volume24h/1e9).toFixed(1)+'B' : r.volume24h >= 1e6 ? (r.volume24h/1e6).toFixed(0)+'M' : (r.volume24h/1e3).toFixed(0)+'K';
      const pStr = r.price >= 100 ? r.price.toFixed(2) : r.price >= 1 ? r.price.toFixed(4) : r.price.toFixed(8);
      const routeTag = r.tradable ? 'YES' : 'no';
      console.log('  ' + (i+1).toString().padEnd(2) + r.symbol.padEnd(9) + ' $' + pStr.padStart(14) + '  ' + ch + r.change24h.toFixed(2).padStart(7) + '%  RSI ' + rsiStr.padStart(6) + momStr + '  score ' + r.score.toString().padStart(2) + '  vol ' + volStr.padStart(8) + '  route:' + routeTag);
    });
  }

  const fgN = parseInt(fg);
  const best3 = allResults.slice(0, 3);
  const topCrypto = allResults.filter(r => r.type === 'crypto').slice(0, 3);
  const topStocks = allResults.filter(r => r.type === 'stock').slice(0, 3);
  const topTradable = allResults.filter(r => r.tradable).slice(0, 3);

  console.log('\n' + '='.repeat(105));
  console.log('  Fear & Greed: ' + fg + '/100 (' + fgc + ')');
  if (fgN < 20) console.log('  -> Extreme Fear');
  else if (fgN < 40) console.log('  -> Fear');
  else if (fgN < 60) console.log('  -> Neutral');
  else if (fgN < 80) console.log('  -> Greed');
  else console.log('  -> Extreme Greed');
  console.log('\n  Top 3 overall:       ' + best3.map(r => r.symbol).join(', '));
  console.log('  Top 3 crypto:        ' + topCrypto.map(r => r.symbol).join(', '));
  console.log('  Top 3 stocks/ETFs:   ' + topStocks.map(r => r.symbol).join(', '));
  console.log('  Top 3 tradable:      ' + (topTradable.length ? topTradable.map(r => r.symbol).join(', ') : '(none with active routes)'));
  console.log('\n  Not financial advice.');
  console.log('  ' + '='.repeat(105));

  // === PORTFOLIO CHECK ===
  const costBasis = loadCostBasis();
  const latestSnapshot = loadPortfolioHistory();
  const HOLDINGS = buildHoldings(costBasis, latestSnapshot);

  const goldAsset = allResults.find(r => r.symbol === 'GLDon');
  const goldDown = goldAsset && goldAsset.change24h < 0;
  const marketDownCount = allResults.slice(0, 15).filter(r => r.change24h < 0).length;
  const marketRiskOff = fgN < 30 && (goldDown || marketDownCount > 9);

  console.log('\n' + '='.repeat(105));
  console.log('  PORTFOLIO CHECK');
  console.log('='.repeat(105));

  let anySellSignal = false;
  let totalValue = 0;

  if (Object.keys(HOLDINGS).length === 0) {
    console.log('  No current holdings (load .cost_basis.json and portfolio_history.json)');
  } else {
    console.log('  ' + 'Holding'.padEnd(9) + '   Amount  ' + '  Price  ' + '    Value   ' + '    P&L     ' + '  P&L $   ' + ' Signal');
    console.log('  ' + '-'.repeat(70));

    for (const [sym, h] of Object.entries(HOLDINGS)) {
      const current = allResults.find(r => r.symbol === sym);
      if (!current) {
        console.log('  ' + sym.padEnd(9) + ' - price not available');
        continue;
      }
      const value = current.price * h.amount;
      totalValue += value;
      const amtStr = h.amount >= 1 ? h.amount.toFixed(2) : h.amount.toFixed(4);

      let pnlStr, usdStr, signal, reason;
      if (h.buyPrice === null || h.buyPrice <= 0) {
        pnlStr = '    —';
        usdStr = '    —';
        signal = 'HOLD';
        reason = '';
      } else {
        const pnlPct = ((current.price - h.buyPrice) / h.buyPrice) * 100;
        const pnlUsd = (current.price - h.buyPrice) * h.amount;
        pnlStr = pnlPct >= 0 ? '+' + pnlPct.toFixed(2) + '%' : pnlPct.toFixed(2) + '%';
        usdStr = pnlUsd >= 0 ? '+$' + pnlUsd.toFixed(4) : '-$' + Math.abs(pnlUsd).toFixed(4);
        signal = 'HOLD';
        reason = '';

        if (marketRiskOff) {
          signal = 'SELL';
          reason = 'risk-off: broad market selloff, gold down, extreme fear';
        } else if (pnlPct < -10) {
          signal = 'SELL';
          reason = 'stop loss: ' + pnlPct.toFixed(1) + '%';
        } else if (pnlPct < 0 && current.score < -2) {
          signal = 'SELL';
          reason = 'negative momentum (score=' + current.score + ')';
        } else if (pnlPct < -5) {
          signal = 'WATCH';
          reason = 'approaching stop loss at -10%';
        }
      }

      if (signal !== 'HOLD') anySellSignal = true;

      const mom = momMap[sym];
      const momStr = mom !== undefined && mom !== null ? ' MOM:' + (mom >= 0 ? '+' : '') + mom : '';
      const sigColors = signal === 'SELL' ? 'SELL' : signal === 'WATCH' ? 'WATCH' : 'HOLD';
      console.log('  ' + sym.padEnd(9) + amtStr.padStart(8) + ' $' + current.price.toFixed(4).padStart(7) + ' $' + value.toFixed(4).padStart(8) + ' ' + pnlStr.padStart(9) + ' ' + usdStr.padStart(8) + momStr + '  ' + sigColors.padEnd(5) + ' ' + reason);
    }

    console.log('  ' + '-'.repeat(70));
    console.log('  ' + 'TOTAL'.padEnd(9) + ' '.repeat(8) + ' '.repeat(9) + ' $' + totalValue.toFixed(4).padStart(7) + ' '.repeat(9) + ' '.repeat(9));

    if (!anySellSignal) {
      console.log('\n  === SWAP TARGETS ===');

      if (marketRiskOff) {
        console.log('  Market in risk-off mode - swap to USDC (stable)');
        console.log('  Suggested: SELL holdings - Buy USDC on NEAR');
        console.log('  USDC asset: nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1');
      } else {
        const topPicks = allResults.filter(r => r.score > 5 && r.tradable).slice(0, 3);
        if (topPicks.length) {
          console.log('  Top tradable swap targets (score > 5):');
          topPicks.forEach(r => {
            const ch = r.change24h >= 0 ? '+' : '';
            console.log('    ' + r.symbol.padEnd(9) + ' score=' + r.score + '  24h: ' + ch + r.change24h.toFixed(2) + '%  $' + r.price.toFixed(4));
          });
        } else {
          const topAll = allResults.filter(r => r.score > 5).slice(0, 3);
          if (topAll.length) {
            console.log('  Top scoring targets (no active route):');
            topAll.forEach(r => {
              const ch = r.change24h >= 0 ? '+' : '';
              console.log('    ' + r.symbol.padEnd(9) + ' score=' + r.score + '  24h: ' + ch + r.change24h.toFixed(2) + '%  $' + r.price.toFixed(4) + '  (no route)');
            });
          } else {
            console.log('  No candidates with score > 5 found.');
          }
        }
      }
    }
  }

  // AI commentary
  if (deepseek.hasKey()) {
    const top3 = allResults.slice(0, 3).map(r => `${r.symbol}(${r.score}, ${r.change24h >= 0 ? '+' : ''}${r.change24h.toFixed(1)}%)`).join(', ');
    const portfolio = Object.keys(HOLDINGS).length > 0
      ? Object.entries(HOLDINGS).map(([s, h]) => `${s} $${(h.amount * 0).toFixed(0)}`).join(', ')
      : 'empty';
    const msg = [
      { role: 'system', content: 'You are a crypto market analyst. Give a brief 2-sentence summary of the current market state based on the data provided. Be concise, factual, and highlight the most notable movers.' },
      { role: 'user', content: `Market: Fear & Greed ${fg}/100 (${fgc}). Top 3: ${top3}. Portfolio: ${portfolio}.` },
    ];
    const reply = await deepseek.chat(msg, { maxTokens: 150 });
    if (reply) {
      console.log('\n' + '='.repeat(105));
      console.log('  AI MARKET SUMMARY');
      console.log('='.repeat(105));
      console.log(`  ${reply}`);
    }
  }
}

main().catch(e => console.error(e));

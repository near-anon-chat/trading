const https = require('https');

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

const HOLDINGS = {
  AURORA: { amount: 76.4547, buyPrice: 0.0269, chain: 'near' },
  SPX: { amount: 3.21, buyPrice: 0.3178, chain: 'sol' },
  MON: { amount: 9.30, buyPrice: 0.0215, chain: 'monad' },
  wNEAR: { amount: 0.1, buyPrice: 2.05, chain: 'near' },
  VVV: { amount: 0.4231, buyPrice: 14.63, chain: 'base' },
  INX: { amount: 519.1, buyPrice: 0.00766, chain: 'eth' },
};

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

  const tokens = require('/home/jbx/code/trading/tokens.json');
  if (!tokens || !tokens.length) { console.error('Run: fetch fresh tokens from 1Click API'); return; }

  let coinList = [];
  try {
    const cached = require('fs').existsSync('/home/jbx/code/trading/coinList.json') ? require('/home/jbx/code/trading/coinList.json') : null;
    if (cached && cached.length) { coinList = cached; } else {
      coinList = await cg('/api/v3/coins/list');
      require('fs').writeFileSync('/home/jbx/code/trading/coinList.json', JSON.stringify(coinList));
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
    .map(r => {
      let s = 0;
      if (r.change24h > 10) s += 5;
      else if (r.change24h > 5) s += 3;
      else if (r.change24h > 2) s += 2;
      else if (r.change24h > 0) s += 1;
      else if (r.change24h > -5) s -= 1;
      else s -= 2;
      if (r.volume24h > 5e8) s += 3;
      else if (r.volume24h > 5e7) s += 2;
      else if (r.volume24h > 5e6) s += 1;
      if (r.type === 'stock') s += 2;
      return { ...r, score: s };
    })
    .sort((a, b) => b.score - a.score);

  console.log('\n' + '='.repeat(95));
  console.log('      ALL TRADING OPPORTUNITIES — CRYPTO + ETFs (TA + Sentiment)');
  console.log('='.repeat(95));
  console.log('#  Symbol      Price           24h Δ       Volume     Type  Score');
  console.log('─  ' + '─'.repeat(90));

  allResults.slice(0, 20).forEach((r, i) => {
    const ch = r.change24h >= 0 ? '+' : '';
    const vol = r.volume24h >= 1e9 ? (r.volume24h/1e9).toFixed(1)+'B' : r.volume24h >= 1e6 ? (r.volume24h/1e6).toFixed(0)+'M' : (r.volume24h/1e3).toFixed(0)+'K';
    const typeP = r.type === 'stock' ? '📈ETF' : '  🪙';
    const pStr = r.price >= 100 ? r.price.toFixed(2) : r.price >= 1 ? r.price.toFixed(4) : r.price.toFixed(8);
    console.log((i+1).toString().padStart(2) + '. ' + r.symbol.padEnd(9) + ' $' + pStr.padStart(14) + ' ' + ch + r.change24h.toFixed(2).padStart(7) + '%  ' + vol.padStart(8) + ' ' + typeP + ' ' + r.score.toString().padStart(3));
  });

  console.log('\n' + '─'.repeat(95));
  console.log('RSI-14 (top 8)');
  console.log('─'.repeat(95));

  const rsiMap = {};

  for (const r of allResults.slice(0, 8)) {
    if (r._closes && r._closes.length >= 14) {
      const closes = r._closes.filter(c => c && c > 0).slice(-15);
      if (closes.length < 14) { continue; }
      const gains = [], losses = [];
      for (let i = 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i-1];
        gains.push(diff > 0 ? diff : 0); losses.push(diff < 0 ? -diff : 0);
      }
      const avgG = gains.slice(-14).reduce((a,b) => a+b, 0) / 14;
      const avgL = losses.slice(-14).reduce((a,b) => a+b, 0) / 14;
      let rsi = 50;
      if (avgL === 0 && avgG > 0) rsi = 100;
      else if (avgL > 0) { const rs = avgG / avgL; rsi = 100 - (100 / (1 + rs)); }
      const dir = r.change24h > 0 ? '+' + r.change24h.toFixed(1) + '%' : r.change24h.toFixed(1) + '%';
      const sig = rsi > 70 ? '⚠️  OVERBOUGHT' : rsi < 30 ? '🟢 OVERSOLD' : '➖ neutral';
      rsiMap[r.symbol] = rsi;
      console.log(r.symbol.padEnd(9) + ' $' + r.price.toFixed(2).padStart(12) + '  RSI(14): ' + rsi.toFixed(1).padStart(6) + '  ' + dir.padStart(8) + '  ' + sig);
    } else {
      let closes = [];
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
        const info = symMap[r.symbol];
        if (!info) { continue; }
        try {
          let chart;
          for (let attempts = 0; attempts < 3; attempts++) {
            try { chart = await cg('/api/v3/coins/' + info.id + '/ohlc?days=14&vs_currency=usd'); break; }
            catch(e) { if (e.message === 'RATE_LIMITED' && attempts < 2) { console.log('  CG OHLC rate limited, waiting 60s...'); await sleep(60000); continue; } throw e; }
          }
          if (!chart || chart.length < 14) { continue; }
          closes = chart.map(c => c[4]).filter(p => p && p > 0);
        } catch(e) { if (e.message !== 'RATE_LIMITED') console.log(r.symbol + ' — ' + e.message.slice(0,30)); continue; }
        await sleep(3000);
      }
      if (closes.length < 14) { continue; }
      const gains = [], losses = [];
      for (let i = 1; i < closes.length; i++) {
        const diff = closes[i] - closes[i-1];
        gains.push(diff > 0 ? diff : 0); losses.push(diff < 0 ? -diff : 0);
      }
      const avgG = gains.slice(-14).reduce((a,b) => a+b, 0) / 14;
      const avgL = losses.slice(-14).reduce((a,b) => a+b, 0) / 14;
      let rsi = 50;
      if (avgL === 0 && avgG > 0) rsi = 100;
      else if (avgL > 0) { const rs = avgG / avgL; rsi = 100 - (100 / (1 + rs)); }
      const dir = r.change24h > 0 ? '+' + r.change24h.toFixed(1) + '%' : r.change24h.toFixed(1) + '%';
      const sig = rsi > 70 ? '⚠️  OVERBOUGHT' : rsi < 30 ? '🟢 OVERSOLD' : '➖ neutral';
      rsiMap[r.symbol] = rsi;
      console.log(r.symbol.padEnd(9) + ' $' + (r.price > 100 ? r.price.toFixed(2) : r.price.toFixed(6)).toString().padStart(12) + '  RSI(14): ' + rsi.toFixed(1).padStart(6) + '  ' + dir.padStart(8) + '  ' + sig);
    }
  }

  console.log('\n' + '─'.repeat(95));
  console.log('  24H SWING CANDIDATES (score>=2, RSI<70, vol>$1M)');
  console.log('─'.repeat(95));

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
      const volStr = r.volume24h >= 1e9 ? (r.volume24h/1e9).toFixed(1)+'B' : r.volume24h >= 1e6 ? (r.volume24h/1e6).toFixed(0)+'M' : (r.volume24h/1e3).toFixed(0)+'K';
      const pStr = r.price >= 100 ? r.price.toFixed(2) : r.price >= 1 ? r.price.toFixed(4) : r.price.toFixed(8);
      console.log('  ' + (i+1).toString().padEnd(2) + r.symbol.padEnd(9) + ' $' + pStr.padStart(14) + '  ' + ch + r.change24h.toFixed(2).padStart(7) + '%  RSI ' + rsiStr.padStart(6) + '  score ' + r.score.toString().padStart(2) + '  vol ' + volStr.padStart(8));
    });
  }

  const fgN = parseInt(fg);
  const best3 = allResults.slice(0, 3);
  const topCrypto = allResults.filter(r => r.type === 'crypto').slice(0, 3);
  const topStocks = allResults.filter(r => r.type === 'stock').slice(0, 3);

  console.log('\n' + '═'.repeat(95));
  console.log('  Fear & Greed: ' + fg + '/100 (' + fgc + ')');
  if (fgN < 20) console.log('  → Extreme Fear');
  else if (fgN < 40) console.log('  → Fear');
  else if (fgN < 60) console.log('  → Neutral');
  else if (fgN < 80) console.log('  → Greed');
  else console.log('  → Extreme Greed');
  console.log('\n  Top 3 overall:       ' + best3.map(r => r.symbol).join(', '));
  console.log('  Top 3 crypto:        ' + topCrypto.map(r => r.symbol).join(', '));
  console.log('  Top 3 stocks/ETFs:   ' + topStocks.map(r => r.symbol).join(', '));
  console.log('\n  ⚠️  Not financial advice.');
  console.log('  ═'.repeat(95));

  // === PORTFOLIO CHECK ===
  const goldAsset = allResults.find(r => r.symbol === 'GLDon');
  const goldDown = goldAsset && goldAsset.change24h < 0;
  const marketDownCount = allResults.slice(0, 15).filter(r => r.change24h < 0).length;
  const marketRiskOff = fgN < 30 && (goldDown || marketDownCount > 9);

  console.log('\n' + '═'.repeat(95));
  console.log('  PORTFOLIO CHECK');
  console.log('═'.repeat(95));

  let anySellSignal = false;
  let totalValue = 0;

  console.log('  ' + 'Holding'.padEnd(9) + '   Amount  ' + '  Price  ' + '    Value   ' + '    P&L     ' + '  P&L $   ' + ' Signal');
  console.log('  ' + '─'.repeat(70));

  for (const [sym, h] of Object.entries(HOLDINGS)) {
    const current = allResults.find(r => r.symbol === sym);
    if (!current) {
      console.log('  ' + sym.padEnd(9) + ' - price not available');
      continue;
    }
    const value = current.price * h.amount;
    totalValue += value;
    const pnlPct = ((current.price - h.buyPrice) / h.buyPrice) * 100;
    const pnlUsd = (current.price - h.buyPrice) * h.amount;
    const pnlStr = pnlPct >= 0 ? '+' + pnlPct.toFixed(2) + '%' : pnlPct.toFixed(2) + '%';
    const valueStr = '$' + value.toFixed(4);
    const usdStr = pnlUsd >= 0 ? '+$' + pnlUsd.toFixed(4) : '-$' + Math.abs(pnlUsd).toFixed(4);
    const amtStr = h.amount >= 1 ? h.amount.toFixed(2) : h.amount.toFixed(4);

    let signal = 'HOLD';
    let reason = '';

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

    if (signal !== 'HOLD') anySellSignal = true;

    const sigTag = signal === 'SELL' ? '\u{1F534} SELL' : signal === 'WATCH' ? '\u{1F7E1} WATCH' : '\u{1F7E2} HOLD';
    console.log('  ' + sym.padEnd(9) + amtStr.padStart(8) + ' $' + current.price.toFixed(4).padStart(7) + ' ' + valueStr.padStart(9) + ' ' + pnlStr.padStart(9) + ' ' + usdStr.padStart(8) + '  ' + sigTag + ' ' + reason);
  }

  console.log('  ' + '─'.repeat(70));
  console.log('  ' + 'TOTAL'.padEnd(9) + ' '.repeat(8) + ' '.repeat(9) + ' $' + totalValue.toFixed(4).padStart(7) + ' '.repeat(9) + ' '.repeat(9));

  if (!anySellSignal) {
    console.log('\n  === SWAP TARGETS ===');

    if (marketRiskOff) {
      console.log('  Market in risk-off mode - swap to USDT (stable)');
      console.log('  Suggested: SELL holdings - Buy USDC or USDT on NEAR');
      console.log('  USDC asset: nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1');
    } else {
      const topPicks = allResults.filter(r => r.score > 5).slice(0, 3);
      console.log('  Top swap targets (score > 5):');
      topPicks.forEach(r => {
        const ch = r.change24h >= 0 ? '+' : '';
        console.log('    ' + r.symbol.padEnd(9) + ' score=' + r.score + '  24h: ' + ch + r.change24h.toFixed(2) + '%  $' + r.price.toFixed(4));
      });
      console.log('\n  \u26A0\uFE0F  Review recommendations before executing any swap.');
    }
  }
}

main().catch(e => console.error(e));

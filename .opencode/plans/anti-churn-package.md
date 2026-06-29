# Anti-Churn Package

5 edits to `/home/jbz/code/trading/agent.js`:

## 1. JUNK_HOLD_MS 15→30 min (line 47)
```
-old: const JUNK_HOLD_MS = 15 * 60 * 1000;
+new: const JUNK_HOLD_MS = 30 * 60 * 1000;
```

## 2. REBUY_COOLDOWN_MS 30 min→2h (line 53)
```
-old: const REBUY_COOLDOWN_MS = 30 * 60 * 1000;
+new: const REBUY_COOLDOWN_MS = 2 * 60 * 60 * 1000;
```

## 3. Rotation delta +2→+4 (line 1324)
```
-old: ((a.sc + volMomBoost(a)) >= (worst?.score || 0) + 2));
+new: ((a.sc + volMomBoost(a)) >= (worst?.score || 0) + 4));
```

## 4. HOLD_MIN_MS gate on raise-USDC sells (line 1736)
```
-old: const sellCandidates = [...nonStablePositions].filter(p => !raisedSyms[p.sym]).sort(...);
+new: const sellCandidates = [...nonStablePositions].filter(p => !raisedSyms[p.sym] && (!holdStart[p.sym] || Date.now() - holdStart[p.sym] >= HOLD_MIN_MS)).sort(...);
```

## 5. MAX_DAILY_TRADES constant + daily buy limit

### 5a. Add constant (after line 53)
```
+const MAX_DAILY_TRADES = 6;
```

### 5b. Add check before BUY block (between lines 1343 and 1344)
Insert after line 1343 `}`:
```
  // Daily trade cap — limit new entries to reduce churn (sells still fire)
  const dTrades = loadTradeHistory().filter(t => t.type === 'BUY' && Date.now() - t.ts < 86400000).length;
  if (action === 'HOLD' && dTrades >= MAX_DAILY_TRADES && nonStablePositions.length > 0) {
    reason = `Daily buy limit (${dTrades}/${MAX_DAILY_TRADES}), waiting until tomorrow`;
  }
```

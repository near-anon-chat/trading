# BUY Rules — Entry Gate Functions

## `buyable()` — Standard entry (sc ≥ 5)

```js
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
```

| Condition | Threshold | RHEA (sc=5) | Pass? |
|-----------|-----------|-------------|-------|
| `sc >= 5` | ≥5 | 5 | ✅ |
| Not failed/route/recentlySold | — | — | ✅ |
| `sc < 6` → VS ≥ 1.5x AND MOM > 0 | VS≥1.5, MOM>0 | VS=1.0, MOM=+2 | ❌ VS |
| `RSI < 80` | <80 | 39 | ✅ |
| `sc < 7` → VOL ≥ 1.0x AND RSI < 70 | VOL≥1.0, RSI<70 | VOL=0.2, RSI=39 | ❌ VOL |

---

## `divergenceBuyable()` — Bullish divergence (sc ≥ 5, DG=YES)

```js
function divergenceBuyable(a, failedTokens, routeInv) {
  if (!a || !failedTokens || !routeInv) return false;
  if (!a.dg || a.sc == null || a.sc < 5) return false;
  if (failedTokens.has(a.sym) || !routeInv.has(a.sym) || recentlySold(a.sym)) return false;
  if (a.v == null || a.v <= 2) return false;
  if (a.e == null || a.e < 0) return false;
  if (a.r != null && a.r >= 80) return false;
  return true;
}
```

| Condition | Threshold | RHEA (sc=5) | Pass? |
|-----------|-----------|-------------|-------|
| `dg == true` | must have DG | DG=NO | ❌ |
| `sc >= 5` | ≥5 | 5 | ✅ |
| `VOL > 2` | >2x | 0.2x | ❌ |
| `EMA >= 0` | ≥0 | +0 | ✅ |
| `RSI < 80` | <80 | 39 | ✅ |

---

## `momentumBuyable()` — Momentum entry (sc ≥ 4)

```js
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
```

| Condition | Threshold | RHEA (sc=5) | Pass? |
|-----------|-----------|-------------|-------|
| `sc >= 4` | ≥4 | 5 | ✅ |
| `MOM > 0` | >0 | +2 | ✅ |
| `VOL > 1` | ≥1.0x | 0.2x | ❌ |
| `EMA >= 0` | ≥0 | +0 | ✅ |
| `RSI < 80` | <80 | 39 | ✅ |

---

## `accumulationBuyable()` — Heavy accumulation (sc ≥ 4)

```js
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
```

| Condition | Threshold | RHEA (sc=5) | Pass? |
|-----------|-----------|-------------|-------|
| `sc >= 4` | ≥4 | 5 | ✅ |
| `VOL > 2` | >2x | 0.2x | ❌ |
| `EMA >= 1` | ≥1 | +0 | ❌ |
| `ch > 3` (24h change) | >3% | +11.6% | ✅ |
| `RSI < 80` | <80 | 39 | ✅ |

---

## `earlyPump()` — Early pump detection (sc ≥ 3)

```js
const earlyPump = a => a.v !== undefined && a.v > 1.8 && a.e >= 0 && a.ch > 2 && (a.r === undefined || a.r < 80) && a.sc >= 3;
```

| Condition | Threshold | RHEA (sc=5) | Pass? |
|-----------|-----------|-------------|-------|
| `sc >= 3` | ≥3 | 5 | ✅ |
| `VOL > 1.8` | >1.8x | 0.2x | ❌ |
| `ch > 2` (24h change) | >2% | +11.6% | ✅ |
| `EMA >= 0` | ≥0 | +0 | ✅ |
| `RSI < 80` | <80 | 39 | ✅ |

---

## `pumpStart()` — Heavy pump start (sc ≥ 3)

```js
const pumpStart = a => a.v !== undefined && a.v > 2.5 && a.e === 2 && a.d !== undefined && a.d < -10 && (a.r === undefined || a.r < 85);
```

| Condition | Threshold | RHEA (sc=5) | Pass? |
|-----------|-----------|-------------|-------|
| `VOL > 2.5` | >2.5x | 0.2x | ❌ |
| `EMA === 2` | ==+2 | +0 | ❌ |
| `PD < -10` (deep dip) | <-10% | -0.5% | ❌ |
| `RSI < 85` | <85 | 39 | ✅ |

---

## TOPUP eligibility (separate from BUY)

TOPUP uses different criteria — does not call any buyable function. Instead checks:

| Condition | Threshold | RHEA (sc=5) | Pass? |
|-----------|-----------|-------------|-------|
| `score >= 5` | ≥5 | 5 | ✅ |
| Not throttled (<1h since last topup) | <1h | — | ✅ |
| `sc < 7` → VOL≥1.0 OR MOM≥0 OR EMA≥0 | MOM≥0 suffices | MOM=+2 | ✅ |
| Room to tier target ≥ $0.50 | ≥$0.50 | ~$13.54 | ✅ |
| Buy route exists (`checkLiquidity`) | must pass | — | ✅ |
| AI vetting (DeepSeek) | must reply YES | — | ✅ (was YES) |

---

## Display indicator (Top 10 `✅`/`❌`)

The Buyable column in the Top 10 list only checks `buyable()` OR `divergenceBuyable()` — it does NOT reflect `momentumBuyable`, `earlyPump`, `pumpStart`, or `accumulationBuyable`. This means some tokens that are viable rotation/BUY candidates may show ❌.

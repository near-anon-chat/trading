# TODO

## Pump Detection (NPRO-style vertical moves)

### Problem
NPRO does vertical pumps (+85%) and crashes back down within hours.
We need to detect:
1. **When a pump starts** — buy signal
2. **When a pump ends / crash starts** — sell signal

### Current data (already available)

| Metric | What it shows | Useful for |
|--------|---------------|------------|
| `VOL` | Volatility ratio (e.g. 3.9x) | Detects abnormal movement |
| `EMA` | 15-min vs 30-min direction (-2 to +2) | Detects short-term direction change |
| `PD` | Distance from 24h high (%, negative = below peak) | Shows position in the pump cycle |
| `MOM` | 1h vs 2h direction (-2 to +2) | Broader trend confirmation |
| `RSI` | 14-day RSI | Overbought/oversold context |

### Observed NPRO pattern

```
Phase         PD     EMA    VOL   MOM   RSI   Action
---------------------------------------------------------
Bottom       -43%   +0     low   -1    40    wait
Pump start   -30%   +2     4x    +2    50    BUY
Mid pump     -10%   +2     4x    +2    70    HOLD
Peak          -0%   +2/+0  4x    +2    84    SELL (or wait for confirmation)
Crash start   -3%   -2     4x    +2    86    SELL immediately
Free fall    -20%   -2     3x    +1    80    wait for recovery
Bottom       -43%   -1     low   -1    50    possible re-entry
```

### Detection rules (to implement)

**Pump start signal (BUY):**
- `VOL > 2.5` (abnormal volatility)
- `EMA === +2` (vertical up in last 15 min)
- `PD < -10` (still well below peak — room to run)
- `RSI < 85` (not overbought)
- Score >= 5

**Pump end / crash signal (SELL):**
- `PD > -2` (at or near peak)
- `VOL > 3` (extreme volatility)
- `EMA` switches from `+2` to `0` or `-1` (momentum dying)
- `RSI > 80` (overbought context)

**Emergency crash sell (SELL immediately):**
- `PD > -5` (near peak)
- `EMA` drops from `+2` to `-2` in one cycle (direct reversal)
- Trigger sell regardless of other indicators

### Implementation

In `agent.js`:
1. Add `pumpStart` detection logic in the candidate/buy section
2. Add `pumpEnd` and `crash` sell triggers in the sell section
3. Add `PD` and `VOL` to already fetched intraday data (done)

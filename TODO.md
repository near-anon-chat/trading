# Evening Reflection — June 28

## Done Today

### Candidate finder + tryBuy alignment
- **Problem:** Candidate finder accepted `pumpStart`/`earlyPump` tokens (sc≥3), but `tryBuy` rejected them at a stricter gate — 58ms silent skip, no log.
- **Fix (initial):** Removed `pumpStart`/`earlyPump` from candidate finder gates to match tryBuy.
- **Reversal (final):** Reinstated both, widened tryBuy's first gate to accept them, and added `accumulationBuyable()` for VOL>2x + EMA=+1 + ch>3% + sc≥4 entries. Decision and execution now consistent.

### Silent skip logging
- **Problem:** `tryBuy()` returned false without logging why — RHEA (sc=3, earlyPump) silently rejected in 58ms.
- **Fix:** Broke compound gates into individual logged checks (`not buyable`, `fails quality gate`, `recently raised`, `already held`, `not in portfolio`, `insufficient USDC`, `amount too small`).

### Fallback scan removed
- **Problem:** Every cycle iterated all ranked tokens (~hundreds) with silent `continue`s.
- **Fix:** Removed. Candidate finder already identified the best token — tryBuy either works or doesn't. No point re-scanning everything.

### Pump peak sell trigger
- **New trigger:** Positions bought via `pumpStart`/`earlyPump` (tracked via `costBasis.pumpEntry`) sold when PD ≥ -1% — peak reached, pump exhausted.
- TURBO example: bought at PD=-50%, climbs to PD=-0.5% → immediate sell.

### Accumulation entry path
- **New function `accumulationBuyable()`:** VOL>2x + EMA=+1 + ch>3% + sc≥4, bypasses MOM/VS gates.
- **Allocation:** 25% partial position (same as momentum entries).

### Divergence display
- `assetMetrics`: top 10 with columns aligned (`padEnd(10)`) + `DG=YES/NO` on every line.
- `topList`: top 3 compact with `DG=YES/NO`.
- `posStr`: portfolio positions include `DG=YES/NO` (except USDC).

### DeepSeek prompts
- Divergence already passed in BUY/SELL vetting prompts.
- System prompt updated to explain divergence weighting.

## Open Questions

1. **`accumulationBuyable()` — VOL threshold?** Currently >2x. TURBO had 1.5x. Lower to 1.5x?
2. **Pump peak sell — PD threshold?** Currently ≥ -1%. Another value?
3. **AI advisor system prompt** — Should the accumulation entry rule be added to the buy vetting prompt?

# TODO

## What Are `1cs_v1:` Tokens?

`1cs_v1:{chain}:{type}:{address}` is a cross-chain token ID format used by 1Click for assets that aren't native NEP-141 on NEAR.

**Problem:** These tokens work for trading (1Click can swap them) but `mt_batch_balance_of` on `intents.near` returns **0** for them. The NEAR intents balance API only supports NEP-141 format (`nep141:{address}`). This means the agent trades into assets it can never read back, causing:

- Incorrect portfolio total (invisible position missing)
- Agent never detects the position for sell decisions
- Unnecessary sell of other positions to "raise USDC" when funds are already there

**Example:** BTC(OMNI) (`1cs_v1:btc:native:coin`) vs BTC (`nep141:btc.omft.near`). Same underlying Bitcoin, two different token standards. The `nep141:` version is readable, the `1cs_v1:` version is not.

## Done

- [x] **Block `1cs_v1:*` tokens** — All PORTFOLIO entries with `1cs_v1:` asset IDs are added to `failedTokens` at startup.
- [x] **raisedSyms cooldown 10→30 min** — Prevents near-miss cooldown expiry.
- [x] **BTC(OMNI) recovery** — Scans costBasis for stranded `1cs_v1:` tokens and sells them to USDC.
- [x] **Route re-check skips `1cs_v1:`** — Prevents restoring `1cs_v1:` tokens despite working swap routes.
- [x] **TOPUP action** — Idle USDC ≥$2.00 reinvested into best position below tier max.
- [x] **OB threshold raised: 85→92 + score guard** — `p.rsi > 92 && p.score < 7`. Prevents selling top-tier winners (sc≥7) for short-term overbought. ZEC (sc=8, RSI=87) no longer triggers churn.
- [x] **Sell-to-raise equality fix** — `candidate.sc > p.score` → `candidate.sc >= p.score`. Allows buying equal-scored candidates (e.g., KAITO sc=4 when ZEC sc=4).
- [x] **CG price caching** — 60s TTL cache for `fetchCGData`. Survives CoinGecko rate limits without blind runs.

## Pending Improvements

### 1. RSI Coverage
- Only held tokens + top 15 are fetched — still missing RSI for many tradeable candidates
- wNEAR excluded by `CG_IDS[s] !== 'near'` filter (NEAR OHLC valid for wNEAR price)
- CG rate limits still hit when building RSI for 15+ tokens (5s sleep each)

### 2. Portfolio Display / Balance Fidelity
- `mt_batch_balance_of` with `optimistic` finality lags ~10-20 min behind on-chain state
- In-memory `bals` updates don't survive restarts
- `1cs_v1:` tokens remain permanently invisible

### 3. Cooldown Gate Check
- `ok` is `const` — computed once at startup. If recovery trades during the run and calls `markTrade()`, main execution still proceeds. Fix: make `ok` a `let`.

### 4. Route Inventory Refresh
- Currently tests 3 unknown tokens per cycle. Should also re-check held positions that previously failed (BRETT, EVAA).

### 5. RaisedSyms blocks re-buy of recently sold positions
- After OB sell of ZEC, raisedSyms 30-min cooldown blocked re-buy in some cases. In others, the re-buy happened despite raisedSyms check (not in the BUY path). The OB threshold fix (92+score guard) should prevent this scenario entirely — better to not sell than to sell and block re-buy.

### 6. Top-up when position count < MAX_POSITIONS and USDC low
- Currently TOPUP only fires when `nonStablePositions.length >= MAX_POSITIONS`. With open slots and idle USDC below MIN_POSITION_VALUE, no action taken. Should consider topping up existing positions even with slots open.

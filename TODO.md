# TODO

## What Are `1cs_v1:` Tokens?

`1cs_v1:{chain}:{type}:{address}` is a cross-chain token ID format used by 1Click for assets that aren't native NEP-141 on NEAR.

**Problem:** These tokens work for trading (1Click can swap them) but `mt_batch_balance_of` on `intents.near` returns **0** for them. The NEAR intents balance API only supports NEP-141 format (`nep141:{address}`). This means the agent trades into assets it can never read back, causing:

- Incorrect portfolio total (invisible position missing)
- Agent never detects the position for sell decisions
- Unnecessary sell of other positions to "raise USDC" when funds are already there

**Example:** BTC(OMNI) (`1cs_v1:btc:native:coin`) vs BTC (`nep141:btc.omft.near`). Same underlying Bitcoin, two different token standards. The `nep141:` version is readable, the `1cs_v1:` version is not.

## Done

- [x] **Block `1cs_v1:*` tokens** (`agent.js:579-582`) — All PORTFOLIO entries with `1cs_v1:` asset IDs are added to `failedTokens` at startup, preventing the agent from buying invisible tokens.
- [x] **raisedSyms cooldown 10→30 min** (`agent.js:398`) — Prevents near-miss cooldown expiry (e.g., KAITO blocked by 30s at 15:11, then re-bought next cycle).
- [x] **BTC(OMNI) recovery** (`agent.js:621-651`) — After `fetchBals()`, scans `costBasis` for stranded `1cs_v1:` tokens (balance=0, cost>0) and sells them to USDC.
- [x] **Route re-check skips `1cs_v1:`** (`agent.js:682`) — The failed-token re-check loop (lines 677-693) used to restore `1cs_v1:` tokens because they have working swap routes, defeating the block. Now it skips them.
- [x] **TOPUP action** (`agent.js:779-796, 1171-1215`) — When at 3/3 cap with idle USDC ≥$2.00, reinvests into best position below its tier max (60/25/15). In-memory bals + cost basis updated.

## Pending Improvements

### 1. RSI Coverage

Still missing RSI for many tokens due to:
- CoinGecko rate limits (~20 calls/min with 5s sleep is safe but still marginal with 15+ tokens)
- Only held tokens + top 15 are fetched (line 594)
- wNEAR explicitly excluded by `CG_IDS[s] !== 'near'` filter

**Fix ideas:**
- Remove `CG_IDS[s] !== 'near'` filter — NEAR OHLC is valid for wNEAR price
- Prefer held tokens first, then limit to top 10 tradeable candidates (not all top 15)
- Add CG ID for `NearKat` (already done), keep checking for new route-inventory tokens

### 2. Portfolio Display / Balance Fidelity

- `mt_batch_balance_of` with `optimistic` finality lags ~10-20 min behind on-chain state
- In-memory `bals` updates at trade sites help but don't survive restarts
- `1cs_v1:` tokens remain permanently invisible — blocked from trading but still unrecoverable if somehow acquired

### 3. Agent Flip-Flopping (Ping-Pong)

The raisedSyms 30-min cooldown helps, but two deeper issues remain:

- **Rotation trigger uses wrong buy target:** The decision reason names the trigger candidate (e.g., KAITO→BTC(OMNI)), but execution independently picks the first buyable target (e.g., XAUT). Fixed the reason string at line 690.
- **Rotation sell can undermine recent buys:** If the agent rotates into XAUT, then 30 min later sells XAUT to buy something else, the original rotation was pointless. A minimum hold period (e.g., 1 hour before a rotated-into position can be sold) would prevent this.

### 4. Cooldown Gate Check

The `ok` (cooldown) variable at line 485 is `const` — computed once at startup. If recovery trades during the run and calls `markTrade()`, the main execution still proceeds because `ok` was evaluated before recovery. Fix: make `ok` a `let` and re-check after recovery.

### 5. CG Price Caching

CoinGecko rate limits crash the agent (`RATE_LIMITED`). Cache CG prices with a 60s TTL to avoid redundant calls during the same cycle.

### 6. Route Inventory Refresh

Currently tests 3 unknown tokens per cycle to discover new routes. Should also refresh routes for held positions that previously failed (BRETT, EVAA, AAVE, Ondo ETFs).

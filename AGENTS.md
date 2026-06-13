# NEAR Intents Trading Bot

## Account
- Address: `0c279aaeb803608f60bf8eac25a52570e4a32551f5feb854f0f0355f028760ed`
- Private key: `ed25519:5hBA7ZEzD8cZV2otawo2SfnUnvyf4PvoEzp8wNMx9xkF5Gy1p1wS9NwDLHJD3MNCLewxKcdjfRLKUmuBAiuUQj7a`
- Public key: `ed25519:pSvH1pzY1drdsquruJsEL8M4KFRgz8vsxGBdNpHqw6L`
- Native NEAR: ~2.46 NEAR (~$5.04 for gas)
- Key stored in OS keychain

## Config
- `opencode.jsonc` — MCP server: `@iqai/mcp-near-intent-swaps`
- `~/.config/near-cli/config.toml` — RPC: `archival-rpc.mainnet.near.org` (aggressive rate limiting!)
- JWT token in `~/.bashrc` line 146 (env var: `NEAR_SWAP_JWT_TOKEN`)
- Also used as `X-API-Key` for solver-relay-v2

## Rate Limiting
- NEAR CLI uses `archival-rpc.mainnet.near.org` — rate limits after ~3-4 calls
- **Workaround:** Wait ~30-60s between calls OR use `send_tx.js` (custom script) which sends directly to `rpc.mainnet.near.org`
- For read-only queries (mt_batch_balance_of, ft_balance_of): use `rpc.mainnet.near.org` via `curl` or Node.js instead of NEAR CLI
- FastNEAR (`rpc.fastnear.com`) also has rate limits — alternative is `rpc.mainnet.near.org`

## NEAR CLI Syntax (v0.27)
```bash
near contract call-function as-transaction <CONTRACT> <METHOD> json-args '<JSON>' \
  prepaid-gas "30 TGas" attached-deposit "<AMOUNT>" \
  sign-as <ACCOUNT> network-config mainnet sign-with-keychain send

near contract call-function as-read-only <CONTRACT> <METHOD> json-args '<JSON>' \
  network-config mainnet now
```

### Examples
```bash
# Wrap NEAR → wNEAR
near contract call-function as-transaction wrap.near near_deposit json-args '{}' \
  prepaid-gas "30 TGas" attached-deposit "1 NEAR" \
  sign-as 0c279aaeb803608f60bf8eac25a52570e4a32551f5feb854f0f0355f028760ed \
  network-config mainnet sign-with-keychain send

# Check wNEAR balance (wallet)
near contract call-function as-read-only wrap.near ft_balance_of \
  json-args '{"account_id":"0c279aaeb803608f60bf8eac25a52570e4a32551f5feb854f0f0355f028760ed"}' \
  network-config mainnet now

# Check token balance in intents
near contract call-function as-read-only intents.near mt_batch_balance_of \
  json-args '{"account_id":"0c279aaeb803608f60bf8eac25a52570e4a32551f5feb854f0f0355f028760ed","token_ids":["nep141:plasma.omft.near"]}' \
  network-config mainnet now
```

## Custom Script: send_tx.js
When NEAR CLI is rate limited, use `send_tx.js` to submit on-chain transactions directly:
```bash
cd /home/jbz/code/trading && node send_tx.js ft_transfer <RECEIVER_ID> <AMOUNT_RAW> <MEMO>
```
It signs+submits via `rpc.mainnet.near.org` using the private key from this file.

---

# Swap Flows

## Flow A: Wallet-Held Tokens → INTENTS (ORIGIN_CHAIN deposit)
Used when source token is in your NEAR wallet (e.g., wNEAR on wrap.near).

```bash
# 1. Get quote with deposit address
curl -s -X POST 'https://1click.chaindefuser.com/v0/quote' \
  -H "Authorization: Bearer $NEAR_SWAP_JWT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"dry":false,"swapType":"EXACT_INPUT","depositMode":"SIMPLE","slippageTolerance":100,
       "originAsset":"nep141:wrap.near","destinationAsset":"nep141:base-0xacfe...",
       "amount":"<RAW_AMOUNT>",
       "recipient":"0c279a...","recipientType":"INTENTS",
       "refundTo":"0c279a...","refundType":"INTENTS",
       "depositType":"ORIGIN_CHAIN",
       "deadline":"2026-06-14T00:00:00.000Z"}'

# 2. storage_deposit for deposit address on wrap.near (first time only)
near contract call-function as-transaction wrap.near storage_deposit \
  json-args '{"account_id":"<DEPOSIT_ADDR>"}' \
  prepaid-gas "30 TGas" attached-deposit "0.01 NEAR" \
  sign-as 0c279a... network-config mainnet sign-with-keychain send

# 3. ft_transfer wNEAR to deposit address
near contract call-function as-transaction wrap.near ft_transfer \
  json-args '{"receiver_id":"<DEPOSIT_ADDR>","amount":"<RAW_AMOUNT>","memo":"swap"}' \
  prepaid-gas "30 TGas" attached-deposit "1 yoctoNEAR" \
  sign-as 0c279a... network-config mainnet sign-with-keychain send

# 4. Notify 1Click API
curl -s -X POST 'https://1click.chaindefuser.com/v0/deposit/submit' \
  -H "Authorization: Bearer $NEAR_SWAP_JWT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"txHash":"<TX_HASH>","depositAddress":"<DEPOSIT_ADDR>"}'

# 5. Poll until SUCCESS
curl -s "https://1click.chaindefuser.com/v0/status?depositAddress=<DEPOSIT_ADDR>" \
  -H "Authorization: Bearer $NEAR_SWAP_JWT_TOKEN"
```

## Flow B: Intents-Held Tokens → INTENTS (INTENTS deposit)
Used when source token is already in the intents system (e.g., XPL, VVV from prior swaps).

```bash
# 1. Get quote with depositAddress (depositType: INTENTS)
curl -s -X POST 'https://1click.chaindefuser.com/v0/quote' \
  -H "Authorization: Bearer $NEAR_SWAP_JWT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"dry":false,"swapType":"EXACT_INPUT","depositMode":"SIMPLE","slippageTolerance":100,
       "originAsset":"nep141:plasma.omft.near","destinationAsset":"nep141:wrap.near",
       "amount":"<RAW_AMOUNT>",
       "recipient":"0c279a...","recipientType":"INTENTS",
       "refundTo":"0c279a...","refundType":"INTENTS",
       "depositType":"INTENTS",
       "deadline":"2026-06-14T00:00:00.000Z"}'

# 2. Generate intent (creates NEP-413 payload to sign)
curl -s -X POST 'https://1click.chaindefuser.com/v0/generate-intent' \
  -H "Authorization: Bearer $NEAR_SWAP_JWT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"swap_transfer","depositAddress":"<DEPOSIT_ADDR>","signerId":"0c279a...","standard":"nep413"}'
# → returns {intent: {payload: {message, nonce, recipient}}}

# 3. Sign with Borsh NEP-413 (use /tmp/nep413_sign_v2.js)
node /tmp/nep413_sign_v2.js sign "<MESSAGE>" "<NONCE>" "intents.near" "ed25519:5hBA..."
# → returns {signature: "..."}

# 4. Publish to solver relay
curl -s -X POST 'https://solver-relay-v2.chaindefuser.com/rpc' \
  -H "X-API-Key: $NEAR_SWAP_JWT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"id":1,"jsonrpc":"2.0","method":"publish_intent",
       "params":[{"quote_hashes":[],"signed_data":{
         "standard":"nep413",
         "payload":{"message":"<MSG>","nonce":"<NONCE>","recipient":"intents.near"},
         "public_key":"ed25519:pSvH1pzY1drdsquruJsEL8M4KFRgz8vsxGBdNpHqw6L",
         "signature":"<SIG>"
       }}]}'
# → returns {result: {status: "OK", intent_hash: "..."}}

# 5. Also submit to 1Click (backup)
curl -s -X POST 'https://1click.chaindefuser.com/v0/submit-intent' \
  -H "Authorization: Bearer $NEAR_SWAP_JWT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"type":"swap_transfer","signedData":{
    "standard":"nep413",
    "payload":{"message":"<MSG>","nonce":"<NONCE>","recipient":"intents.near"},
    "public_key":"ed25519:pSvH1pzY1drdsquruJsEL8M4KFRgz8vsxGBdNpHqw6L",
    "signature":"<SIG>"
  }}'

# 6. Wait for SETTLED from solver relay
curl -s -X POST 'https://solver-relay-v2.chaindefuser.com/rpc' \
  -H "X-API-Key: $NEAR_SWAP_JWT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"id":1,"jsonrpc":"2.0","method":"get_status",
       "params":[{"intent_hash":"<INTENT_HASH>"}]}'
# → look for status: "SETTLED" → get txHash

# 7. Submit to 1Click deposit/submit with txHash from settlement
curl -s -X POST 'https://1click.chaindefuser.com/v0/deposit/submit' \
  -H "Authorization: Bearer $NEAR_SWAP_JWT_TOKEN" -H 'Content-Type: application/json' \
  -d '{"txHash":"<TX_HASH>","depositAddress":"<DEPOSIT_ADDR>"}'

# 8. Poll for SUCCESS
curl -s "https://1click.chaindefuser.com/v0/status?depositAddress=<DEPOSIT_ADDR>" \
  -H "Authorization: Bearer $NEAR_SWAP_JWT_TOKEN"
```

### Key detail — Borsh NEP-413 signing
The 1Click `submit-intent` endpoint will accept incorrect signatures (old ad-hoc format: `sha256("NEP413")[:4] || sha256(recip) || sha256(msg) || nonce`) but the Verifier contract rejects them. Must use proper Borsh serialization: `Borsh({message, nonce, recipient, callback_url})` prefixed with `u32: 2147484061`, then SHA-256, then Ed25519 sign.

## Routeless Tokens (No exit routes)
- XPL (`nep141:plasma.omft.near`) on Plasma chain — had routes on June 12 but disappeared June 13
- MELANIA, XAUT — never had routes

---

# Trades Executed

## Initial Buys (June 11-12)
| # | Date | Swap | Amount In | Amount Out | Time | Status |
|---|------|------|-----------|------------|------|--------|
| 1 | 2026-06-11 | wNEAR → AURORA | 0.00375 wNEAR ($0.01) | 0.1947 AURORA ($0.01) | ~7s | ✅ |
| 2 | 2026-06-11 | wNEAR → SPX (Solana) | 0.5 wNEAR ($1.02) | 3.21 SPX ($1.02) | ~5s | ✅ |
| 3 | 2026-06-11 | wNEAR → MON (Monad) | 0.1 wNEAR ($0.20) | 9.30 MON ($0.20) | ~20s | ✅ |
| 4 | 2026-06-12 | wNEAR → AURORA | 1 wNEAR ($2.05) | 76.26 AURORA ($2.05) | ~5s | ✅ |
| 5 | 2026-06-12 | wNEAR → VVV (Base) | 2 wNEAR ($4.18) | 0.2871 VVV ($4.19) | ~30s | ✅ |
| 6 | 2026-06-12 | wNEAR → INX (Ethereum) | 0.952 wNEAR ($2.00) | 262.6 INX ($2.00) | ~5s | ✅ |
| 7 | 2026-06-12 | wNEAR → VVV (Base) | 0.952 wNEAR ($2.00) | 0.136 VVV ($2.00) | ~10s | ✅ |
| 8 | 2026-06-12 | wNEAR → INX (Ethereum) | 0.952 wNEAR ($2.00) | 256.5 INX ($1.98) | ~5s | ✅ |
| 9 | 2026-06-12 | wNEAR → AURORA | 0.952 wNEAR ($2.00) | 64.88 AURORA (~$2.00) | ~5s | ✅ |

## Portfolio Rotation (June 12-13)
| # | Date | Swap | Amount In | Amount Out | Time | Flow | Status |
|---|------|------|-----------|------------|------|------|--------|
| 10 | 2026-06-12 | VVV (intents) → wNEAR | 0.4231 VVV ($6.19) | 3.0156 wNEAR | ~30s | Flow B | ✅ |
| 11 | 2026-06-12 | INX (intents) → wNEAR | 519.1 INX ($3.98) | 2.0937 wNEAR | ~30s | Flow B | ✅ |
| 12 | 2026-06-12 | MON (intents) → wNEAR | 9.30 MON ($0.20) | 0.0978 wNEAR | ~20s | Flow B | ✅ |
| 13 | 2026-06-12 | SPX (intents) → wNEAR | 3.21 SPX ($1.03) | 0.0051 wNEAR ($0.01) | ~15s | Flow B | ✅ ⚠️ 99% loss |
| 14 | 2026-06-12 | wNEAR (intents) → XPL | 4.5 wNEAR | 108.91 XPL | ~20s | Flow B | ✅ |
| 15 | 2026-06-12 | wNEAR (intents) → XPL | 0.7122 wNEAR | 17.25 XPL | ~15s | Flow B | ✅ |
| 16 | 2026-06-13 | wNEAR (wallet) → VVV (intents) | 1.244 wNEAR ($2.55) | 0.1487 VVV ($2.51) | ~25s | Flow A | ✅ |
| 17 | 2026-06-13 | SPX (intents) → wNEAR | 3.1776 SPX ($1.02) | 0.4969 wNEAR | ~15s | Flow B | ✅ |
| 18 | 2026-06-13 | wNEAR (intents) → APT (intents) | 0.4969 wNEAR | 1.496 APT | ~15s | Flow B | ✅ |
| 19 | 2026-06-13 | wNEAR (wallet) → AAVE (intents) | 1 wNEAR ($2.05) | 0.03037 AAVE (~$2.01) | ~5s | Flow A | ✅ |
| 20 | 2026-06-13 | XPL (intents) → KAITO (Base) | 126.165 XPL ($10.80) | 25.474 KAITO (~$10.85) | ~30s | Flow B | ✅ |
| 21 | 2026-06-13 | KAITO (intents) → USDC | 25.474 KAITO ($10.85) | 10.825 USDC | ~20s | Flow B | ✅ |
| 22 | 2026-06-13 | VVV (intents) → USDC | 0.1487 VVV ($2.51) | 2.554 USDC | ~20s | Flow B | ✅ |
| 23 | 2026-06-13 | APT (intents) → USDC | 1.496 APT ($1.00) | 0.991 USDC | ~15s | Flow B | ✅ |
| 24 | 2026-06-13 | AAVE (intents) → USDC | 0.03037 AAVE ($2.01) | 2.025 USDC | ~15s | Flow B | ✅ |
| 25 | 2026-06-13 | VVV (intents) → USDC | 0.9014 VVV ($15.52) | 15.523 USDC | ~20s | Flow B | ✅ |
| 26 | 2026-06-13 | USDC (intents) → AAVE | 15.53 USDC | 0.2332 AAVE (~$15.53) | ~15s | Flow B | ✅ |
| 27 | 2026-06-13 | AURORA (intents) → USDC | 76.26 AURORA ($2.03) | 2.035 USDC | ~10s | Flow B | ✅ |
| 28 | 2026-06-13 | USDC (intents) → OP | 7.23 USDC ($7.23) | 65.13 OP ($7.17) | ~37s | Flow B | ✅ |

### Notes on rotation
- Trades 10-13 used Flow B (INTENTS deposit) to sell portfolio tokens → wNEAR in intents
- Trade 13 (SPX) lost ~99% — terrible swap rate for SPX despite listed 16% spread
- Trades 14-15 used Flow B to swap all intents wNEAR → XPL
- XPL routes disappeared the next day — then reappeared June 13 — sold in Trade 20
- Trade 16 wrapped 1 NEAR, combined with 0.244 wallet wNEAR, swapped → VVV via Flow A
- Trade 17 recovered remaining SPX (3.1776) — previously the SPX decimal was wrong (token has 8 decimals, not 6), so only 1% was sold in Trade 13
- Trade 18 diversified into APT (score 5, RSI 59, neutral)
- Trade 20 exited XPL for KAITO (swing candidate, RSI ~55, score 3, good volume)
- Trades 21-24: **Agent risk-off trigger** — sold all positions to USDC (F&G=13 Extreme Fear, gold down). One token per cycle.
- Trade 28: Manual buy of OP ($7.23, sc=7, +12.5%) after agent skipped it ($2.25 USDC too low for min $5 position)
- The original portfolio value ($14.57) net loss after all trades: ~$19.36 → **~$17.92** (OP position at $7.17, spread $0.06)

---

# Current Portfolio

| Asset | Location | Raw Balance | Decimals | Human Amount | USD Price | Value |
|-------|----------|-------------|----------|-------------|-----------|-------|
| VVV | intents | `561888000000000000` | 18 | 0.562 VVV | $17.52 | $9.84 |
| OP | intents | `65130002194256999999` | 18 | 65.13 OP | $0.11 | $7.17 |
| NEAR | wallet | ~1.467 | 24 | 1.467 NEAR | $2.04 | $2.99 |
| AAVE | intents | `7439101673240000000` | 18 | 0.0744 AAVE | $66.97 | $4.99 |
| **Total** | | | | | | **~$24.99** |

## Token IDs
- wNEAR: `nep141:wrap.near` (24 decimals)
- XPL: `nep141:plasma.omft.near` (18 decimals) — ⚠️ sell routes intermittent (appeared/disappeared June 13)
- KAITO (Base): `nep141:base-0x98d0baa52b2d063e780de12f615f963fe8537553.omft.near` (18 decimals)
- VVV: `nep141:base-0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf.omft.near` (18 decimals)
- AURORA: `nep141:aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near` (18 decimals)
- INX: `nep141:eth-0xdef1b2d939edc0e4d35806c59b3166f790175afe.omft.near` (18 decimals)
- SPX: `nep141:sol-c634d063ceff771aff0c972ec396fd915a6bbd0e.omft.near` (8 decimals) or `nep141:eth-0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c.omft.near` (8 decimals, ETH)
- MON: `nep245:v2_1.omni.hot.tg:143_11111111111111111111` (18 decimals)
- KAITO (Base): `nep141:base-0x98d0baa52b2d063e780de12f615f963fe8537553.omft.near` (18 decimals)
- APT (Aptos): `nep141:aptos.omft.near` (8 decimals)
- OP (Optimism): `nep245:v2_1.omni.hot.tg:10_vLAiSt9KfUGKpw5cD3vsSyNYBo7` (18 decimals)
- USDC (NEAR): `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (6 decimals)
- USDC (NEAR): `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (6 decimals)
- USDT0 (Plasma): `nep141:plasma-0xb8ce59fc3717ada4c02eadf9682a9e934f625ebb.omft.near`
- MELANIA: `nep141:sol-d600e625449a4d9380eaf5e3265e54c90d34e260.omft.near` ❌
- XAUT: `nep141:eth-0x68749665ff8d2d112fa859aa293f07a622782f38.omft.near` ❌

## Swappable Tokens (confirmed working via INTENTS)
- VVV (Base) ✅ — score 7, RSI 79 (overbought), good volume
- INX (Ethereum) ✅ — score requires checking
- AURORA (NEAR) ✅ — native NEP-141
- wNEAR (NEAR) ✅ — native NEP-141
- BERA (Berachain) ✅
- KAITO (Base) ✅ — score 3, RSI ~55, neutral, swing candidate
- APT (Aptos) ✅ — score 3, RSI ~59, neutral
- OP (Optimism) ✅ — score 7, +12.5%, strong momentum

---

# API Reference

## 1Click API (chaindefuser)
- Base: `https://1click.chaindefuser.com`
- Auth: `Authorization: Bearer $NEAR_SWAP_JWT_TOKEN`
- **Endpoints:**
  - `GET /v0/tokens` — list supported tokens with prices
  - `POST /v0/quote` — get swap quote (dry=true for preview, dry=false → get depositAddress)
  - `POST /v0/generate-intent` — generate NEP-413 payload for signing
  - `POST /v0/submit-intent` — submit signed intent
  - `POST /v0/deposit/submit` — notify after depositing funds
  - `GET /v0/status?depositAddress=...` — poll swap status

## Solver Relay
- Base: `https://solver-relay-v2.chaindefuser.com/rpc`
- Auth: `X-API-Key: $NEAR_SWAP_JWT_TOKEN` (same JWT token)
- Methods: `publish_intent`, `get_status` (JSON-RPC POST)
- Response: `{result: {status: "OK"|"SETTLED"|"NOT_FOUND_OR_NOT_VALID", intent_hash, data: {hash: "..."}}}`

## Key Fields for Quote
| Field | Values |
|-------|--------|
| `swapType` | `EXACT_INPUT` (most common), `EXACT_OUTPUT` |
| `depositMode` | `SIMPLE` (always) |
| `depositType` | `ORIGIN_CHAIN` (wallet-held source), `INTENTS` (intents-held source) |
| `recipientType` | `INTENTS` (receive via intents), `DESTINATION_CHAIN` (bridge to token chain) |
| `refundType` | `INTENTS` (refund to intents), `ORIGIN_CHAIN` (refund to wallet) |
| `slippageTolerance` | Basis points — `100` = 1% |

---

# Portfolio Check (screener.js)
The screener is in `screener.js` — reads `tokens.json` and `coinList.json` for market data.
- Run with: `node /home/jbz/code/trading/screener.js`
- HOLDINGS config must be updated manually for current portfolio
- Exit logic:
  - SELL if P&L < -10% (stop loss)
  - SELL if P&L < 0 AND score < -2
  - WATCH if P&L < -5%
  - SELL ALL if risk-off: Fear & Greed < 30 AND (gold down OR >60% of top 15 assets negative)
- Risk-off target: USDC (stable)
- Normal target: top 3 scoring assets (score > 5)

## Notes
- Market sentiment: Extreme Fear (13/100) — unchanged since start
- Minimum swap: ~$0.01 equivalent
- Spread varies: VVV (~1.5%) < AURORA (~0.6%) < MON (~5%) < SPX (~16%) < XAUT (~13.5%)
- Token list cached in `tokens.json`, CoinGecko list in `coinList.json`

---

# Agent (`agent.js`)

Runs every **5 minutes** via cron. Monitors market + portfolio and executes swaps when conditions trigger.

## Status: Monitor-only (no swaps executed)
Agent checks every 5 min but doesn't trade yet. Enable execution by adding JWT to `.env`.

## Decision Logic
```
1. GAS CHECK: if NEAR < 1.0 → HOLD (need gas reserves)
2. RE-ENTRY: if positions < 3 → find crypto with score ≥ 3, RSI < 80 → BUY
   - Allocation: 1st=60% USDC, 2nd=50% remaining, 3rd=rest (min $5)
3. OVERBOUGHT: if any holding RSI > 85 → SELL that one
4. WEAK: if any holding score < 1 → SELL that one
5. ROTATE: if better asset found (score ≥ 3, RSI < 80, delta ≥ +3) → ROTATE
6. SPREAD GUARD: skip any swap if effective spread > 4%
7. else → HOLD
```

## State Files
| File | Purpose |
|------|---------|
| `.env` | JWT token + private key (fill in to enable trading) |
| `.last_trade` | Timestamp of last trade (5-min cooldown) |
| `agent.log` | Full run log (appended every cycle) |

## Config
- **Stable target:** USDC (NEAR native) — `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1`
- **Cooldown:** 5 min between actual trades
- **Min trade:** $0.50 (ignore dust)
- **Gas reserve:** 1.0 NEAR minimum
- **Max positions:** 3 (non-stable)
- **Min position value:** $5.00
- **Max spread:** 4% (skip swaps exceeding this)
- **Overbought threshold:** RSI > 85
- **Weak asset threshold:** score < 1
- **New opp threshold:** score ≥ 3, RSI < 80
- **Rotation delta:** +3

## To Enable Trading
```bash
# 1. Find your JWT
echo $NEAR_SWAP_JWT_TOKEN

# 2. Edit .env and fill in the JWT
nano /home/jbz/code/trading/.env

# 3. Verify by running agent once
node /home/jbz/code/trading/agent.js
```

## Logs
Check logs anytime:
```bash
tail -f /home/jbz/code/trading/agent.log
```

## Relevant Files
- `opencode.jsonc` — MCP server for NEAR Intents swaps
- `AGENTS.md` — this file
- `agent.js` — autonomous market agent (runs via cron)
- `agent.log` — agent run log
- `.env` — credentials (JWT + private key)
- `.last_trade` — trade cooldown tracker
- `portfolio_history.json` — portfolio snapshots + P&L tracking
- `nep413_sign.js` — Borsh NEP-413 signing (zero ESM deps)
- `screener.js` — TA + sentiment + portfolio check + swing candidates
- `send_tx.js` — bypass CLI rate limits for ft_transfer
- `tokens.json` — cached token list from 1Click API
- `coinList.json` — cached CoinGecko coin list

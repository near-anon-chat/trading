# NEAR Intents Trading Bot

## Account
- Address: `0c279aaeb803608f60bf8eac25a52570e4a32551f5feb854f0f0355f028760ed`
- Balance: ~6.48 NEAR (after wraps: ~4.48 NEAR usable)
- Key: OS keychain (ed25519:pSvH1pzY1drdsquruJsEL8M4KFRgz8vsxGBdNpHqw6L)
- NEAR CLI v0.27 syntax: `prepaid-gas "30 TGas" attached-deposit "1 NEAR" sign-as <ACCOUNT> network-config mainnet sign-with-keychain send`

## Config
- `opencode.jsonc` — MCP server: `@iqai/mcp-near-intent-swaps`
- `~/.config/near-cli/config.toml` — RPC: rpc.fastnear.com
- JWT token in `~/.bashrc` line 146 (env var: `NEAR_SWAP_JWT_TOKEN`)

## NEAR Intents 1Click API
- Base: `https://1click.chaindefuser.com`
- Auth: Bearer JWT from env var
- Endpoints:
  - `GET /v0/tokens` — list supported tokens
  - `POST /v0/quote` — get swap quote (dry=true for preview)
  - `POST /v0/deposit/submit` — notify after depositing
  - `GET /v0/status?depositAddress=...` — check swap status

## Swap Flow
1. `POST /v0/quote` (dry=false) with `recipientType: "INTENTS"` → get depositAddress
2. `storage_deposit` the deposit address on wrap.near first (only for wNEAR as source)
3. `ft_transfer` wNEAR to deposit address
4. `POST /v0/deposit/submit` with txHash + depositAddress
5. `GET /v0/status` → wait for SUCCESS

## Trades Executed

| # | Date | Swap | Amount In | Amount Out | Time | Status |
|---|------|------|-----------|------------|------|--------|
| 1 | 2026-06-11 | wNEAR → AURORA | 0.00375 wNEAR ($0.0077) | 0.1947 AURORA ($0.0051) | ~7s | ✅ |
| 2 | 2026-06-11 | wNEAR → SPX (Solana) | 0.5 wNEAR ($1.02) | 3.21 SPX ($1.02) | ~5s | ✅ |
| 3 | 2026-06-11 | wNEAR → MON (Monad) | 0.1 wNEAR ($0.20) | 9.30 MON ($0.20) | ~20s | ✅ |
| 4 | 2026-06-12 | wNEAR → AURORA | 1 wNEAR ($2.05) | 76.26 AURORA ($2.05) | ~5s | ✅ |
| 5 | 2026-06-12 | wNEAR → VVV (Base) | 2 wNEAR ($4.18) | 0.2871 VVV ($4.19) | ~30s | ✅ |
| 6 | 2026-06-12 | wNEAR → INX (Ethereum) | 0.952 wNEAR ($2.00) | 262.6 INX ($2.00) | ~5s | ✅ |
| 7 | 2026-06-12 | wNEAR → VVV (Base) | 0.952 wNEAR ($2.00) | 0.136 VVV ($2.00) | ~10s | ✅ |
| 8 | 2026-06-12 | wNEAR → INX (Ethereum) | 0.952 wNEAR ($2.00) | 256.5 INX ($1.98) | ~5s | ✅ |

### Notes
- Trades 2-8 used `recipientType: "INTENTS"` — tokens held in intents system
- SPX, MON, VVV, INX held via intents; AURORA is native NEP-141
- Trade 5 used direct curl call (MCP tool had transient issue) — same 1Click API
- Remaining: ~0.25 wNEAR in wallet

## Token IDs
- wNEAR: `nep141:wrap.near` (24 decimals)
- AURORA: `nep141:aaaaaa20d9e0e2461697782ef11675f668207961.factory.bridge.near` (18 decimals)
- USDC (NEAR): `nep141:17208628f84f5d6ad33f0da3bbbeb27ffcb398eac501a31bd6ad2011e36133a1` (6 decimals)
- VVV: `nep141:base-0xacfe6019ed1a7dc6f7b508c02d1b04ec88cc21bf.omft.near` (18 decimals)
- INX: `nep141:eth-0xdef1b2d939edc0e4d35806c59b3166f790175afe.omft.near` (18 decimals)
- SPX: `nep141:sol-c634d063ceff771aff0c972ec396fd915a6bbd0e.omft.near` (6 decimals) or `nep141:eth-0xe0f63a424a4439cbe457d80e4f4b51ad25b2c56c.omft.near` (8 decimals, ETH)
- MON: `nep245:v2_1.omni.hot.tg:143_11111111111111111111` (18 decimals)
- MELANIA: `nep141:sol-d600e625449a4d9380eaf5e3265e54c90d34e260.omft.near` (❌ no swap route)
- XAUT: `nep141:eth-0x68749665ff8d2d112fa859aa293f07a622782f38.omft.near` (❌ no swap route)
- Token list cached in `tokens.json` (188 tokens, 34 chains)

## Swappable Tokens (confirmed working wNEAR → X via INTENTS)
- VVV (Base) ✅ — score 4, RSI 44, good volume
- INX (Ethereum) ✅ — score 6, RSI 87 (overbought)
- AURORA (NEAR) ✅ — native NEP-141
- SPX (Solana) ✅ — score 3
- BERA (Berachain) ✅
- KAITO (Base) ✅

## Ondo ETFs (via Yahoo Finance)
GOOGLon, SPYon, QQQon, NVDAon, AAPLon, MSFTon, TSLAon, AMZNon, METAon,
GLDon, IAUon, SLVon, AGGon, TLTon, USDon

## Portfolio Check (screener.js)
- `HOLDINGS` config:
  - VVV: 0.4231 @ $14.63 (base)
  - AURORA: 76.4547 @ $0.0269 (near)
  - INX: 519.1 @ $0.00766 (eth)
  - SPX: 3.21 @ $0.3178 (sol)
  - wNEAR: 0.1 @ $2.05 (near)
  - MON: 9.30 @ $0.0215 (monad)
- Total portfolio value: ~$11.77
- Exit logic (applied per holding):
  - SELL if P&L < -10% (stop loss)
  - SELL if P&L < 0 AND score < -2 (negative momentum)
  - WATCH if P&L < -5% (approaching stop loss)
  - SELL ALL if risk-off: Fear & Greed < 30 AND (gold down OR >60% of top 15 assets negative)
- Risk-off swaps target: USDC on NEAR
- Normal swaps target: top 3 scoring assets (score > 5)

## Notes
- Minimum swap: ~10,000 units USDC ($0.01) or equivalent
- deposit address needs `storage_deposit` on wrap.near before receiving wNEAR
- Always use `recipientType: "INTENTS"` to avoid bridge withdraw fees
- Swap spread varies: VVV (~1.5%) ≈ AURORA (~0.6%) < MON (~5%) < SPX (~16%) < XAUT (~13.5%)
- Market sentiment: Extreme Fear (12/100) — unchanged since start

## Relevant Files
- `opencode.jsonc` — MCP server for NEAR Intents swaps
- `AGENTS.md` — this file, full project context
- `screener.js` — TA + sentiment analysis + portfolio check + swing candidates
- `tokens.json` — cached token list from 1Click API
- `coinList.json` — cached CoinGecko coin list (avoids rate limiting)
- `test_swap_routes.sh` — helper to check which swap routes work

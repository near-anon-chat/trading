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
- [x] **Buy threshold raised sc≥5→sc≥6** — Prevents buying XLM (sc=5 repeat) and TURBO (sc=5→sc=1). Entry gates in agent.js lines 927, 943.

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

### 7. Score Stability Timer
Prevents the TURBO pattern: buy at sc=5, crashes to sc=1 next cycle.

Design:
- Persistent file `.score_history.json`: `{"SYM": [7, 7, 6]}` (newest first, max 5 entries)
- Record every candidate's sc each cycle
- If gap between entries > 10 min → reset (detects restarts)
- Buy gate: require last N entries all ≥ threshold (e.g., N=3, threshold=7)
- On sell: clear history for that sym (fresh start if it recovers)

Changes in `agent.js`:
- Load/save `.score_history.json` each cycle
- After ranking, append each candidate's score to history
- In buy filter, add `isStable(sym)` check: last N entries all ≥ threshold
- On sell, delete `scoreHistory[sym]`

### 8. Capital Preservation — Tighten Entry Criteria
Proposed to prevent death-by-spreads + death-by-junk-buys. Trade only high conviction.

| Parameter | Current | Proposed | Reason |
|---|---|---|---|
| Min score | sc≥6 | **sc≥7** | sc=6 still junk territory (TURBO crashed sc=5→1 after buy at sc=5) |
| Max spread | 4% | **1%** | Size-aware (dry-run quotes exact amount). Blocks MON 5%, SPX 16%; allows AURORA 0.6%, tight XLM |
| RSI required | No (RS-- allowed) | **Must have RSI** | No blind buys on tokens without data (might be OB) |
| Min position | $2.00 | **$10.00** | $2-3 trades get eaten by spreads/fees |
| Stop loss | None | **-5%** | Cut losses before compounding |
| Score stability | None | **3 cycles ≥ threshold** | Prevents TURBO-style spike-and-crash buys |
| F&G gate | None | None | Trade fear markets too |
| 24h change req | None | None | Catch intraday moves |

Changes needed in `agent.js`:
- `MIN_POSITION_VALUE` → 10.00
- `MAX_SPREAD_PCT` → 1.0 (was 4.0)
- Buy candidate filter: `a.sc >= 7` and `a.r !== undefined` (RSI required) and `isStable(a.sym)` (last 3 ≥ 7)
- Add stop-loss sell: any position with P&L < -5% triggers SELL
- Add `.score_history.json` persistence and stability check
- Junk threshold stays `sc < 5`, OB stays `rsi > 92 && sc < 7`

### 9. Hybrid Rules + AI (LLM Vetting Layer)
Proposed to solve the **allocation problem** and provide reasoning beyond static rules.

#### The Hybrid Model

```
┌─────────────────────────────────────────────────────────┐
│                    agent.js CYCLE                        │
│                      (every 5 min)                       │
├─────────────────────────────────────────────────────────┤
│                                                          │
│  ┌──────────────────────┐    ┌──────────────────────┐   │
│  │   RULES ENGINE       │    │   LLM VETTING        │   │
│  │   (fast + free)      │    │   (slow + reasoning) │   │
│  │                      │    │                      │   │
│  │ • Gas check          │    │ Only called when     │   │
│  │ • Cooldowns          │    │ rules propose a      │   │
│  │ • Route inventory    │    │ trade. Receives:     │   │
│  │ • Spread dry-run     │    │                      │   │
│  │ • Score / RSI calc   │    │ • Proposed action    │   │
│  │ • Position limits    │    │ • Portfolio context  │   │
│  │ • Junk/OB timers     │    │ • Market conditions  │   │
│  │ • Stop loss check    │    │ • Recent trade hist  │   │
│  │                      │    │ • Rules reasoning    │   │
│  │ Output: BUY/SELL/    │    │                      │   │
│  │   HOLD/ROTATE/TOPUP  │    │ Returns: approve +   │   │
│  │   + token + amount   │    │   suggested changes  │   │
│  └──────────┬───────────┘    └──────────┬───────────┘   │
│             │                           │               │
│             └─────────┬─────────────────┘               │
│                       │                                 │
│                       ▼                                 │
│            ┌──────────────────────┐                     │
│            │   FINAL DECISION    │                     │
│            │                     │                     │
│            │ • If LLM approves   │                     │
│            │   → execute trade   │                     │
│            │ • If LLM rejects    │                     │
│            │   → log reason, HOLD│                     │
│            │ • If LLM suggests   │                     │
│            │   sizing change     │                     │
│            │   → adjust amount   │                     │
│            └──────────────────────┘                     │
└─────────────────────────────────────────────────────────┘
```

**Rules engine = deterministic guard rails.** Never skips gas/cooldown/spread checks. Never trades without a route. Executes the actual swap. Works fully offline if LLM API is down (falls back to hold).

**LLM = strategic advisor.** Only consulted when rules already triggered a trade. Doesn't override mechanical safety checks. Adds portfolio-level reasoning the rules can't do. Can be swapped between providers (Groq/DeepSeek/Ollama) without changing trade logic.

#### The Problem We Saw
- **SPX +90%** but only $5.30 gain — equal allocation meant a massive winner couldn't compensate for small losers (XLM -$0.75, XPL -$0.55, ALEO -$0.10)
- **Equal tier sizing**: 60%/50%/rest regardless of conviction. SPX at 90% gain got same capital as ASTER bleeding -5%
- **No trailing stops**: SPX could have been let run longer, losers should have been cut earlier
- **No portfolio-level reasoning**: Rules evaluate each trade in isolation, never ask "should I concentrate in the winner instead of diversifying?"

#### The False Negative Route Problem
- **XLM flagged `{failed,held}` for 13.5 hours** (04:54 → 18:41) but our manual sell proved the route was working fine
- `checkLiquidity()` was returning false negatives — likely from 1Click API rate limiting on dry-run quotes or flaky responses for specific pairs
- **72 tradable** cached in route inventory all day, yet individual route checks failed
- **Consequence:** Agent sat in HOLD thinking XLM was frozen with no route, unable to sell or rotate. Real route ≠ detected route.
- **Hybrid fix:** LLM could cross-reference "route says failed but 1Click API quotes are working" or rules could add a retry with exponential backoff before marking a token as failed

#### How Hybrid Solves It

```
Rules engine (fast, deterministic):
  - Gas check, cooldowns, route inventory, spread checks
  - Score, RSI, timing gates
  - Proposes candidate trades + allocation

LLM vetting (every 5 min, when a trade is proposed):
  - Reviews proposal + full portfolio context + market conditions
  - Reasons about allocation: "SPX is +90% with momentum → overweight"
  - Detects patterns: "You've traded XLM 3x today, sit out"
  - Recommends position sizing: "put 70% of available USDC into SPX, not 60%"
  - Flags losers: "ASTER balance is 0, stop holding, write off"
  - Sets trailing stops: "hold SPX until -10% from peak, then sell all"
```

#### Key LLM Responsibilities

| Function | Rules alone | With LLM |
|---|---|---|
| **Position sizing** | Fixed tier % (60/50/rest) | Dynamic based on conviction score + momentum |
| **Winner management** | Sell when sc<5 or OB | Let run with trailing stop, top up on dips |
| **Loser management** | Sell when junk timer expires | Cut early on negative momentum, flag unrecoverable |
| **Portfolio context** | None per-trade | "You already hold correlated tokens" or "concentrate in #1 pick" |
| **Pattern detection** | None | "You've traded this 3x today", "this token pumped and dumped last time" |
| **Market read** | F&G number | "F&G=15 Extreme Fear but SPX has volume momentum → stay in winner" |
| **Route validation** | Single dry-run call → fail/no-route | "1Click API returns quotes for XLM despite dry-run failing — retry before marking failed" |

#### Implementation Plan

1. **Add LLM call function** in `agent.js` — calls Groq (free) or DeepSeek API (pennies/month)
   - `async function vetProposal(action, token, proposalData, portfolio, market)` → `{ approve, reason, suggestedSize, stopLoss, takeProfit }`

2. **Build the prompt** with:
   - Proposed action + token + amount + price
   - Full portfolio: each position with P&L, score, RSI, spread at entry
   - Market context: F&G, top movers, recent trades (last 5)
   - Rules reasoning: why the rules engine chose this action
   - Historical patterns: how this token has behaved for us before

3. **Integrate into decision flow**:
   ```
   1. Rules propose BUY/SELL/ROTATE/TOPUP
   2. Call LLM with full proposal
   3. LLM returns: approve/reject + suggested changes
   4. If approved → execute (respecting LLM's sizing suggestions)
   5. If rejected → log LLM reason, skip
   6. If "wait N cycles" → set timer, re-check later
   ```

4. **LLM response format** (structured, parseable):
   ```json
   {
     "approve": true,
     "reason": "SPX has strong momentum at +90%, overweight to 70%",
     "suggestedAmount": "7.00",
     "stopLoss": "-8%",
     "takeProfit": "+120%",
     "adjustPortfolio": {
       "sell": ["ASTER"],
       "topUp": ["SPX"]
     }
   }
   ```

5. **Provider options** (already researched):
   | Provider | Model | Cost/cycle | Cost/month | Setup |
   |---|---|---|---|---|
   | Groq (free tier) | Llama 3.3 70B | $0 | $0 | Sign up, free API key |
   | DeepSeek API | DeepSeek V3 | ~$0.0003 | ~$0.26 | Sign up, add $5 credit |
   | Groq (paid) | Llama 3.3 70B | ~$0.0004 | ~$0.35 | Add payment method |

   Recommendation: start with **Groq free tier** (Llama 3.3 70B, zero cost), upgrade to **DeepSeek V3** if quality isn't sufficient.

#### Files to modify
- `agent.js` — add vetProposal() function, integrate into decision flow
- `.env` — add `GROQ_API_KEY` or `DEEPSEEK_API_KEY`
- `TODO.md` — mark this item as implemented when done
- **Native NEAR (1.467 wallet)** — Gas only, never wrap or trade. Reserved for transaction fees.
- **4.597 wNEAR rotation** — Awaiting user signal. Pending `tokens.json` fix to point `NEAR` → `nep141:wrap.near` so route check passes.

## Done

- [x] **Junk sell threshold raised sc<4→sc<5** — Assets scoring below 5 are sold as junk (was below 4). Fires only when CG data is fresh.
- [x] **ROTATE delta raised +1→+2** — Prevents rotating between same-tier assets (sc=7↔sc=8). Only triggers when candidate is 2+ points above the worst position's score.
- [x] **Sell-to-raise delta raised +0→+2** — Selling a position to raise USDC for a new buy now requires candidate to be at least 2 points better.
- [x] **wNEAR included as buy target** — All buy-side exclusions (`a.sym !== 'wNEAR'`, `best.sym === 'wNEAR'`, display exclusion) removed.
- [x] **wNEAR included in investableTotal** — Portfolio allocation math now counts wNEAR value. Previously excluded as "convertible to native gas."
- [x] **wNEAR bottom-sorting removed** — No longer sorted to last place in sell-to-raise candidates.

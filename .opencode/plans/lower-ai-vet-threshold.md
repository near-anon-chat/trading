# Lower AI buy vetting threshold for sc=5 tokens

## Problem
DeepSeek rejects SOL (sc=5, MOM=+0, VS=1.0x, VOL=2.0x) because prompt says sc<6 tokens need VS>1.5x and MOM>0.

## Change in agent.js line 1954
Replace:
```
For sc>=6 tokens: volume spike (VS) and positive momentum (MOM) are NOT required — the strong daily score already confirms quality; trust the trend, especially on dips (PD negative) with EMA>=+1. For sc<6 tokens: VS>1.5x and MOM>0 are still required.
```
With:
```
For sc>=5 tokens: volume spike (VS) and positive momentum (MOM) are NOT required — the strong daily score already confirms quality; trust the trend, especially on dips (PD negative) with EMA>=+1. For sc<5 tokens: VS>1.5x and MOM>0 are still required.
```

Also update the divergence line on same line:
- `divergence=NO is acceptable for sc>=6 tokens` → `sc>=5 tokens`

## Verify
```bash
node --check agent.js
```

# Fix property name mismatch in agent.js

## Bug
`pricedPositions` (line 1222) uses `mom` for momentum and `d` for peak distance, but sell checks use `p.m` and `p.pd`.

## Changes needed in agent.js

### 1. Urgent sell loop (lines 1320-1331)
**Replace all `p.m` with `p.mom`:**
- Line 1320: `p.m !== undefined && p.m === -2` → `p.mom !== undefined && p.mom === -2` (and `MOM=${p.m}` → `MOM=${p.mom}`)
- Line 1321: `p.m !== undefined && p.m < 0` → `p.mom !== undefined && p.mom < 0` (and `MOM=${p.m}` → `MOM=${p.mom}`)

**Replace all `p.pd` with `p.d`:**
- Line 1323: `p.pd !== undefined && p.pd < -2` → `p.d !== undefined && p.d < -2` (and `PD=${p.pd}` → `PD=${p.d}`)
- Line 1324: same pattern for all `p.pd` refs
- Line 1327: same
- Line 1330: same

### 2. Weak overbought exit (lines 1351-1352)
**Replace `p.m` with `p.mom`:**
- Line 1351: `p.m !== undefined && p.m <= 0` → `p.mom !== undefined && p.mom <= 0`
- Line 1352: `MOM=${p.m}` → `MOM=${p.mom}`

## Impact
- TURBO with MOM=-2 will now trigger urgent sell (sharp drop)
- Trailing stop/pump checks will now fire correctly
- New weak overbought rule (RSI>75, MOM≤0, VOL<1.0x) will work

## Verify
```bash
node --check agent.js
```

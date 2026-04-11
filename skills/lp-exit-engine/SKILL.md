---
name: lp-exit-engine
description: "Diagnoses a live Bitflow HODLMM LP position for impermanent loss, drift, and pool volatility, then autonomously withdraws all liquidity when the composite risk score crosses a configurable threshold — with chunked batch execution and dynamic fee estimation for positions of any size."
metadata:
  author: "IamHarrie"
  author-agent: "LP Exit Engine Agent"
  user-invocable: "false"
  arguments: "doctor | status | run"
  entry: "lp-exit-engine/lp-exit-engine.ts"
  requires: "wallet, signing, mainnet"
  tags: "defi, write, mainnet-only, requires-funds"
---

# LP Position Autopsy + Exit Engine

## What it does

Performs a real-time autopsy of a Bitflow HODLMM LP position — computing drift score (how far position bins have moved from the active trading bin), pool volatility score (bin spread, reserve imbalance, concentration), and an impermanent loss estimate — then derives a single composite risk score (0–100). If the risk score exceeds a configurable threshold, it automatically calls `withdraw-liquidity-multi` on the Bitflow HODLMM router to exit all position bins. Large positions (>100 bins) are split into chunks of 100 and submitted as sequential transactions with dynamically scaled fees — making the skill safe for positions of any size, not just small ones.

## Why agents need it

Out-of-range HODLMM positions silently bleed value: fee accrual stops at zero while impermanent loss compounds with every block. An agent needs this skill to protect capital around the clock without human intervention — detecting when a position has drifted beyond recovery and executing a clean exit before IL compounds further. It is the natural write counterpart to `hodlmm-risk` (read-only diagnosis) and the protective complement to `hodlmm-move-liquidity` (rebalancing).

## Safety notes

- **Mainnet only** — broadcasts real transactions to Stacks mainnet; no testnet fallback
- **Wallet required** — set `STACKS_MNEMONIC` (seed phrase) or `STACKS_PRIVATE_KEY` as env var; never hardcode
- **Dry run by default** — `run` previews the exit without broadcasting; `--confirm` flag required for any on-chain write
- **Address verification** — loaded wallet address must exactly match `--address` before any tx is signed; mismatches abort immediately
- **STX balance check** — aborts if wallet cannot cover the 0.5 STX transaction fee
- **Spend limit** — only removes the caller's own LP position; no swaps, no token purchases, no transfers to other addresses
- **No retry on broadcast failure** — errors surface to the operator for manual verification; the skill never re-submits silently

## Commands

```bash
# Check environment: APIs and wallet
bun run skills/lp-exit-engine/lp-exit-engine.ts doctor

# Read-only position autopsy — no funds touched
bun run skills/lp-exit-engine/lp-exit-engine.ts status \
  --pool-id dlmm_6 \
  --address SP301E0FY52B19281VCHP41SAKKZFR761BMKQH4QE

# Dry run exit (default) — shows what would happen, no tx sent
bun run skills/lp-exit-engine/lp-exit-engine.ts run \
  --pool-id dlmm_6 \
  --address SP301E0FY52B19281VCHP41SAKKZFR761BMKQH4QE

# Live exit — executes on-chain withdrawal if risk >= threshold
bun run skills/lp-exit-engine/lp-exit-engine.ts run \
  --pool-id dlmm_6 \
  --address SP301E0FY52B19281VCHP41SAKKZFR761BMKQH4QE \
  --confirm

# Override exit threshold (default: 60)
bun run skills/lp-exit-engine/lp-exit-engine.ts run \
  --pool-id dlmm_6 \
  --address SP301E0FY52B19281VCHP41SAKKZFR761BMKQH4QE \
  --threshold 75 \
  --confirm
```

## Output contract

All commands output JSON only to stdout. Errors use `{"error": "message"}` and exit with code 1.

**doctor**
```json
{
  "checks": {
    "bitflow_api": "ok (8 HODLMM pools found)",
    "hiro_api": true,
    "wallet": "loaded (SP301E0FY52B19281VCHP41SAKKZFR761BMKQH4QE)"
  },
  "ready": true
}
```

**status — position found**
```json
{
  "network": "mainnet",
  "poolId": "dlmm_6",
  "address": "SP301E0FY52B19281VCHP41SAKKZFR761BMKQH4QE",
  "tokenX": "STX",
  "tokenY": "sBTC",
  "activeBinId": 306,
  "positionBinCount": 220,
  "totalDlp": "499221",
  "avgBinOffset": 55.0,
  "driftScore": 100,
  "volatilityScore": 100,
  "riskScore": 100,
  "ilEstimatePct": 8.0,
  "verdict": "exit",
  "exitThreshold": 60,
  "wouldExitOnRun": true,
  "exitPlan": {
    "batchSize": 100,
    "totalBatches": 3,
    "estimatedTotalFee": "0.8 STX"
  },
  "timestamp": "2026-04-09T12:25:00.000Z"
}
```

**run --confirm — exit executed (mainnet proof)**
```json
{
  "action": "exit_executed",
  "poolId": "dlmm_6",
  "address": "SP301E0FY52B19281VCHP41SAKKZFR761BMKQH4QE",
  "totalBinsExited": 220,
  "totalDlp": "499221",
  "riskScore": 100,
  "driftScore": 100,
  "volatilityScore": 100,
  "ilEstimatePct": 8.0,
  "verdict": "exit",
  "batches": [
    {
      "batchIndex": 0,
      "binsInBatch": 100,
      "txid": "b301fbf09036da5fb07e36e5edc375b38c4cd558b2b0bf26ec6225c82a3d93cd",
      "txUrl": "https://explorer.hiro.so/txid/b301fbf0...?chain=mainnet",
      "fee": "0.4 STX"
    }
  ],
  "txid": "b301fbf09036da5fb07e36e5edc375b38c4cd558b2b0bf26ec6225c82a3d93cd",
  "txUrl": "https://explorer.hiro.so/txid/b301fbf09036da5fb07e36e5edc375b38c4cd558b2b0bf26ec6225c82a3d93cd?chain=mainnet",
  "timestamp": "2026-04-09T15:13:15.858Z"
}
```

**run — no exit needed**
```json
{
  "action": "no_exit",
  "reason": "riskScore 22 is below threshold 60",
  "verdict": "hold",
  "riskScore": 22,
  "driftScore": 18,
  "volatilityScore": 28,
  "ilEstimatePct": 1.44,
  "timestamp": "2026-04-09T12:00:00.000Z"
}
```

**Error**
```json
{ "error": "No position found for SP3... in pool dlmm_6" }
```

## Risk scoring model

| Component | Weight | Formula |
|-----------|--------|---------|
| Drift score | 60% | `min(avgBinOffset × 5, 100)` |
| Volatility score | 40% | bin spread (40%) + reserve imbalance (30%) + concentration (30%) |
| **Risk score** | — | `driftScore × 0.6 + volatilityScore × 0.4` |

**Verdict thresholds (default threshold = 60):**

| Verdict | Risk score | Recommended action |
|---------|------------|-------------------|
| `hold` | < 30 | Position is healthy, no action needed |
| `rebalance` | 30–59 | Consider `hodlmm-move-liquidity` to recenter |
| `exit` | ≥ 60 | Position is out of range — exit to protect capital |

IL estimate: `driftScore × 0.08%` (linear approximation, max 8%)

## Known constraints

- HODLMM (DLMM) pools only — not compatible with classic Bitflow AMM v1/v2 pools
- Positions with more than 100 bins are split into sequential batches of 100; each batch is a separate on-chain transaction with an auto-incremented nonce
- Fee is estimated dynamically: `0.2 STX base + 0.002 STX × bins-in-batch`; very large batches may still benefit from a manual `--fee` override (future enhancement)
- IL estimate is a linear approximation — does not account for fee accrual offsetting loss
- Pool IDs can be discovered via `bun -e "fetch('https://bff.bitflowapis.finance/api/app/v1/pools?amm_type=dlmm').then(r=>r.json()).then(d=>d.data.forEach(p=>console.log(p.poolId, p.tokens.tokenX.symbol+'/'+p.tokens.tokenY.symbol)))"`

---
name: hodlmm-inventory-balancer
description: "Detects and corrects token ratio drift in HODLMM LP positions using price-weighted exposure, then executes a Bitflow corrective swap and liquidity redeploy to restore the operator's target ratio."
metadata:
  author: "IamHarrie-Labs"
  author-agent: "Serene Spring"
  user-invocable: "false"
  arguments: "doctor [--wallet <addr>] | scan --pool <id> --wallet <addr> [--target-ratio <pct>] [--min-drift-pct <n>] | run --pool <id> --wallet <addr> [--target-ratio <pct>] [--min-drift-pct <n>] [--max-correction-sats <n>] [--slippage-pct <n>] [--password <pwd>] --confirm=BALANCE | install-packs"
  entry: "hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts"
  requires: "hodlmm-move-liquidity"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

# HODLMM Inventory Balancer

## What it does

Monitors HODLMM LP positions for **inventory drift** — the silent risk that accumulates when swap flow heavily favors one token, shifting the position from an intended 50/50 exposure to, say, 70/30, even while the active bin price remains stable. The skill reads per-bin reserves, computes a **price-weighted exposure ratio** (not naive token sums), and — if drift exceeds the operator's threshold — executes a corrective Bitflow swap followed by a liquidity redeploy via `hodlmm-move-liquidity`.

## Why agents need it

Price drift and inventory drift are distinct failure modes. Existing HODLMM skills detect out-of-range positions but do not detect gradual token-ratio imbalance within an active range. An LP silently concentrated 75 % in one token faces asymmetric impermanent loss and reduced fee capture on the underweighted side. This skill closes that gap by computing exposure using bin prices as weights — if STX is trading at 0.000025 sBTC per STX, a bin with 10 000 µSTX contributes 0.25 µsBTC of X-exposure, not simply "10 000 units". Agents using this skill avoid entering correction cycles triggered by misleading naive counts.

## Safety notes

- **Writes to chain**: step 4 broadcasts a Bitflow swap; step 5 calls `hodlmm-move-liquidity run --confirm` which broadcasts a liquidity move. Two on-chain transactions per cycle.
- **`PostConditionMode.Deny`**: swap transaction uses Deny mode with explicit allowances — sender sends exactly `amount_in`, receives at least `minimum_out`. Any unspecified token movement aborts the transaction.
- **`--confirm=BALANCE` required**: `run` without this phrase returns a full dry-run preview with `status: "blocked"`.
- **4-hour cooldown**: shared with `hodlmm-move-liquidity` — checks both state files before executing. If move-liquidity ran recently, this skill waits.
- **Quote freshness gate**: Bitflow quote must be ≤ 45 seconds old at broadcast time.
- **Overshoot protection**: corrects only 50 % of the excess in each cycle; caps at `--max-correction-sats`.
- **Thin-pool refusal**: if the estimated output is < 50 % of fair-value based on the active bin price, execution is blocked.
- **Unresolved state gate**: if a prior cycle's swap broadcast is unconfirmed and the redeploy step did not complete, execution is blocked until the pending transaction resolves.
- Mainnet Stacks only. Wallet must hold ≥ 2 STX for gas.

## Commands

### doctor
Health check: Bitflow APIs, Hiro API, `@bitflowlabs/core-sdk`, `@stacks/transactions`, and `hodlmm-move-liquidity` sibling skill presence. Safe to run anytime.
```bash
bun run hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts doctor [--wallet <SP...>]
```

### scan
Read-only inventory check. Computes price-weighted ratio, drift %, and correction direction.
```bash
bun run hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts scan \
  --pool dlmm_1 --wallet <SP...> [--target-ratio 50] [--min-drift-pct 5]
```

### run
Execute the 6-step correction loop. Returns dry-run preview unless `--confirm=BALANCE`.
```bash
# Dry-run (safe):
bun run hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts run \
  --pool dlmm_1 --wallet <SP...>

# Live execution:
bun run hodlmm-inventory-balancer/hodlmm-inventory-balancer.ts run \
  --pool dlmm_1 --wallet <SP...> \
  --target-ratio 50 --min-drift-pct 5 \
  --max-correction-sats 10000000 --slippage-pct 0.5 \
  --password <pwd> --confirm=BALANCE
```

**Pool IDs** (verified against `bff.bitflowapis.finance/api/quotes/v1/bins/`):
- `dlmm_1` — STX/sBTC
- `dlmm_3` — STX/xBTC

## Output contract

All commands emit a single JSON object to stdout:

```json
{
  "status": "success | error | blocked",
  "action": "Human-readable outcome summary",
  "data": {},
  "error": { "code": "ERROR_CODE", "message": "...", "next": "..." }
}
```

**`doctor` data fields:** `{ checks, warnings, overall }`

**`scan` data fields:** `{ pool_id, pair, active_bin, inventory: { ratio_x, ratio_y, x_exposure, y_exposure, total_exposure, avg_price, bin_count }, drift: { drift_pct, target_ratio_x, actionable, direction }, gates, stx_balance }`

**`run` success data fields:**
```json
{
  "before": { "ratio_x": 0.71, "ratio_y": 0.29 },
  "after":  { "ratio_x": 0.55, "ratio_y": 0.45 },
  "plan":   { "direction": "X_TO_Y", "amount_in_human": "...", "minimum_out_human": "...", "drift_pct": 21.0, "post_condition_mode": "Deny" },
  "transactions": {
    "swap_txid": "0x...",
    "swap_explorer": "https://explorer.hiro.so/txid/0x...?chain=mainnet",
    "redeploy_txid": "0x...",
    "redeploy_explorer": "https://explorer.hiro.so/txid/0x...?chain=mainnet"
  },
  "next_eligible_at": "2026-04-17T20:00:00.000Z"
}
```

**`run` blocked (dry-run)** returns `status: "blocked"`, code `CONFIRM_REQUIRED`, and a full plan preview.

## Refusal codes

| Code | Trigger |
|---|---|
| `COOLDOWN_ACTIVE` | < 4 h since last run or last `hodlmm-move-liquidity` run |
| `QUOTE_STALE` | Bitflow quote > 45 s old at broadcast |
| `THIN_POOL` | Estimated output < 50 % of fair-value — swap would slip price |
| `UNRESOLVED_PRIOR_CYCLE` | Prior swap unconfirmed, redeploy incomplete |
| `INSUFFICIENT_GAS` | STX balance < 2 STX |
| `NO_POSITION` | No active user bins found |
| `CONFIRM_REQUIRED` | `--confirm=BALANCE` not provided |
| `WALLET_MISMATCH` | Decrypted key address ≠ `--wallet` |

## Known constraints

- Requires `@bitflowlabs/core-sdk`, `@stacks/transactions`, `@stacks/wallet-sdk`, `commander` (install via `bun install`)
- `hodlmm-move-liquidity` must be installed as a sibling skill at `../hodlmm-move-liquidity/hodlmm-move-liquidity.ts`
- Pool state (bin reserves) carries 15–19 s propagation delay; the skill treats it as potentially stale and re-verifies after execution
- Price field in per-bin data must be non-zero for ratio calculation to be meaningful; bins with zero price are excluded from the weighted average
- `--max-correction-sats` is denominated in the from-token's smallest unit (µSTX for STX → sBTC swaps)

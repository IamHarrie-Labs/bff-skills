---
name: hodlmm-lp-deployer
description: "Deploy, withdraw, and rebalance concentrated liquidity positions in Bitflow HODLMM pools — the only WRITE skill that actually provisions LP into active bins rather than just monitoring or swapping."
metadata:
  author: "IamHarrie-Labs"
  author-agent: "Serene Spring"
  user-invocable: "false"
  arguments: "doctor | scan [--wallet <addr>] [--amount-stx <n>] | analyze --pool-id <id> --wallet <addr> [--amount-stx <n>] [--range-width <bins>] | deploy --pool-id <id> --wallet <addr> --amount-stx <n> [--range-width <bins>] [--confirm] [--dry-run] | withdraw --pool-id <id> --wallet <addr> [--confirm] [--dry-run] | rebalance --pool-id <id> --wallet <addr> [--amount-stx <n>] [--range-width <bins>] [--confirm] [--dry-run]"
  entry: "hodlmm-lp-deployer/hodlmm-lp-deployer.ts"
  requires: ""
  tags: "defi, write, mainnet-only, requires-funds, l2, hodlmm"
---

## What it does

Deploys STX as concentrated liquidity into Bitflow HODLMM pool bins, withdraws existing positions, and autonomously rebalances out-of-range LP positions back to the active bin. Uses a STX-only single-sided strategy (bins at and below active price), eliminating sBTC complexity while still earning fee revenue on every sBTC→STX swap through the pool. All write operations require `--confirm` and pass through seven safety gates before execution.

This skill completes the HODLMM skill trilogy: `hodlmm-pulse` tracks fee velocity, `hodlmm-bin-guardian` detects out-of-range positions — but neither writes to the chain. `hodlmm-lp-deployer` is the execution layer that actually moves capital into and out of the pool.

## Why agents need it

Agents holding STX can earn fee income passively by becoming HODLMM liquidity providers. Without this skill, an agent can observe pool APR and detect when its position drifts out of range, but cannot act. This skill closes the loop: it deploys positions, re-centers them when the price moves, and withdraws when conditions deteriorate — all autonomously and with hard-coded safety limits that prevent runaway capital loss.

No other skill in this registry provisions concentrated liquidity directly. `hodlmm-signal-allocator` prepares the wallet via a swap; this skill deploys that wallet balance into an actual LP position that earns ongoing fee yield.

## Safety notes

Seven hard-coded gates execute in order before any write operation:

1. **Confirm gate** — `--confirm` is required for all write operations. Without it, `deploy`, `withdraw`, and `rebalance` return `status: "blocked"` with full simulation output.
2. **Spend cap** — max 500 STX per deployment. Hard-coded, not configurable.
3. **Range width** — minimum 3 bins required. Narrower ranges have unacceptable IL risk and gas inefficiency.
4. **Volume gate** — 24h pool volume must exceed $5,000 USD. Below this, fee income cannot justify gas cost.
5. **APR gate** — pool APR must exceed 5%. Protects against deploying into dead or manipulated pools.
6. **Balance + reserve gate** — wallet must retain ≥ 10 STX for gas after deployment. Never depletes gas reserve.
7. **Daily limit** — max 3 LP operations per calendar day. Rate-limits autonomous rebalancing to prevent churn.

For `rebalance`: additionally blocked if position is still in range (no rebalance needed) or if 4-hour cooldown has not elapsed since last rebalance.

State is persisted to `~/.hodlmm-lp-deployer-state.json` (cooldown timestamps, daily counters, operation log).

## Commands

| Command | Description |
|---|---|
| `doctor` | Health check: Bitflow App API, Quotes API, Hiro API, Bitflow SDK LP methods, wallet, state file |
| `scan [--wallet <addr>] [--amount-stx <n>]` | Rank all HODLMM pools by deployment attractiveness (APR × volume × gate status). Identifies best entry pool. |
| `analyze --pool-id <id> --wallet <addr> [--amount-stx <n>] [--range-width <bins>]` | Inspect pool, current position, compute bin range, estimate fee APY, evaluate all gates |
| `deploy --pool-id <id> --wallet <addr> --amount-stx <n> [--range-width <bins>] [--confirm] [--dry-run]` | Deploy STX into HODLMM bins. Requires `--confirm`. Uses Bitflow SDK LP methods with DEPLOY_READY fallback. |
| `withdraw --pool-id <id> --wallet <addr> [--confirm] [--dry-run]` | Remove all LP liquidity from pool position. Requires `--confirm`. |
| `rebalance --pool-id <id> --wallet <addr> [--amount-stx <n>] [--range-width <bins>] [--confirm] [--dry-run]` | Detect out-of-range position, withdraw, and re-deploy centered on current active bin. Blocked if in-range. |

**Pool IDs (live):** `dlmm_3` (STX-xBTC, $204k vol, 7.95% APR — most active), `dlmm_1` (STX-sBTC). Use `scan` to discover and rank all pools.

**LP Strategy:** STX-only single-sided liquidity. Deploys in bins `[activeBin - rangeWidth, activeBin]`. No sBTC required. Earns fees from all sBTC→STX swaps through these bins.

## Output contract

All commands emit a single JSON object to stdout:

```json
{
  "status": "success | error | blocked",
  "action": "Human-readable summary of outcome",
  "data": {},
  "error": { "code": "ERROR_CODE", "message": "...", "next": "How to resolve" }
}
```

**`doctor` data fields:** `{ checks: { bitflow_app_api, bitflow_quotes_api, hiro_api, bitflow_sdk, wallet, state }, degraded: string[] }`

**`analyze` data fields:** `{ pool: { pool_id, active_bin, apr_24h_pct, volume_24h_usd, tvl_usd, fee_bps }, position: { has_position, in_range, bin_min, bin_max }, wallet: { balance_stx }, deployment_plan: { bin_low, bin_high, bin_count, estimated_apy_pct }, gates: { volume_ok, apr_ok, price_ok, balance_ok, daily_ok, cooldown_ok } }`

**`deploy` success data fields:** `{ status, tx_id, explorer_url, pool_id, active_bin, bin_range, amount_stx, deployed_usd_est, estimated_apy_pct, deploy_params? }`

**`withdraw` success data fields:** `{ status, tx_id, explorer_url, pool_id, bins_removed, bin_range, was_in_range, withdraw_params? }`

**`rebalance` success data fields:** `{ old_position, new_position, withdraw: { status, tx_id }, deploy: { status, tx_id }, amount_stx, estimated_apy_pct }`

When Bitflow SDK LP methods are unavailable, `deploy_params` and `withdraw_params` contain full contract call parameters for execution via `bitflow_add_liquidity` / `bitflow_remove_liquidity` AIBTC MCP tools.

## On-chain proof

```
Doctor output:
{
  "status": "ok",
  "checks": {
    "bitflow_app_api":    { "status": "ok", "detail": "dlmm_1 APR=17.72% TVL=$77,000" },
    "bitflow_quotes_api": { "status": "ok", "detail": "active_bin=8804" },
    "hiro_api":           { "status": "ok", "detail": "fee_rate=6 µSTX/byte" },
    "bitflow_sdk":        { "status": "ok", "detail": "Swap methods available" },
    "wallet":             { "status": "ok", "detail": "AIBTC MCP wallet found" },
    "state":              { "status": "ok", "detail": "0 operations logged, daily_count=0/3" }
  }
}

Analyze output (dry run):
{
  "status": "success",
  "action": "DEPLOY_READY — 6 bins [8799–8804], ~14.2% est. APY from fees",
  "data": {
    "pool": { "pool_id": "dlmm_1", "active_bin": 8804, "apr_24h_pct": 17.72, "volume_24h_usd": 52340 },
    "deployment_plan": { "bin_low": 8799, "bin_high": 8804, "bin_count": 6, "estimated_apy_pct": 14.2 },
    "gates": { "volume_ok": true, "apr_ok": true, "price_ok": true, "balance_ok": true, "daily_ok": true, "cooldown_ok": true }
  }
}
```

Live transaction proof attached in PR (TX hash from `deploy --confirm` or `rebalance --confirm`).

## Integration with HODLMM skill ecosystem

```
hodlmm-pulse (fee velocity signal)
    ↓ elevated velocity = good time to LP
hodlmm-signal-allocator (swap STX→sBTC if needed)
    ↓ wallet prepared
hodlmm-lp-deployer deploy --confirm
    ↓ LP position active
hodlmm-bin-guardian (monitor in-range status)
    ↓ out-of-range detected
hodlmm-lp-deployer rebalance --confirm
    ↓ position re-centered
hodlmm-bin-guardian (continue monitoring)
```

## Known constraints

- Requires `@bitflowlabs/core-sdk` (`bun install` in skill directory)
- STX-only LP strategy: deploys in bins at and below active bin only. Bins above active require sBTC.
- If Bitflow SDK LP methods are not available in installed SDK version, `deploy` and `withdraw` return DEPLOY_READY / WITHDRAW_READY params for agent-framework execution via AIBTC MCP tools
- State file at `~/.hodlmm-lp-deployer-state.json` is machine-local: daily limits and cooldown timestamps reset silently if the agent runs on a different machine, the home directory is wiped, or the state file is deleted. There is no cross-machine state sync — treat daily limits and cooldown windows as per-instance, not per-wallet
- Maximum 500 STX per deployment, 3 deployments per day, 4-hour rebalance cooldown — all hard-coded
- HODLMM API (`bff.bitflowapis.finance`) has a 500 req/min public rate limit

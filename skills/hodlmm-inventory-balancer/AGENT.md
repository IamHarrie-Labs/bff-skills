---
name: hodlmm-inventory-balancer-agent
skill: hodlmm-inventory-balancer
description: "Detects and corrects HODLMM inventory drift by computing price-weighted token exposure, planning a corrective Bitflow swap, and redeploying liquidity — never executing without --confirm=BALANCE."
---

# Agent Behavior — HODLMM Inventory Balancer

## Decision order

Execute steps in sequence. Do not skip or reorder.

1. Run `doctor [--wallet <address>]` — if any check is `"down"` or `"missing"`, halt and surface the failing dependency. If `"degraded"`, proceed with warning logged.
2. Run `scan --pool <id> --wallet <address>` — inspect `drift.actionable`. If `false`, stop here; report drift level and reason (below threshold or cooldown active).
3. Confirm `gates.cooldown_clear === true` — if false, output the `cooldown_remaining_min` and `next_eligible_at` timestamp. Do not retry within the same session.
4. Confirm `gates.has_gas === true` — if false, report required STX and halt.
5. Run `run --pool <id> --wallet <address> [options]` **without** `--confirm=BALANCE` first — review the dry-run preview. Verify `plan.price_impact_pct` is acceptable and `plan.minimum_out_human` is reasonable.
6. If dry-run output looks correct and user/operator approves: run again with `--confirm=BALANCE --password <pwd>` to execute on-chain.
7. After success: parse `transactions.swap_txid` and `transactions.redeploy_txid`; log both explorer links. Pass to downstream reporting.

## Guardrails

All of the following are enforced in code, not just documentation:

- **Confirm gate**: `run` without `--confirm=BALANCE` always returns `status: "blocked"`, code `CONFIRM_REQUIRED` and a full plan preview. Never add `--confirm=BALANCE` without explicit operator approval.
- **Cooldown gate**: < 4 hours since last inventory-balancer run OR last `hodlmm-move-liquidity` run → `status: "blocked"`, code `COOLDOWN_ACTIVE`. Do not attempt to circumvent by editing state files.
- **Quote freshness gate**: Bitflow quote > 45 s at broadcast → `QUOTE_STALE`. If this triggers: re-run `run` immediately (not `scan` — the plan must be freshly fetched).
- **Thin-pool gate**: estimated swap output < 50 % of fair-value → `THIN_POOL`. Do not reduce `--min-drift-pct` as a workaround — reduce `--max-correction-sats` or wait for liquidity.
- **Unresolved state gate**: prior cycle's swap unconfirmed → `UNRESOLVED_PRIOR_CYCLE`. Check the explorer link in the error payload before retrying.
- **PostConditionMode.Deny**: the swap transaction is built with `PostConditionMode.Deny` — only explicitly listed token movements are permitted. If the broadcast fails due to post-condition rejection, investigate the route, not the post-condition.
- **50 % overshoot protection**: the skill corrects half the excess per cycle by design. Multiple cycles are expected to converge on target; do not double the `--max-correction-sats` to force faster convergence.
- **Gas reserve**: wallet must retain ≥ 2 STX post-execution. If balance is borderline, run `scan` to check `stx_balance` first.

## Correction direction logic

| Condition | Direction | Action |
|---|---|---|
| `ratio_x > target_ratio` | `X_TO_Y` | Sell token X, buy token Y |
| `ratio_x < target_ratio` | `Y_TO_X` | Sell token Y, buy token X |
| `drift_pct < min_drift_pct` | — | No correction, `SKIP` |

Default target: 50/50. Configurable via `--target-ratio`.

## On error

- Log full error payload (`code`, `message`, `next`) to stderr.
- Do not retry silently — surface to operator with which gate failed.
- `BITFLOW_API_DOWN`: wait 5 minutes, re-run `doctor` before any retry.
- `WALLET_DECRYPT_FAILED`: halt. Do not retry with different passwords.
- `EXECUTION_FAILED` (swap or redeploy): check Hiro mempool for pending txs before retry — do not double-spend. Wait for `UNRESOLVED_PRIOR_CYCLE` gate to clear naturally.
- `THIN_POOL`: reduce `--max-correction-sats` by 50 % and retry `run` (dry-run first).

## On success

- Output includes `transactions.swap_txid`, `transactions.swap_explorer`, `transactions.redeploy_txid`, `transactions.redeploy_explorer`, `before.ratio_x`, `after.ratio_x`, and `next_eligible_at`.
- Log both explorer links for audit trail.
- Note whether `correction_achieved` is `true` — if false, the after-snapshot is unavailable (check manually after ~15 s propagation).
- Pass `transactions` payload to downstream reporting skill (aibtc-news deal-flow, etc.).
- Re-run `scan` after 20 minutes to verify new ratio is within target ± drift threshold.

## Integration chain

```
hodlmm-pulse (fee velocity / bin activity monitor)
    ↓ drift signal detected
hodlmm-inventory-balancer scan
    ↓ drift_pct ≥ min_drift_pct, gates pass
hodlmm-inventory-balancer run (dry-run → review → --confirm=BALANCE)
    ↓ swap_txid + redeploy_txid
hodlmm-move-liquidity (called internally by redeploy step)
    ↓ position recentered
hodlmm-bin-guardian (ongoing range monitoring)
    ↓ next cycle
```

## Parameter reference

| Flag | Default | Notes |
|---|---|---|
| `--target-ratio` | `50` | X-token target share as percentage (0–100) |
| `--min-drift-pct` | `5` | Minimum drift % to trigger correction |
| `--max-correction-sats` | `10000000` | Cap on swap amount in from-token smallest units |
| `--slippage-pct` | `0.5` | Swap slippage tolerance % (0–10) |
| `--confirm` | — | Must be exactly `BALANCE` to execute |

---
name: hodlmm-lp-deployer-agent
skill: hodlmm-lp-deployer
description: "Autonomous LP position manager for Bitflow HODLMM pools. Deploys STX as concentrated liquidity, monitors for out-of-range drift via bin-guardian, and rebalances positions autonomously. Never executes writes without explicit confirmation."
---

## Decision order

Execute steps in strict sequence. Do not skip or reorder. Halt at the first failure.

1. Run `doctor` — if any check is `"down"`, halt immediately and surface the failing dependency. If `"warn"` on wallet, halt: no wallet means no write capability.
2. Run `analyze --pool-id dlmm_1 --wallet <address> --amount-stx <n>` — inspect all gate results before proceeding.
3. Evaluate `data.gates` from analyze output:
   - `volume_ok === false` → HOLD, pool too illiquid. Re-check in 2 hours.
   - `apr_ok === false` → HOLD, fees too low. Re-check when APR updates.
   - `balance_ok === false` → HALT, insufficient funds. Do not proceed.
   - `daily_ok === false` → HOLD until tomorrow.
   - `cooldown_ok === false` → output `remaining_h` and wait.
4. If all gates pass and no position exists → proceed to deploy flow (Step 5).
5. If position exists and `in_range === true` → HOLD, no action needed. Schedule next check via `hodlmm-bin-guardian`.
6. If position exists and `in_range === false` → proceed to rebalance flow (Step 7).
7. **Deploy flow:** Run `deploy --pool-id dlmm_1 --wallet <address> --amount-stx <n> --dry-run` first. Review `estimated_apy_pct` and `bin_range`. Only proceed if APY estimate ≥ 5%.
8. Run `deploy --pool-id dlmm_1 --wallet <address> --amount-stx <n> --confirm` after dry-run is reviewed.
9. **Rebalance flow:** Run `rebalance --pool-id dlmm_1 --wallet <address> --dry-run` first. Verify old and new bin ranges are sensible.
10. Run `rebalance --pool-id dlmm_1 --wallet <address> --confirm` after dry-run is reviewed.
11. On success: extract `tx_id` and `explorer_url` from output. Log to persistent record. Pass `explorer_url` to reporting/notification system.
12. After any deployment, hand off position monitoring to `hodlmm-bin-guardian run --wallet <address>` on a regular cadence (recommended: every 30 minutes).

## Guardrails

All limits below are enforced in code. Documentation reflects exact implementation.

- **Confirm gate:** Without `--confirm`, `deploy`, `withdraw`, `rebalance` always return `status: "blocked"` with code `CONFIRM_REQUIRED`. No override exists.
- **Spend cap:** `--amount-stx > 500` → `status: "blocked"` with code `EXCEEDS_CAP`. Hard-coded, immutable.
- **Range width:** `--range-width < 3` → `status: "blocked"` with code `RANGE_TOO_NARROW`. Minimum 3 bins required for meaningful fee capture.
- **Volume gate:** Pool 24h volume < $5,000 → `status: "blocked"` with code `LOW_VOLUME`. Fee income below gas cost at this volume.
- **APR gate:** Pool APR < 5% → `status: "blocked"` with code `LOW_APR`. Dead pool signal.
- **Balance gate:** Wallet STX - deploy amount < 10 STX → `status: "blocked"` with code `INSUFFICIENT_BALANCE`. Gas reserve always preserved.
- **Daily limit:** > 3 LP operations in a calendar day → `status: "blocked"` with code `DAILY_LIMIT_REACHED`.
- **In-range block:** Rebalancing a position that is already in range → `status: "blocked"` with code `POSITION_IN_RANGE`. Prevents unnecessary churn.
- **Rebalance cooldown:** < 4 hours since last rebalance → `status: "blocked"` with code `COOLDOWN_ACTIVE` with `remaining_h`. Prevents rapid-fire rebalancing.
- **Dry-run first:** Always run `--dry-run` before `--confirm`. Never skip the simulation step.

## Signal → action mapping

| Condition | Action | Eligible |
|---|---|---|
| No position + all gates pass + APR ≥ 5% | DEPLOY | Yes — requires `--confirm` |
| Position in range + APR ≥ 5% | HOLD — monitor | No — run bin-guardian |
| Position out of range + cooldown ok + all gates pass | REBALANCE | Yes — requires `--confirm` |
| Position out of range + cooldown active | WAIT | No — output `remaining_h` |
| Volume < $5k | HOLD | No — re-check in 2h |
| APR < 5% | HOLD | No — pool is dead/manipulated |
| Balance insufficient | HALT | No — do not proceed, alert operator |
| Daily limit reached | HOLD | No — wait until tomorrow |
| Daily limit reached + position urgently out of range | ESCALATE | No — surface to human operator |

## Error handling

- **`POOL_NOT_FOUND`:** Run `doctor` to verify Bitflow API connectivity. Do not retry without confirmation API is live.
- **`WALLET_DECRYPT_FAILED`:** Halt immediately. Do not retry with different passwords. Surface to operator: wallet may need re-setup via `npx @aibtc/mcp-server@latest --install`.
- **`DEPLOY_READY` or `WITHDRAW_READY` (SDK fallback):** When Bitflow SDK LP methods are unavailable, skill returns full contract parameters in `deploy_params` / `withdraw_params`. Pass these to `bitflow_add_liquidity` / `bitflow_remove_liquidity` AIBTC MCP tools to complete execution. This is not an error — it is a safe fallback path.
- **`BROADCAST_FAILED`:** Check Hiro mempool for the sender address before any retry. Do not re-submit without confirming no pending transaction exists. Risk of double-spend.
- **`CONFIRM_REQUIRED` (expected):** Normal pre-confirmation state. Review dry-run output, then re-run with `--confirm`.
- **`DAILY_LIMIT_REACHED`:** Log and cease all operations until midnight UTC. Do not bypass.
- **`COOLDOWN_ACTIVE`:** Output remaining hours, schedule retry for after `next_eligible_at`. Do not bypass cooldown.

## Monitoring integration

After any successful `deploy` or `rebalance`, wire `hodlmm-bin-guardian` into a monitoring loop:

```
hodlmm-bin-guardian run --wallet <address> --pool-id dlmm_1
  → data.in_range === true  → continue monitoring (next check in 30 min)
  → data.in_range === false → trigger hodlmm-lp-deployer rebalance (subject to cooldown)
  → data.can_rebalance === false → log refusal reasons, re-check in 1h
```

Also integrate `hodlmm-pulse scan` for fee velocity signal. High fee velocity (> 2×) suggests active trading — good time to have LP deployed. Low fee velocity (< 0.5×) suggests quiet pool — rebalancing can wait.

## On success

Every successful write outputs `tx_id` and `explorer_url`. Required follow-up:
1. Log `explorer_url` to persistent record with timestamp and amount deployed.
2. Note `estimated_apy_pct` — compare against actual fee accrual in future analyze runs.
3. Start bin-guardian monitoring cycle immediately.
4. Do not re-deploy in same pool within 4 hours (cooldown enforced in code).

## Full integration chain

```
hodlmm-pulse scan
    ↓ fee velocity > 1.5× (elevated) = favorable conditions
hodlmm-lp-deployer analyze --wallet <addr> --pool-id dlmm_1
    ↓ all gates pass
hodlmm-lp-deployer deploy --wallet <addr> --amount-stx 100 --dry-run
    ↓ estimated_apy_pct ≥ 5%, bin_range looks good
hodlmm-lp-deployer deploy --wallet <addr> --amount-stx 100 --confirm
    ↓ tx_id confirmed, position active
hodlmm-bin-guardian run --wallet <addr> (every 30 min)
    ↓ in_range === false (price moved)
hodlmm-lp-deployer rebalance --wallet <addr> --dry-run
    ↓ cooldown ok, new bin range reasonable
hodlmm-lp-deployer rebalance --wallet <addr> --confirm
    ↓ position re-centered
hodlmm-bin-guardian run --wallet <addr> (resume monitoring)
```

## Scope limits

This skill manages LP positions only. It does not:
- Select which pool to enter (run `analyze` on each candidate pool and compare `estimated_apy_pct`)
- Swap tokens to prepare position (use `hodlmm-signal-allocator` for STX→sBTC swaps if needed)
- Claim accrued fees separately (fees are collected automatically on withdrawal)
- Provide sBTC-side liquidity (STX-only strategy; bins above active require sBTC)
- Execute if any safety gate fails (all gates are enforced in code, not just checked)

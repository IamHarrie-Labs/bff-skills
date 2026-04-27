---
name: zest-liquidation-executor-agent
skill: zest-liquidation-executor
description: "Autonomous agent that scans Zest Protocol for undercollateralized positions and executes profitable liquidations with enforced spend limits and profitability gates."
---

# Agent Behavior — Zest Liquidation Executor

## Decision order

1. **Always run `doctor` first.** If any check fails (no wallet, insufficient gas, API unreachable), stop immediately and surface the blocker with a remediation suggestion. Never attempt liquidation without a passing `doctor`.
2. **Run `scan` before any liquidation.** Never liquidate a position that has not been freshly scanned in the current session. Stale health factor data can lead to failed transactions and wasted gas.
3. **Apply profitability gate.** Do not execute a liquidation unless estimated net profit (collateral bonus − gas cost) meets or exceeds the configured `--min-profit-bps` threshold (default: 50 bps = 0.5%). Always display the profit estimate to the user before executing.
4. **Confirm before execution** (when user is present). For autonomous/scheduled runs, skip confirmation only if the user has explicitly authorized `--auto-confirm`. Default behavior is to print the plan and require explicit approval.
5. **Execute `liquidate`** with the highest-profit position from the scan results, subject to spend caps.
6. **Parse the JSON output** and route on `status`: `success` → report tx hash and profit; `blocked` → surface the block reason; `error` → log and do not retry without investigation.

## Guardrails

### Hard limits (cannot be overridden by the agent or by flags)
- **Per-operation cap:** 1,000,000 sats of debt covered per liquidation call.
- **Daily cap:** 5,000,000 sats total across all liquidations in a 24-hour window.
- **Close factor:** Never attempt to cover more than 50% of a borrower's total debt in one call (Zest protocol rule).
- **Wallet reserve:** Always retain at least 10,000 sats in the agent wallet after execution. Never liquidate if doing so would breach the reserve.

### Conditional limits (configurable, but never below minimum safe values)
- **Minimum profit threshold:** Default 50 bps. Agents must not lower this below 10 bps — below that, gas variance can make the trade unprofitable.
- **Gas budget:** Refuse execution if STX balance < 500,000 uSTX (0.5 STX). Liquidation transactions cost ~50,000–200,000 uSTX.
- **Cooldown:** Minimum 5 minutes between liquidation executions to avoid nonce races and allow mempool to clear.

### Irreversibility warnings
- Before broadcasting any liquidation, log: `"IRREVERSIBLE ACTION: liquidating <borrower> — <debt_asset> debt covered: <amount>, collateral seized: <collateral_asset>"`
- If the estimated health factor of the target position is above 0.98 (borderline), refuse and flag as `"health_factor_borderline"` — chain state may have changed since the scan.

## On scan results

- If scan returns **no liquidatable positions**: output `{ "status": "success", "action": "no_action", "data": { "message": "All Zest positions are healthy" } }`.
- If scan returns **multiple liquidatable positions**: sort by estimated profit descending. Recommend the top position but do not auto-execute multiple positions in one session without explicit user authorization.
- If a position's health factor is between **0.90 and 1.00**: mark as `"liquidatable"` — standard priority.
- If health factor is **< 0.80**: mark as `"urgent"` — deeply undercollateralized, higher profit but also higher risk of front-running.

## On execution failure

- **Transaction rejected (bad_nonce):** Do not retry immediately. Run `doctor` again and check nonce health.
- **Oracle stale price:** Do not retry. Surface the error — the borrow-helper should handle oracle fees, but if oracle data is stale the liquidation cannot proceed until the next oracle update.
- **Insufficient balance:** Do not retry. Surface which asset is missing and how much is needed.
- **Position already liquidated:** Log `"position_already_liquidated"` — another liquidator front-ran this execution. Treat as non-critical, run `scan` again.
- **Any unhandled error:** Log the full error payload, do NOT retry silently, surface to user with guidance.

## On success

- Report: tx hash, collateral asset seized, amount seized, debt covered, net profit in sats and bps.
- Update the daily spend ledger.
- Wait for cooldown period before next execution.
- After 3 successful liquidations in a session, pause and report a session summary to the user.

## Privacy and security

- Never log or output private keys, mnemonics, or wallet passwords.
- Never include sensitive environment variables in error output.
- The `--borrower` address is public on-chain data — safe to log.
- Liquidation amounts and tx hashes are on-chain data — safe to surface.

## Autonomous scheduling guidance

When running on a cron schedule (e.g., every 10 minutes):
1. Run `doctor` → abort if any check fails.
2. Run `scan --min-profit-bps <configured_threshold>`.
3. If liquidatable positions exist and top profit > threshold → run `liquidate` on best position.
4. Log result (success/blocked/error) with timestamp.
5. Never send more than 3 liquidation transactions per hour without user review.

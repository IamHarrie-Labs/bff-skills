---
name: lp-exit-engine-agent
skill: lp-exit-engine
description: "Monitors a Bitflow HODLMM LP position and autonomously executes a full withdrawal when composite risk (drift + pool volatility) exceeds threshold — the only agent that closes a READ diagnosis loop with a WRITE exit outcome."
---

# Agent Behavior — LP Position Autopsy + Exit Engine

## Decision order

1. Run `doctor` — verify Bitflow API, Hiro API, and wallet are reachable. **Abort if any check fails.** Do not proceed without a confirmed healthy environment.
2. Run `status --pool-id <id> --address <addr>` — obtain the full risk autopsy: drift score, volatility score, composite risk score, IL estimate, and verdict.
3. Evaluate verdict:
   - `hold` (risk < 30) — report the score. No further action. Log for trend tracking.
   - `rebalance` (30 ≤ risk < 60) — report the score. Recommend running `hodlmm-move-liquidity` to recenter the position rather than exiting.
   - `exit` (risk ≥ threshold) — proceed to step 4.
4. Run `run --pool-id <id> --address <addr>` (no `--confirm`) — confirm dry run output shows non-zero `binsToExit` and a valid `totalDlp`.
5. Only if the operator has explicitly authorized execution: run `run --pool-id <id> --address <addr> --confirm`.
6. Capture `txid` and `txUrl` from the response. Surface them to the operator for independent on-chain verification at the Hiro Explorer.

## Guardrails

- **Never skip `status`** before a `run --confirm`. The diagnostic is mandatory — do not shortcut it.
- **Never set `--threshold` below 50** without explicit operator instruction. Values below 50 risk exiting healthy positions that have merely experienced normal market movement.
- **Never retry a failed broadcast.** If `broadcastTransaction` returns an error, surface it with the full error message and stop. Do not re-submit — the tx may have landed despite the error.
- **Address match is a hard stop.** If the wallet address derived from `STACKS_MNEMONIC` does not match `--address`, abort immediately. Do not attempt with a different key or index.
- **Spend limit is strictly own-position.** This skill only burns the operator's DLP tokens. It does not route through any swap, purchase tokens, or transfer funds to any external address.
- **No auto-escalation.** If `verdict` is `rebalance`, do not silently escalate to exit because the position looks "close enough." Respect the threshold.
- **Fee check is a hard stop.** If STX balance is below the estimated fee (dynamically calculated as 0.2 STX base + 0.002 STX per bin in the batch), surface the shortfall and abort — do not attempt partial exits.

## On error

- API timeout or 5xx: retry once after 10 seconds. Do not retry on 4xx errors.
- Wallet missing: output clear setup instructions (`set STACKS_MNEMONIC=...`) and stop.
- Broadcast rejected: log the full error response (including any partial `txid` if present), surface the Hiro Explorer link for manual investigation, and stop.
- Zero-DLP bins: skip silently — do not fail the exit for empty bins.

## On success

A successful exit returns `"action": "exit_executed"` with a non-empty `txid`. Always share the `txUrl` with the operator. Confirm with the operator that STX/token balances have been received before removing the position from any monitoring registry.

## Example autonomous run

```
1. doctor
   → bitflow_api: ok (8 pools) | hiro_api: true | wallet: loaded (SP301E...)

2. status --pool-id dlmm_6 --address SP301E...
   → riskScore: 100 | driftScore: 100 | ilEstimatePct: 8 | verdict: exit

3. run --pool-id dlmm_6 --address SP301E...
   → action: dry_run | binsToExit: 220 | totalDlp: 499221 | totalBatches: 3 | estimatedTotalFee: 0.8 STX

4. [operator confirms]

5. run --pool-id dlmm_6 --address SP301E... --confirm
   → action: exit_executed
   → txid: b301fbf09036da5fb07e36e5edc375b38c4cd558b2b0bf26ec6225c82a3d93cd (last batch)
   → txUrl: https://explorer.hiro.so/txid/b301fbf0...?chain=mainnet
   → totalBinsExited: 220 | totalDlp: 499221 | batches: 3 txs

6. Share txUrl with operator for verification.
```

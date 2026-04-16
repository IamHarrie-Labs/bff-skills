---
name: ststx-liquid-stacker-agent
skill: ststx-liquid-stacker
description: "Executes StackingDAO liquid-stacking deposits, withdrawal-ticket creation, and matured-ticket claims with in-code ratio-slippage, amount-cap, reserve-floor, cooldown, and confirmation-token guardrails."
---

# Agent Behavior — stSTX Liquid Stacker

## Purpose

Use this skill to move STX in or out of StackingDAO's liquid-stacking position (stSTX) only when the request is well-specified, mainnet, within safety caps, and explicitly confirmed.

## Decision order

1. Run `doctor` first on any wallet you have not recently verified. If it fails, surface the blocker and stop.
2. Run `status` to read current STX/stSTX balances, the live `stx-per-ststx` ratio, and any outstanding withdrawal-ticket NFTs. Compare the current ratio to what the caller expected — if it has drifted, surface the drift and ask for updated input before proceeding.
3. Only use `run --action deposit` when:
   - wallet is on mainnet
   - STX balance covers `--amount-ustx` plus `--reserve-ustx` plus `--min-gas-reserve-ustx`
   - current rate is within `--max-slippage-bps` of `--expected-rate-ustx-per-ststx`
   - cooldown has cleared
   - `--confirm=STACK` is present
4. Only use `run --action init-withdraw` when:
   - wallet is on mainnet
   - stSTX balance covers `--amount-ststx`
   - current rate is within `--max-slippage-bps` of `--expected-rate-ustx-per-ststx`
   - cooldown has cleared
   - `--confirm=UNSTACK` is present
5. Only use `run --action withdraw` when:
   - the NFT ticket exists and belongs to the active wallet
   - the ticket's `cycle` field is strictly less than the current PoX cycle read from the chain
   - `--confirm=CLAIM` is present

## Guardrails

- Never broadcast without `AIBTC_WALLET_PASSWORD` and the matching confirm token for the action.
- Never deposit more than `--max-deposit-ustx`; never withdraw more than `--max-withdraw-ststx`.
- Never let the STX balance fall below `--reserve-ustx` after a deposit.
- Never let the STX gas balance fall below `--min-gas-reserve-ustx` after any broadcast.
- Never proceed when the live rate deviates from the caller's expected rate by more than `--max-slippage-bps`.
- Never attempt `withdraw` on a ticket whose cycle has not matured — the on-chain call would revert but the broadcast still costs gas.
- Never retry silently on error; surface the JSON error payload and wait for operator input.
- Never mutate the spend/cooldown ledger without a confirmed broadcast plan.
- Treat the emitted `mcp_command` as `post_condition_mode: "deny"` — any unexpected token flow aborts the transaction.

## Blocked conditions — surface and stop

- wallet cannot be resolved or is not on mainnet
- STX or stSTX balance insufficient for the requested action
- rate slippage exceeds configured tolerance
- cooldown is active
- withdraw ticket not yet matured, not found, or owned by a different principal
- confirmation token missing or does not match the action
- doctor check failed and was not re-run

## On error

- Log the error payload from stdout as-is.
- Do not retry automatically.
- Surface the `error.next` guidance to the user and wait for explicit instruction.

## On success

- Capture the emitted `mcp_command` block and pass it to the AIBTC MCP wallet for signing + broadcast.
- After broadcast, record the returned txid and persist it in the local spend ledger.
- Run `status` again to confirm the on-chain state matches the expected outcome (balance delta, new NFT ticket id, or ticket redemption).
- Report completion with the txid and explorer URL.

## Operational notes

- This is a write skill with three distinct actions. Each action has its own confirmation token to prevent cross-action mistakes.
- StackingDAO contract principals are configurable via flags so the skill survives protocol version rolls without a rewrite.
- The skill is deliberately standalone: it emits a broadcast-ready plan rather than attempting to sign in-process, matching the pattern used by the already-merged `sbtc-yield-maximizer`.

---
name: zest-full-position-manager
description: "Full lifecycle Zest Protocol position manager — supply, borrow, repay, and withdraw with health factor as a hard-stop guardrail across all write operations on Stacks mainnet."
metadata:
  author: "lesh"
  author-agent: "Lesh AIBTC Agent"
  user-invocable: "false"
  arguments: "doctor | run --action=status | run --action=supply | run --action=borrow | run --action=repay | run --action=withdraw | run --action=manage"
  entry: "zest-full-position-manager/zest-full-position-manager.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

# Zest Full Position Manager

## What it does

Manages the complete Zest Protocol v2 lending lifecycle in a single skill: supply collateral, borrow against it, repay debt, and withdraw — all gated behind a health factor hard stop. Where the existing `zest-auto-repay` skill handles only the repay leg, this skill unifies the full supply → borrow → repay cycle with aggregate position oversight and per-operation health factor projection before any write is committed.

Supported assets: `sBTC`, `wSTX`, `stSTX`, `USDC`, `USDH`, `stSTXbtc`

## Why agents need it

A complete Zest position has three legs:
1. **Supply** — deposit collateral to earn yield
2. **Borrow** — draw liquidity against collateral (lever up or fund operations)
3. **Repay** — restore health when LTV rises

Handling these as isolated point tools leaves agents blind to cross-asset health and unable to reason about safe leverage capacity. This skill provides:
- Unified position dashboard (aggregate health factor across all assets)
- Borrow capacity planning (how much can safely be borrowed without breaching HF floor)
- Safe withdrawal limits (how much can be removed without triggering liquidation)
- Automated manage mode (detects unhealthy positions and computes minimum repayment to restore target HF)

## Safety notes

This is a **WRITE skill** — supply, borrow, repay, and withdraw all submit on-chain transactions.

**Health Factor is the primary safety lever.** Every write action projects the post-operation health factor and REFUSES execution if it would breach the hard stop.

| Safety Control | Value | Type |
|----------------|-------|------|
| Hard stop health factor | 1.2 | Hard — cannot be overridden |
| Minimum HF after borrow | 1.3 | Hard — cannot be overridden |
| Minimum HF after withdraw | 1.25 | Hard — cannot be overridden |
| Target health factor (manage) | 1.5 | Soft — configurable via `--target-hf` |
| Max supply per operation | 0.5 BTC (sats) | Hard cap |
| Max repay per day (sBTC) | 0.01 BTC (sats) | Hard cap — persisted to disk |
| Min wallet reserve (sBTC) | 5,000 sats | Hard — always preserved |
| Cooldown between writes | 300 seconds | Hard — repay overrides allowed |
| Min STX for gas | 0.2 STX | Preflight enforced |

**Repay is the only action that bypasses cooldown** — it is always an emergency escape hatch.

## Commands

### `doctor`

Pre-flight check: wallet, STX gas balance, Zest API connectivity, active positions, aggregate HF.

```bash
bun run zest-full-position-manager/zest-full-position-manager.ts doctor
```

### `run --action=status`

Full position dashboard: all assets, LTV per asset, aggregate health factor, borrow capacity, safe withdrawal limits.

```bash
bun run zest-full-position-manager/zest-full-position-manager.ts run --action=status
```

### `run --action=supply`

Supply collateral to Zest. Projects health factor — supply always improves or maintains HF.

```bash
bun run zest-full-position-manager/zest-full-position-manager.ts run --action=supply --asset=sBTC --amount=10000
```

### `run --action=borrow`

Borrow against supplied collateral. **Refused** if projected HF would fall below 1.3 (hard stop floor: 1.2).

```bash
bun run zest-full-position-manager/zest-full-position-manager.ts run --action=borrow --asset=USDC --amount=50000000
```

### `run --action=repay`

Repay outstanding debt. Always allowed regardless of cooldown. Clamps to actual debt outstanding.

```bash
bun run zest-full-position-manager/zest-full-position-manager.ts run --action=repay --asset=USDC --amount=50000000
```

### `run --action=withdraw`

Withdraw supplied collateral. **Refused** if projected HF after withdrawal would fall below 1.25.

```bash
bun run zest-full-position-manager/zest-full-position-manager.ts run --action=withdraw --asset=sBTC --amount=5000
```

### `run --action=manage`

Automated mode: finds the most at-risk position, computes minimum repayment to restore target health factor, emits repay MCP command.

```bash
bun run zest-full-position-manager/zest-full-position-manager.ts run --action=manage --target-hf=1.6
```

## Output contract

All commands output structured JSON to stdout:

```json
{
  "status": "success | error | blocked",
  "action": "Human-readable description",
  "data": { },
  "error": { "code": "...", "message": "...", "next": "..." } | null
}
```

`blocked` status means the safety guardrail prevented the action. The agent should surface the reason and next step to the user rather than retrying.

### Error codes

| Code | Meaning |
|------|---------|
| `no_wallet` | Wallet not unlocked |
| `preflight_failed` | Environment check failed (gas, connectivity) |
| `health_factor_hard_stop` | Projected HF below 1.2 — action refused |
| `exceeds_safe_borrow` | Borrow would exceed safe capacity at HF ≥ 1.3 |
| `exceeds_safe_withdraw` | Withdrawal would push HF below 1.25 |
| `exceeds_supply_cap` | Supply exceeds per-operation hard cap |
| `exceeds_borrow_cap` | Borrow exceeds per-operation hard cap |
| `daily_cap_exceeded` | Daily repay limit reached (sBTC) |
| `reserve_protection` | Repay capped to preserve min wallet reserve |
| `no_collateral` | No supplied balance to borrow against |
| `no_debt` | No outstanding debt to repay |
| `no_supply` | No supplied balance to withdraw |
| `invalid_asset` | Asset symbol not in supported list |
| `invalid_amount` | Amount not a positive integer |
| `cooldown_active` | Cooldown period active (repay exempt) |

## Architecture

```
Agent invokes skill
  -> doctor: wallet + gas check, position read, aggregate HF
  -> status: read all positions, compute aggregate HF and capacity
  -> supply: validate amount, emit zest_supply MCP command
  -> borrow: project HF, HARD STOP if < 1.2, check capacity, emit zest_borrow
  -> repay: check daily cap + reserve, emit zest_repay (cooldown-exempt)
  -> withdraw: project HF, HARD STOP if < 1.2, check safe limit, emit zest_withdraw
  -> manage: find worst position, compute min repay to restore target HF
```

The skill **never broadcasts transactions directly**. It computes parameters, runs safety checks, and emits structured `mcpCommand` objects that the agent framework executes. This ensures the agent always has final approval before any on-chain write.

## Known constraints

- Zest Protocol v2 mainnet only — no testnet support
- Health factor calculations use per-asset liquidation thresholds (sBTC: 80%, wSTX/stSTX: 75%, USDC/USDH: 90%, stSTXbtc: 70%)
- USD price approximations are illustrative — real health factor uses Pyth oracle prices on-chain
- zToken shares appreciate over time — supplied amounts may differ from initial deposit
- Interest accrues continuously — HF can decrease between checks without any user action
- Daily repay cap resets at UTC midnight (disk-persisted)
- Requires STX for transaction fees on every write operation

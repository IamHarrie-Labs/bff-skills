---
name: zest-liquidation-executor
description: "Scans Zest Protocol for undercollateralized borrowing positions and executes profitable liquidations, earning the agent a collateral bonus while protecting protocol solvency."
metadata:
  author: "IamHarrie-Labs"
  author-agent: "Harrie Agent — Autonomous DeFi Liquidator"
  user-invocable: "false"
  arguments: "doctor | run --action scan | run --action liquidate --borrower <addr> --collateral <asset> --debt <asset> --amount <sats>"
  entry: "zest-liquidation-executor/zest-liquidation-executor.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, infrastructure"
---

# Zest Liquidation Executor

## What it does

Autonomously scans Zest Protocol v2 for borrowing positions whose health factor has dropped below 1.0 (the liquidation threshold). For each undercollateralized position, it calculates the net profit after gas costs, and — when the liquidation is profitable — executes a `liquidation-call` on the Zest pool contract. The agent receives seized collateral at a protocol-defined discount (liquidation bonus), typically 5–10%, in exchange for repaying a portion of the borrower's debt.

## Why agents need it

Liquidations are a foundational DeFi primitive. Without active liquidators, lending protocols accumulate bad debt that can cascade into insolvency, harming all depositors and borrowers. This skill turns the agent into a protocol guardian: it earns real yield from liquidation bonuses while simultaneously keeping Zest Protocol solvent and healthy. No other submitted skill performs this role — existing Zest skills only supply, borrow, or repay on behalf of the agent itself.

## Safety notes

- **This is a WRITE skill.** It submits on-chain liquidation transactions.
- **Moves funds.** The agent spends its own stablecoin or sBTC balance to repay borrower debt, then receives collateral at a discount.
- **Mainnet only.** Zest Protocol v2 operates exclusively on Stacks mainnet.
- **Hard spend caps enforced.** Per-operation cap: 1,000,000 sats (0.01 BTC equivalent). Daily cap: 5,000,000 sats. These cannot be overridden by flags.
- **Profitability gate.** Liquidation is refused if estimated profit (bonus − gas) < configured minimum (default 0.5%).
- **Close factor respected.** Per Zest's Aave-derived protocol rules, at most 50% of a position's debt can be liquidated in one call.
- **Irreversible.** Once broadcast, a liquidation transaction cannot be reversed. The agent must confirm intent before execution.

## Commands

### doctor
Checks wallet readiness, STX gas balance, sBTC/stablecoin balance, and Zest contract reachability.
```bash
bun run skills/zest-liquidation-executor/zest-liquidation-executor.ts doctor
```

### run --action scan
Read-only scan of recent Zest borrowers. Returns a ranked list of liquidatable positions with estimated profit.
```bash
bun run skills/zest-liquidation-executor/zest-liquidation-executor.ts run --action scan
bun run skills/zest-liquidation-executor/zest-liquidation-executor.ts run --action scan --min-profit-bps 100
```

### run --action liquidate
Executes a liquidation against a specific borrower position. Requires explicit borrower address, collateral asset, debt asset, and amount.
```bash
bun run skills/zest-liquidation-executor/zest-liquidation-executor.ts run \
  --action liquidate \
  --borrower SP2EXAMPLE123... \
  --collateral sBTC \
  --debt wSTX \
  --amount 50000
```

### run --action auto
Full autonomous loop: scan → rank by profit → execute best liquidation if profitable.
```bash
bun run skills/zest-liquidation-executor/zest-liquidation-executor.ts run --action auto
bun run skills/zest-liquidation-executor/zest-liquidation-executor.ts run --action auto --min-profit-bps 75 --max-amount 100000
```

## Output contract

All outputs are JSON to stdout.

**Success:**
```json
{
  "status": "success",
  "action": "liquidation_executed",
  "data": {
    "borrower": "SP...",
    "collateral_asset": "sBTC",
    "debt_asset": "wSTX",
    "debt_covered_sats": 50000,
    "collateral_seized_sats": 55000,
    "net_profit_sats": 4800,
    "net_profit_bps": 96,
    "tx_id": "0x...",
    "health_factor_before": 0.92
  },
  "error": null
}
```

**Blocked (safety gate):**
```json
{
  "status": "blocked",
  "action": "liquidate",
  "data": null,
  "error": {
    "code": "insufficient_profit",
    "message": "Estimated profit 12 bps < minimum threshold 50 bps after gas",
    "next": "Lower --min-profit-bps or wait for health factor to deteriorate further"
  }
}
```

**Error:**
```json
{ "error": "descriptive message" }
```

## Known constraints

- Requires sufficient STX for gas (minimum 0.5 STX recommended; liquidations use ~0.003–0.01 STX).
- Requires the debt asset in wallet to repay borrower (e.g., sBTC to liquidate sBTC borrowers).
- Borrower scan uses Hiro API event indexer; results are limited to the most recent 500 borrow events.
- Zest's Pyth oracle price feeds must be fresh for liquidation calls to succeed (borrow-helper handles oracle fee automatically).
- Health factors change with every block; a position scanned as liquidatable may be rescued before execution.

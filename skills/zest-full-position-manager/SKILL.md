---
name: zest-full-position-manager
description: "Full lifecycle Zest Protocol position manager — supply, borrow, repay, and withdraw with health factor as a hard-stop guardrail across all write operations on Stacks mainnet."
metadata:
  author: "lesh"
  author-agent: "Serene Spring"
  agent-wallet: "bc1qqwemz3039st52s373dalyavs5zye3fvzunhwve"
  user-invocable: "false"
  arguments: "doctor | run --action=status | run --action=supply | run --action=borrow | run --action=repay | run --action=withdraw | run --action=manage | run --action=poll-confirm"
  entry: "zest-full-position-manager/zest-full-position-manager.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2"
  version: "2.0.0"
---

# Zest Full Position Manager

## What it does

Manages the complete Zest Protocol v2 lending lifecycle in a single skill: supply collateral, borrow against it, repay debt, and withdraw — all gated behind a health factor hard stop. Where the existing `zest-auto-repay` skill handles only the repay leg, this skill unifies the full supply → borrow → repay → withdraw cycle with aggregate position oversight and per-operation health factor projection before any write is committed.

All write operations target the live Zest V2 market contract (`SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market`). Collateral is stored as vault shares (e.g. `v0-vault-sbtc::zft` for sBTC) at `v0-market-vault`. Debt state is read from `v0-market-vault.get-account-scaled-debt` — the canonical live read with index scaling applied. Health factor uses live Pyth oracle prices with a 120-second staleness gate; stale prices block all write operations.

Supported assets: `sBTC`, `wSTX`, `stSTX`, `USDC`, `USDH`, `stSTXbtc`

## Agent identity

- **Agent name:** Serene Spring
- **AIBTC wallet:** `bc1qqwemz3039st52s373dalyavs5zye3fvzunhwve`
- **Stacks address (proof tx sender):** `SP301E0FY52B19281VCHP41SAKKZFR761BMKQH4QE`
- On-chain proof transactions were submitted from `SP301E0FY52B19281VCHP41SAKKZFR761BMKQH4QE`. AIBTC agent registration resolves to Serene Spring.

## Why agents need it

A complete Zest position has four legs:
1. **Supply** — deposit collateral to earn yield
2. **Borrow** — draw liquidity against collateral
3. **Repay** — restore health when LTV rises
4. **Withdraw** — remove collateral after debt is cleared

Handling these as isolated point tools leaves agents blind to cross-asset health and unable to reason about safe leverage capacity. This skill provides:
- Unified position dashboard (aggregate health factor across all assets)
- Live oracle price feed per asset (Pyth oracle v4, staleness-gated)
- Live debt read from canonical Zest V2 reserve contract
- Borrow capacity planning (how much can safely be borrowed without breaching HF floor)
- Safe withdrawal limits (how much can be removed without triggering liquidation)
- Automated manage mode (detects unhealthy positions and computes minimum repayment to restore target HF)
- Sequential tx polling (`poll-confirm` action) to prevent TooMuchChaining errors across multi-step write chains

## Contract references

| Contract | Address | Purpose |
|----------|---------|---------|
| `v0-4-market` | `SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market` | supply-collateral-add / borrow / repay / collateral-remove entry |
| `v0-market-vault` | `SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-market-vault` | collateral & debt position tracking |
| `v0-vault-sbtc` | `SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc` | sBTC yield vault — zft shares used as collateral |
| `pyth-storage-v4` | `SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-storage-v4` | Pyth oracle price storage |

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
| Oracle staleness gate | 120 seconds | Hard — stale price blocks all writes |

**Repay is the only action that bypasses cooldown** — it is always an emergency escape hatch.

**Emergency exit ordering** — repay must confirm (`tx_status: success`) before `collateral-remove-redeem` is called. If repay is blocked by insufficient balance, the skill escalates with error code `insufficient_balance_escalate`. Do NOT attempt collateral removal while borrow balance is outstanding — Zest V2 will reject it.

## Commands

### `doctor`

Pre-flight check: wallet, STX gas balance, Zest API connectivity, oracle freshness, active positions, aggregate HF.

```bash
bun run zest-full-position-manager/zest-full-position-manager.ts doctor
```

### `run --action=status`

Full position dashboard: all assets, live price per asset, LTV, aggregate health factor, borrow capacity, safe withdrawal limits.

```bash
bun run zest-full-position-manager/zest-full-position-manager.ts run --action=status
```

### `run --action=supply`

Supply collateral to Zest. Projects health factor — supply always improves or maintains HF.

```bash
bun run zest-full-position-manager/zest-full-position-manager.ts run --action=supply --asset=sBTC --amount=10000
```

### `run --action=borrow`

Borrow against supplied collateral. **Refused** if projected HF would fall below 1.3 (hard stop floor: 1.2). Oracle must be fresh.

```bash
bun run zest-full-position-manager/zest-full-position-manager.ts run --action=borrow --asset=USDC --amount=50000000
```

### `run --action=repay`

Repay outstanding debt. Always allowed regardless of cooldown. Clamps to actual debt outstanding. If balance is insufficient, escalates with `insufficient_balance_escalate` — do NOT proceed to withdraw.

```bash
bun run zest-full-position-manager/zest-full-position-manager.ts run --action=repay --asset=USDC --amount=50000000
```

### `run --action=withdraw`

Withdraw supplied collateral. **Refused** if projected HF after withdrawal would fall below 1.25 or if borrow balance is outstanding and the amount exceeds safe limits.

```bash
bun run zest-full-position-manager/zest-full-position-manager.ts run --action=withdraw --asset=sBTC --amount=5000
```

### `run --action=manage`

Automated mode: finds the most at-risk position, computes minimum repayment to restore target health factor, emits ordered step sequence (repay → poll → optionally withdraw).

```bash
bun run zest-full-position-manager/zest-full-position-manager.ts run --action=manage --target-hf=1.6
```

### `run --action=poll-confirm --txid=<txid>`

Poll a submitted transaction until `tx_status: success` before proceeding to the next write. Prevents `TooMuchChaining` errors in supply → borrow → repay → withdraw chains.

```bash
bun run zest-full-position-manager/zest-full-position-manager.ts run --action=poll-confirm --txid=0xabc123...
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
| `preflight_failed` | Environment check failed (gas, connectivity, oracle) |
| `oracle_stale` | Pyth oracle price >120s stale — writes refused |
| `health_factor_hard_stop` | Projected HF below 1.2 — action refused |
| `exceeds_safe_borrow` | Borrow would exceed safe capacity at HF ≥ 1.3 |
| `exceeds_safe_withdraw` | Withdrawal would push HF below 1.25 |
| `exceeds_supply_cap` | Supply exceeds per-operation hard cap |
| `exceeds_borrow_cap` | Borrow exceeds per-operation hard cap |
| `daily_cap_exceeded` | Daily repay limit reached (sBTC) |
| `daily_cap_reached_escalate` | Cap reached in emergency — escalate, no collateral removal |
| `reserve_protection` | Repay capped to preserve min wallet reserve |
| `insufficient_balance_escalate` | Cannot repay — deposit more; do NOT attempt withdraw |
| `no_collateral` | No supplied balance to borrow against |
| `no_debt` | No outstanding debt to repay |
| `no_supply` | No supplied balance to withdraw |
| `tx_failed` | Submitted tx aborted on-chain |
| `tx_timeout` | Tx not confirmed within 5 min polling window |
| `invalid_asset` | Asset symbol not in supported list |
| `invalid_amount` | Amount not a positive integer |
| `missing_txid` | poll-confirm called without --txid |

## Architecture

```
Agent invokes skill
  -> doctor: wallet + gas + oracle freshness check, position read, aggregate HF
  -> status: read all positions (live debt + live price), compute aggregate HF and capacity
  -> supply: validate, emit zest_supply_asset MCP command (v0-4-market)
  -> borrow: project HF via live oracle, HARD STOP if < 1.2, check capacity, emit zest_borrow_asset
  -> repay: check daily cap + reserve, emit zest_repay_asset (cooldown-exempt)
             if balance insufficient → escalate (insufficient_balance_escalate)
  -> withdraw: project HF, HARD STOP if < 1.2, block if borrow outstanding, emit zest_withdraw_asset
  -> manage: find worst position, compute min repay, emit ordered step sequence
             repay → poll-confirm → then collateral-remove-redeem (only after success)
  -> poll-confirm: poll /extended/v1/tx/{txid} until tx_status:success
```

The skill **never broadcasts transactions directly**. It computes parameters, runs safety checks, and emits structured `mcpCommand` objects that the agent framework executes.

## Known constraints

- Zest Protocol v2 mainnet only — no testnet support
- Health factor uses live Pyth oracle prices — stale prices (>120s) block all write operations
- zToken shares appreciate over time — supplied amounts may differ from initial deposit
- Interest accrues continuously — HF can decrease between checks without user action
- Daily repay cap resets at UTC midnight (disk-persisted)
- Requires STX for transaction fees on every write operation
- Sequential writes must be confirmed via `poll-confirm` before the next step to avoid `TooMuchChaining`

## On-chain proof (per #484 §5)

Sender: `SP301E0FY52B19281VCHP41SAKKZFR761BMKQH4QE` (Serene Spring)

| Operation | tx hash | Contract | Function | Block |
|-----------|---------|----------|----------|-------|
| supply-collateral-add | [`0xe1e457...ec42a2`](https://explorer.hiro.so/txid/0xe1e45722b7ef300e345d9b7cf369e42984fe825c45685b4fe781a10ffaec42a2?chain=mainnet) | `SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market` | `supply-collateral-add` | 7715675 |
| borrow | [`0x0e06bd...d0717`](https://explorer.hiro.so/txid/0x0e06bdba13ff89a39d73f180fa6e0de1aa39a8e65efa937bcbe72a284bbd0717?chain=mainnet) | `SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market` | `borrow` | 7715717 |
| repay | [`0xad478b...8a45`](https://explorer.hiro.so/txid/0xad478bb27fc8b2c9cb7947ea0ab8243c797ba0fb3b4f8b370c33a98258a18a45?chain=mainnet) | `SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market` | `repay` | 7715793 |
| collateral-remove | [`0xf431c6...df6`](https://explorer.hiro.so/txid/0xf431c6d004cee14336e8b5af6c025d285ee625cc3e690c1f8992503ec3b3adf6?chain=mainnet) | `SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-4-market` | `collateral-remove` | 7718037 |

All four transactions verified at `tx_status: success` via `GET /extended/v1/tx/{txid}` before submission.

> **Note on collateral token**: The market stores sBTC collateral as `v0-vault-sbtc::zft` shares (asset-id=3), not raw sBTC (asset-id=2). The `collateral-remove` call must pass `SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.v0-vault-sbtc` as the `ft` trait parameter. Passing the raw sBTC token returns `(err u600004)` (ERR-INSUFFICIENT-COLLATERAL in `v0-market-vault`). The `supply-collateral-add(sBTC, 150)` call minted 149 `v0-vault-sbtc::zft` shares (1 share = yield-appreciation, ~1 sat sBTC), which are what get removed by `collateral-remove`.

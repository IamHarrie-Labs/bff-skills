---
name: ststx-liquid-stacker
description: "Liquid stack STX via StackingDAO — deposit STX for stSTX, initiate batched withdrawals, and claim matured STX with code-enforced ratio-slippage, amount caps, reserve floors, cooldown, mainnet-only, and PostConditionMode.Deny safety gates."
metadata:
  author: "IamHarrie-Labs"
  author-agent: "Liquid Horizon"
  user-invocable: "false"
  arguments: "doctor | status | run"
  entry: "ststx-liquid-stacker/ststx-liquid-stacker.ts"
  requires: "wallet, signing, settings"
  tags: "defi, write, mainnet-only, requires-funds, l2"
---

# stSTX Liquid Stacker

## What it does

Executes the three StackingDAO liquid-stacking write flows that no skill in the registry currently covers: `deposit` (STX → stSTX), `init-withdraw` (burn stSTX to mint a withdrawal NFT ticket), and `withdraw` (claim STX from a matured ticket). Every write path enforces ratio-slippage, amount caps, reserve floors, cooldown, mainnet-only, and `PostConditionMode.Deny` in code — not just documentation.

## Why agents need it

Liquid stacking is a core Stacks DeFi primitive: it turns illiquid 1–2-week PoX stacking cycles into a liquid receipt token (stSTX) that earns native yield while remaining composable. The existing `stacking-delegation` skill handles native PoX delegation only; this skill closes the liquid-stacking gap so agents can (1) convert idle STX into yield-bearing stSTX on demand, (2) queue withdrawals when capital is needed for other strategies, and (3) reclaim matured STX without manual ticket tracking.

This is complementary to the existing `sbtc-yield-maximizer` (which routes idle sBTC) and `zest-yield-manager` (which handles Zest supply) — together they give agents full-coverage STX, stSTX, and sBTC yield execution across the three largest Stacks yield surfaces.

## Safety notes

- **Writes to chain.** `run deposit`, `run init-withdraw`, and `run withdraw` all broadcast real transactions on Stacks mainnet via the AIBTC MCP wallet.
- **Mainnet only.** StackingDAO core contracts referenced by default are mainnet deployments; the skill refuses to execute against testnet.
- **Irreversible.** `init-withdraw` burns stSTX and mints a withdrawal NFT. It cannot be reversed within the cycle. `withdraw` spends a matured ticket; once redeemed it is gone.
- **Ratio slippage enforced.** Every `deposit` and `init-withdraw` reads `get-stx-per-ststx` from the reserve before execution and refuses to broadcast if the current rate deviates from the caller-provided `--expected-rate-ustx-per-ststx` by more than `--max-slippage-bps`.
- **Amount caps enforced.** `--max-deposit-ustx`, `--max-withdraw-ststx`, and a hard-coded per-operation safety ceiling are applied in code. The wallet retains at least `--reserve-ustx` after the deposit path.
- **Gas reserve enforced.** The wallet must keep at least `--min-gas-reserve-ustx` for transaction fees post-broadcast.
- **Cooldown enforced.** A per-action cooldown (`--cooldown-seconds`) prevents accidental double-execution.
- **Confirmation token required.** Write paths refuse to broadcast without the matching `--confirm=STACK`, `--confirm=UNSTACK`, or `--confirm=CLAIM` token.
- **PostConditionMode.Deny.** Every broadcast transaction is built with `PostConditionMode.Deny` — any unexpected token movement aborts the transaction on-chain.
- **Cycle awareness on withdraw.** `run withdraw --id <nft-id>` reads the ticket's `cycle` field and refuses to broadcast until the StackingDAO current cycle has advanced past it.

## Commands

### doctor
Verifies wallet resolution, STX balance, stSTX balance, StackingDAO contract reachability, current stSTX/STX ratio, and cooldown state.

```bash
bun run skills/ststx-liquid-stacker/ststx-liquid-stacker.ts doctor
```

### status
Read-only snapshot: live balances, current `stx-per-ststx` ratio, any outstanding withdrawal NFT tickets the wallet holds, and which cycle each ticket matures in.

```bash
bun run skills/ststx-liquid-stacker/ststx-liquid-stacker.ts status
```

### run
Executes one of the three write flows. Action is explicit — the skill never infers intent.

```bash
# Deposit STX → mint stSTX
bun run skills/ststx-liquid-stacker/ststx-liquid-stacker.ts run \
  --action deposit \
  --amount-ustx 1000000 \
  --expected-rate-ustx-per-ststx 1050000 \
  --max-slippage-bps 50 \
  --confirm=STACK

# Burn stSTX → mint withdrawal NFT ticket
bun run skills/ststx-liquid-stacker/ststx-liquid-stacker.ts run \
  --action init-withdraw \
  --amount-ststx 1000000 \
  --expected-rate-ustx-per-ststx 1050000 \
  --max-slippage-bps 50 \
  --confirm=UNSTACK

# Claim matured withdrawal ticket
bun run skills/ststx-liquid-stacker/ststx-liquid-stacker.ts run \
  --action withdraw \
  --id 1234 \
  --confirm=CLAIM
```

## Output contract

All outputs are JSON to stdout.

**Success (broadcast confirmed):**

```json
{
  "status": "success",
  "action": "Deposit broadcast and confirmed on Stacks mainnet",
  "data": {
    "operation": "deposit",
    "wallet": "SP...",
    "txid": "abc123...",
    "explorer_url": "https://explorer.hiro.so/txid/0xabc123...?chain=mainnet",
    "tx_status": "success",
    "amount_ustx": 1000000,
    "live_stx_per_ststx": "1865545",
    "estimated_ststx_minted": "536036",
    "slippage_bps_observed": 0
  },
  "error": null
}
```

**Blocked:**

```json
{
  "status": "blocked",
  "action": "aborted",
  "data": null,
  "error": {
    "code": "rate_slippage_exceeded",
    "message": "Current rate 1880000 deviates 78 bps from expected 1865545 (max 50 bps)",
    "next": "Re-read rate with `status` and re-submit with an updated --expected-rate or a wider --max-slippage-bps"
  }
}
```

**Error:**

```json
{
  "status": "error",
  "action": "aborted",
  "data": null,
  "error": { "code": "broadcast_failed", "message": "...", "next": "..." }
}
```

## Known constraints

- StackingDAO contracts are trait-based; the skill passes the canonical `reserve-v1`, `commission-v2`, `staking-v0`, and `direct-helpers-v4` principals as `contractPrincipalCV` arguments. These are overridable via flags so the skill survives protocol-version rolls.
- Withdrawal tickets are NFTs minted by `stacking-dao-core-v2`; maturity is measured in PoX cycles (~2 weeks each on mainnet). The skill reads the current cycle from the PoX contract to gate `withdraw` claims.
- Requires live STX for deposits and live stSTX for withdrawals; `doctor` blocks on insufficient balance.
- `AIBTC_WALLET_PASSWORD` must be set for `run` — the skill unlocks the AIBTC wallet manager to sign and broadcast transactions directly.

#!/usr/bin/env bun
/**
 * ststx-liquid-stacker — StackingDAO Liquid Stacking Manager
 *
 * Covers the three write flows that unlock liquid stacking on Stacks:
 *   1. deposit       STX  -> stSTX                  (core-v2 `deposit`)
 *   2. init-withdraw stSTX -> withdrawal NFT ticket (core-v2 `init-withdraw`)
 *   3. withdraw      NFT ticket (matured) -> STX    (core-v2 `withdraw`)
 *
 * Every write path enforces in code (not just docs):
 *   - mainnet-only principal inspection
 *   - live stx-per-ststx ratio vs caller-supplied expected rate (bps slippage)
 *   - amount caps (per-op soft cap via flag + hard ceiling constant)
 *   - reserve floor on STX (post-deposit liquidity)
 *   - gas reserve floor on STX (post-broadcast)
 *   - cooldown between same-action broadcasts
 *   - confirmation token specific to action
 *   - PoX cycle maturity for withdraw-claim
 *   - PostConditionMode.Deny on every broadcast transaction
 *
 * Transactions are broadcast directly via @stacks/transactions + the AIBTC
 * wallet manager. The skill awaits on-chain confirmation before returning.
 *
 * Author: IamHarrie-Labs
 * Agent:  Liquid Horizon — Autonomous Liquid-Stacking Router
 */

import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";
import {
  PostConditionMode,
  contractPrincipalCV,
  uintCV,
  noneCV,
  Pc,
  serializeCV,
} from "@stacks/transactions";
import type { ContractCallOptions } from "@aibtc/mcp-server/dist/transactions/builder.js";
import { callContract, signContractCall } from "@aibtc/mcp-server/dist/transactions/builder.js";
import { getWalletManager } from "@aibtc/mcp-server/dist/services/wallet-manager.js";

// ═══════════════════════════════════════════════════════════════════════════
// SAFETY CONSTANTS — hard-coded, cannot be overridden by flags.
// ═══════════════════════════════════════════════════════════════════════════
const HARD_CAP_PER_DEPOSIT_USTX   = 500_000_000_000; // 500,000 STX — absolute per-op deposit ceiling
const HARD_CAP_PER_WITHDRAW_STSTX = 500_000_000_000; // 500,000 stSTX — absolute per-op withdraw ceiling
const HARD_CAP_DAILY_USTX         = 1_000_000_000_000; // 1,000,000 STX — per-agent daily cap
const DEFAULT_MIN_GAS_USTX        = 1_000_000;       // 1 STX minimum for gas
const DEFAULT_RESERVE_USTX        = 1_000_000;       // 1 STX kept as spendable reserve post-deposit
const DEFAULT_COOLDOWN_SECONDS    = 120;             // 2 minutes between same-action broadcasts
const DEFAULT_MAX_SLIPPAGE_BPS    = 50;              // 0.50% max deviation from expected rate
const SLIPPAGE_BPS_FLOOR          = 1;               // cannot disable the check
const SLIPPAGE_BPS_CEILING        = 500;             // 5% maximum tolerance the skill will accept
const FETCH_TIMEOUT_MS            = 15_000;
const HIRO_API                    = "https://api.hiro.so";
const TX_POLL_INTERVAL_MS         = 10_000;          // 10s between status checks
const TX_POLL_MAX_ATTEMPTS        = 30;              // 5 minutes total wait time

// ═══════════════════════════════════════════════════════════════════════════
// STACKINGDAO MAINNET CONTRACTS (overridable via flags for protocol version rolls)
// ═══════════════════════════════════════════════════════════════════════════
const DEFAULT_CORE           = "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.stacking-dao-core-v6";
const DEFAULT_STSTX_TOKEN    = "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token";
const DEFAULT_RESERVE        = "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.reserve-v1";
const DEFAULT_COMMISSION     = "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.commission-v2";
const DEFAULT_STAKING        = "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.staking-v0";
const DEFAULT_DIRECT_HELPERS = "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.direct-helpers-v4";
const DEFAULT_DATA_CORE      = "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.data-core-v3";
const DEFAULT_WITHDRAW_NFT   = "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-withdraw-nft-v2";

// ═══════════════════════════════════════════════════════════════════════════
// PERSISTENT COOLDOWN + SPEND LEDGER
// ═══════════════════════════════════════════════════════════════════════════
interface LedgerEntry {
  ts: string;
  action: "deposit" | "init-withdraw" | "withdraw";
  amount: number;
  txid: string;
}
interface Ledger {
  date: string;
  totalUstxMoved: number;
  lastEpoch: Record<string, number>; // action -> epoch seconds
  entries: LedgerEntry[];
}

const LEDGER_FILE = join(homedir(), ".ststx-liquid-stacker-ledger.json");

function loadLedger(): Ledger {
  const today = new Date().toISOString().slice(0, 10);
  try {
    if (existsSync(LEDGER_FILE)) {
      const raw = JSON.parse(readFileSync(LEDGER_FILE, "utf8")) as Ledger;
      if (raw.date === today) return raw;
    }
  } catch {
    /* corrupt file — fresh start */
  }
  return { date: today, totalUstxMoved: 0, lastEpoch: {}, entries: [] };
}

function saveLedger(l: Ledger): void {
  writeFileSync(LEDGER_FILE, JSON.stringify(l, null, 2), "utf8");
}

// ═══════════════════════════════════════════════════════════════════════════
// JSON OUTPUT HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function out(status: "success" | "error" | "blocked", action: string, data: unknown, error: unknown = null) {
  console.log(JSON.stringify({ status, action, data, error }));
}
function fail(code: string, message: string, next: string) {
  console.log(JSON.stringify({ status: "error", action: "aborted", data: null, error: { code, message, next } }));
}
function blocked(code: string, message: string, next: string) {
  console.log(JSON.stringify({ status: "blocked", action: "aborted", data: null, error: { code, message, next } }));
}

// ═══════════════════════════════════════════════════════════════════════════
// HIRO API HELPERS
// ═══════════════════════════════════════════════════════════════════════════
async function hiroFetch<T>(path: string): Promise<T | null> {
  try {
    const res = await fetch(`${HIRO_API}${path}`, {
      headers: { Accept: "application/json" },
      signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
    });
    if (!res.ok) return null;
    return res.json() as Promise<T>;
  } catch {
    return null;
  }
}

async function callReadOnly(
  contract: string,
  fnName: string,
  args: string[],
  sender: string
): Promise<any> {
  const [addr, name] = contract.split(".");
  try {
    const res = await fetch(
      `${HIRO_API}/v2/contracts/call-read/${addr}/${name}/${fnName}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender, arguments: args }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
      }
    );
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

function encodeUintHex(value: number | bigint): string {
  const buf = Buffer.alloc(17);
  buf[0] = 0x01; // clarity uint tag
  const big = BigInt(value);
  for (let i = 16; i >= 1; i--) {
    buf[i] = Number(big >> BigInt((16 - i) * 8)) & 0xff;
  }
  return "0x" + buf.toString("hex");
}

function parseOkUintHex(result: string | undefined): bigint {
  if (!result) return 0n;
  const hex = result.startsWith("0x") ? result.slice(2) : result;
  if (hex.startsWith("07") && hex.length >= 36) {
    const inner = hex.slice(2);
    if (inner.startsWith("01")) {
      let v = 0n;
      for (let i = 0; i < 16; i++) {
        v = (v << 8n) + BigInt(parseInt(inner.slice(2 + i * 2, 4 + i * 2), 16));
      }
      return v;
    }
  }
  if (hex.startsWith("01") && hex.length >= 34) {
    let v = 0n;
    for (let i = 0; i < 16; i++) {
      v = (v << 8n) + BigInt(parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16));
    }
    return v;
  }
  return 0n;
}

function parseRawUintHex(result: string | undefined): bigint {
  if (!result) return 0n;
  const hex = result.startsWith("0x") ? result.slice(2) : result;
  if (hex.startsWith("01") && hex.length >= 34) {
    let v = 0n;
    for (let i = 0; i < 16; i++) {
      v = (v << 8n) + BigInt(parseInt(hex.slice(2 + i * 2, 4 + i * 2), 16));
    }
    return v;
  }
  return 0n;
}

// ═══════════════════════════════════════════════════════════════════════════
// WALLET + BALANCE HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function getWallet(): string {
  const addr = process.env.STACKS_ADDRESS || process.env.STX_ADDRESS;
  if (!addr) throw new Error("STACKS_ADDRESS not set — run AIBTC wallet unlock first");
  return addr;
}

function isMainnetPrincipal(addr: string): boolean {
  return /^S[PM][A-Z0-9]+$/.test(addr);
}

async function getStxBalance(address: string): Promise<number> {
  const data = await hiroFetch<any>(`/extended/v1/address/${address}/stx`);
  if (!data) return 0;
  return parseInt(data.balance || "0", 10) - parseInt(data.locked || "0", 10);
}

async function getTokenBalance(address: string, tokenContract: string): Promise<number> {
  const data = await hiroFetch<any>(`/extended/v1/address/${address}/balances`);
  if (!data?.fungible_tokens) return 0;
  const key = Object.keys(data.fungible_tokens).find((k) => k.startsWith(tokenContract));
  if (!key) return 0;
  return parseInt(data.fungible_tokens[key].balance || "0", 10);
}

// ═══════════════════════════════════════════════════════════════════════════
// STACKINGDAO READS
// ═══════════════════════════════════════════════════════════════════════════
async function getStxPerStstx(
  reserveContract: string,
  dataCore: string,
  sender: string
): Promise<bigint | null> {
  const [resAddr, resName] = reserveContract.split(".");
  // serializeCV returns a plain hex string in @stacks/transactions v7 — prefix with 0x for the API
  const resHex = "0x" + (serializeCV(contractPrincipalCV(resAddr, resName)) as unknown as string);
  const res = await callReadOnly(dataCore, "get-stx-per-ststx", [resHex], sender);
  if (!res?.result) return null;
  const rate = parseOkUintHex(res.result);
  return rate > 0n ? rate : null;
}

async function getCurrentPoxCycle(core: string, sender: string): Promise<number | null> {
  const res = await callReadOnly(core, "current-pox-reward-cycle", [], sender);
  if (res?.result) {
    const v = parseRawUintHex(res.result) || parseOkUintHex(res.result);
    if (v > 0n) return Number(v);
  }
  const data = await hiroFetch<any>("/v2/pox");
  if (data) return typeof data.current_cycle?.id === "number" ? data.current_cycle.id : null;
  return null;
}

async function getWithdrawalTickets(address: string, withdrawNft: string): Promise<Array<{ id: number; assetId: string }>> {
  const data = await hiroFetch<any>(
    `/extended/v1/tokens/nft/holdings?principal=${address}&asset_identifiers=${encodeURIComponent(
      `${withdrawNft}::ststx-withdraw-nft`
    )}&limit=50`
  );
  if (!data?.results) return [];
  const result: Array<{ id: number; assetId: string }> = [];
  for (const row of data.results) {
    const repr: string = row.value?.repr || "";
    const m = repr.match(/u(\d+)/);
    if (m) result.push({ id: parseInt(m[1], 10), assetId: row.asset_identifier });
  }
  return result;
}

// Reads ticket maturity from data-core-v1 (get-withdrawals-by-nft returns tuple with unlock-burn-height)
async function getTicketCycle(dataCore1: string, nftId: number, sender: string): Promise<number | null> {
  const res = await callReadOnly(dataCore1, "get-withdrawals-by-nft", [encodeUintHex(nftId)], sender);
  if (!res?.result) return null;
  const hex = typeof res.result === "string" ? res.result : "";
  // Response is a tuple: { unlock-burn-height: uint, stx-amount: uint, ststx-amount: uint }
  // We parse unlock-burn-height — the first uint in the tuple after the tuple header
  const m = hex.match(/0c[0-9a-f]{8}(?:[0-9a-f]+?)?01([0-9a-f]{32})/);
  if (m) {
    try {
      return parseInt(m[1], 16);
    } catch {
      return null;
    }
  }
  // Fallback: extract any uint value from the result
  const fallback = hex.match(/01([0-9a-f]{32})/);
  if (!fallback) return null;
  try {
    return parseInt(fallback[1], 16);
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// TX CONFIRMATION POLLER
// ═══════════════════════════════════════════════════════════════════════════
async function awaitConfirmation(txid: string): Promise<"success" | "failed" | "pending"> {
  for (let i = 0; i < TX_POLL_MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, TX_POLL_INTERVAL_MS));
    const data = await hiroFetch<any>(`/extended/v1/tx/0x${txid}`);
    if (!data) continue;
    const status: string = data.tx_status ?? "";
    if (status === "success") return "success";
    if (status.startsWith("abort") || status === "failed" || status === "rejected") return "failed";
  }
  return "pending";
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMANDS
// ═══════════════════════════════════════════════════════════════════════════
const program = new Command();

program
  .name("ststx-liquid-stacker")
  .description("StackingDAO liquid-stacking writer: deposit STX, init-withdraw stSTX, claim matured tickets")
  .version("2.0.0");

function addContractFlags(cmd: Command): Command {
  return cmd
    .option("--core <principal>", "StackingDAO core contract", DEFAULT_CORE)
    .option("--ststx-token <principal>", "stSTX fungible token contract", DEFAULT_STSTX_TOKEN)
    .option("--reserve-contract <principal>", "StackingDAO reserve contract", DEFAULT_RESERVE)
    .option("--commission-contract <principal>", "StackingDAO commission contract", DEFAULT_COMMISSION)
    .option("--staking-contract <principal>", "StackingDAO staking contract", DEFAULT_STAKING)
    .option("--direct-helpers-contract <principal>", "StackingDAO direct-helpers contract", DEFAULT_DIRECT_HELPERS)
    .option("--data-core <principal>", "StackingDAO data core contract (rate source)", DEFAULT_DATA_CORE)
    .option("--withdraw-nft <principal>", "StackingDAO withdraw NFT contract", DEFAULT_WITHDRAW_NFT);
}

// ── DOCTOR ─────────────────────────────────────────────────────────────────
addContractFlags(
  program
    .command("doctor")
    .description("Verify wallet, balances, contract reachability, and current ratio")
)
  .action(async (opts) => {
    const checks: Record<string, { ok: boolean; detail: string }> = {};
    let wallet: string | null = null;

    try {
      wallet = getWallet();
      checks.wallet = { ok: true, detail: wallet };
    } catch (e: any) {
      checks.wallet = { ok: false, detail: e.message };
    }

    if (wallet) {
      checks.mainnet = {
        ok: isMainnetPrincipal(wallet),
        detail: isMainnetPrincipal(wallet) ? "wallet is mainnet (SP/SM)" : "wallet is NOT mainnet — skill refuses to execute",
      };

      const stx = await getStxBalance(wallet);
      checks.stx_balance = {
        ok: stx >= DEFAULT_MIN_GAS_USTX,
        detail: `${stx} uSTX (gas min ${DEFAULT_MIN_GAS_USTX})`,
      };

      const ststx = await getTokenBalance(wallet, opts.ststxToken);
      checks.ststx_balance = { ok: true, detail: `${ststx} (stSTX micro-units)` };
    }

    checks.wallet_password = {
      ok: Boolean(process.env.AIBTC_WALLET_PASSWORD),
      detail: process.env.AIBTC_WALLET_PASSWORD
        ? "AIBTC_WALLET_PASSWORD is set"
        : "AIBTC_WALLET_PASSWORD not set (required for run)",
    };

    for (const [label, principal] of [
      ["core", opts.core],
      ["reserve", opts.reserveContract],
      ["commission", opts.commissionContract],
      ["staking", opts.stakingContract],
      ["direct_helpers", opts.directHelpersContract],
      ["ststx_token", opts.ststxToken],
    ]) {
      const [addr, name] = (principal as string).split(".");
      const res = await hiroFetch<any>(`/v2/contracts/interface/${addr}/${name}`);
      checks[`contract_${label}`] = {
        ok: !!res,
        detail: res ? `${principal} reachable` : `${principal} unreachable`,
      };
    }

    if (wallet && isMainnetPrincipal(wallet)) {
      const rate = await getStxPerStstx(opts.reserveContract, opts.dataCore, wallet);
      checks.ratio_read = {
        ok: rate !== null,
        detail: rate !== null ? `1 stSTX = ${rate} uSTX (total-stx / total-supply derived)` : "could not read ratio",
      };
    }

    const ledger = loadLedger();
    const now = Date.now() / 1000;
    checks.cooldowns = {
      ok: true,
      detail: (["deposit", "init-withdraw", "withdraw"] as const)
        .map((a) => {
          const last = ledger.lastEpoch[a] || 0;
          const rem = Math.max(0, DEFAULT_COOLDOWN_SECONDS - (now - last));
          return `${a}=${rem === 0 ? "ready" : `${Math.ceil(rem)}s`}`;
        })
        .join(", "),
    };
    checks.daily_cap_remaining = {
      ok: ledger.totalUstxMoved < HARD_CAP_DAILY_USTX,
      detail: `${HARD_CAP_DAILY_USTX - ledger.totalUstxMoved} uSTX of ${HARD_CAP_DAILY_USTX} remaining today`,
    };

    const allOk = Object.values(checks).every((c) => c.ok);
    if (allOk) {
      out("success", "Environment ready — all checks passed", {
        wallet,
        checks,
        safety_limits: {
          hard_cap_per_deposit_ustx: HARD_CAP_PER_DEPOSIT_USTX,
          hard_cap_per_withdraw_ststx: HARD_CAP_PER_WITHDRAW_STSTX,
          hard_cap_daily_ustx: HARD_CAP_DAILY_USTX,
          cooldown_seconds: DEFAULT_COOLDOWN_SECONDS,
          slippage_bps_ceiling: SLIPPAGE_BPS_CEILING,
        },
        next: "Run `status` to read live rate, then `run --action <deposit|init-withdraw|withdraw>`",
      });
    } else {
      const blockers = Object.entries(checks)
        .filter(([, c]) => !c.ok)
        .map(([k, c]) => `${k}: ${c.detail}`);
      blocked("preflight_failed", blockers.join("; "), "Fix listed blockers and re-run doctor");
    }
  });

// ── STATUS ─────────────────────────────────────────────────────────────────
addContractFlags(
  program
    .command("status")
    .description("Read live balances, current rate, and outstanding withdrawal tickets")
)
  .action(async (opts) => {
    let wallet: string;
    try {
      wallet = getWallet();
    } catch (e: any) {
      fail("no_wallet", e.message, "Run AIBTC wallet unlock or set STACKS_ADDRESS");
      return;
    }
    if (!isMainnetPrincipal(wallet)) {
      blocked("not_mainnet", `Wallet ${wallet} is not a mainnet principal`, "Use a mainnet wallet (SP/SM prefix)");
      return;
    }

    const [stx, ststx, rate, cycle, tickets] = await Promise.all([
      getStxBalance(wallet),
      getTokenBalance(wallet, opts.ststxToken),
      getStxPerStstx(opts.reserveContract, opts.dataCore, wallet),
      getCurrentPoxCycle(opts.core, wallet),
      getWithdrawalTickets(wallet, opts.withdrawNft),
    ]);

    const ticketDetails: Array<{ id: number; cycle_id: number | null; matured: boolean | null }> = [];
    for (const t of tickets) {
      const tCycle = await getTicketCycle("SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.data-core-v1", t.id, wallet);
      ticketDetails.push({
        id: t.id,
        cycle_id: tCycle,
        matured: tCycle === null || cycle === null ? null : cycle > tCycle,
      });
    }

    out("success", "Live status snapshot", {
      wallet,
      balances: { stx_ustx: stx, ststx_microunits: ststx },
      rate: {
        ustx_per_ststx: rate !== null ? rate.toString() : null,
        note: "1 stSTX ≈ rate / 1_000_000 STX",
      },
      pox_current_cycle: cycle,
      withdrawal_tickets: ticketDetails,
      ready_actions: {
        deposit: stx > DEFAULT_RESERVE_USTX + DEFAULT_MIN_GAS_USTX,
        init_withdraw: ststx > 0,
        withdraw: ticketDetails.some((t) => t.matured === true),
      },
    });
  });

// ── RUN ────────────────────────────────────────────────────────────────────
addContractFlags(
  program
    .command("run")
    .description("Execute a StackingDAO write action — broadcasts directly to Stacks mainnet")
    .requiredOption("--action <action>", "deposit | init-withdraw | withdraw")
    .option("--amount-ustx <n>", "uSTX amount to deposit (for --action deposit)", "0")
    .option("--amount-ststx <n>", "stSTX micro-unit amount to queue for withdraw (for --action init-withdraw)", "0")
    .option("--id <n>", "Withdrawal ticket NFT id (for --action withdraw)", "0")
    .option("--expected-rate-ustx-per-ststx <n>", "Caller's expected stx-per-ststx rate for slippage gate", "0")
    .option("--max-slippage-bps <n>", `Max deviation vs expected rate (floor ${SLIPPAGE_BPS_FLOOR}, ceiling ${SLIPPAGE_BPS_CEILING})`, String(DEFAULT_MAX_SLIPPAGE_BPS))
    .option("--max-deposit-ustx <n>", "Per-op deposit cap", String(HARD_CAP_PER_DEPOSIT_USTX))
    .option("--max-withdraw-ststx <n>", "Per-op withdraw cap", String(HARD_CAP_PER_WITHDRAW_STSTX))
    .option("--reserve-ustx <n>", "Minimum STX balance preserved after deposit", String(DEFAULT_RESERVE_USTX))
    .option("--min-gas-reserve-ustx <n>", "Minimum STX retained for gas", String(DEFAULT_MIN_GAS_USTX))
    .option("--cooldown-seconds <n>", "Cooldown between same-action broadcasts", String(DEFAULT_COOLDOWN_SECONDS))
    .option("--referrer <principal>", "Optional referrer principal (StackingDAO)", "")
    .option("--pool <principal>", "Optional stacking pool override", "")
    .option("--confirm <token>", "Action-specific confirmation token (STACK|UNSTACK|CLAIM)", "")
    .option("--dry-run", "Build and sign the transaction but do not broadcast", false)
)
  .action(async (opts) => {
    const action = opts.action as "deposit" | "init-withdraw" | "withdraw";
    if (!["deposit", "init-withdraw", "withdraw"].includes(action)) {
      fail("unknown_action", `Action '${action}' not recognised`, "Use deposit | init-withdraw | withdraw");
      return;
    }

    // ── Wallet + mainnet check ──────────────────────────────────────────
    let wallet: string;
    try {
      wallet = getWallet();
    } catch (e: any) {
      fail("no_wallet", e.message, "Run AIBTC wallet unlock or set STACKS_ADDRESS");
      return;
    }
    if (!isMainnetPrincipal(wallet)) {
      blocked("not_mainnet", `Wallet ${wallet} is not a mainnet principal`, "Use a mainnet (SP/SM) wallet");
      return;
    }

    // ── Wallet password (required for signing) ──────────────────────────
    const password = process.env.AIBTC_WALLET_PASSWORD;
    if (!password) {
      blocked(
        "no_wallet_password",
        "AIBTC_WALLET_PASSWORD is required to sign and broadcast transactions",
        "Export AIBTC_WALLET_PASSWORD and retry"
      );
      return;
    }

    // ── Confirmation token ──────────────────────────────────────────────
    const expectedConfirm =
      action === "deposit" ? "STACK" : action === "init-withdraw" ? "UNSTACK" : "CLAIM";
    if (opts.confirm !== expectedConfirm) {
      blocked(
        "confirm_missing",
        `--confirm=${expectedConfirm} required for --action ${action}`,
        `Re-run with --confirm=${expectedConfirm} once the plan has been reviewed`
      );
      return;
    }

    // ── Slippage bounds normalisation ───────────────────────────────────
    const slippageBps = Math.max(
      SLIPPAGE_BPS_FLOOR,
      Math.min(SLIPPAGE_BPS_CEILING, parseInt(opts.maxSlippageBps, 10) || DEFAULT_MAX_SLIPPAGE_BPS)
    );

    // ── Cooldown ────────────────────────────────────────────────────────
    const ledger = loadLedger();
    const now = Date.now() / 1000;
    const cooldown = parseInt(opts.cooldownSeconds, 10) || DEFAULT_COOLDOWN_SECONDS;
    const lastEpoch = ledger.lastEpoch[action] || 0;
    if (lastEpoch && now - lastEpoch < cooldown) {
      blocked(
        "cooldown_active",
        `${Math.ceil(cooldown - (now - lastEpoch))}s cooldown remaining on action ${action}`,
        "Wait for cooldown to clear"
      );
      return;
    }

    // ── Daily cap ───────────────────────────────────────────────────────
    if (ledger.totalUstxMoved >= HARD_CAP_DAILY_USTX) {
      blocked("daily_cap_reached", `Daily cap ${HARD_CAP_DAILY_USTX} uSTX reached`, "Cap resets at 00:00 UTC");
      return;
    }

    // ── Gas pre-check (all actions) ─────────────────────────────────────
    const minGas = !Number.isNaN(parseInt(opts.minGasReserveUstx, 10)) ? parseInt(opts.minGasReserveUstx, 10) : DEFAULT_MIN_GAS_USTX;
    const stxBal = await getStxBalance(wallet);
    if (stxBal < minGas) {
      blocked("insufficient_gas", `STX balance ${stxBal} uSTX < required ${minGas} uSTX`, "Top up STX for gas");
      return;
    }

    // ── Unlock wallet ───────────────────────────────────────────────────
    const wm = getWalletManager();
    let account: any;
    try {
      const walletId = await wm.getActiveWalletId();
      if (!walletId) throw new Error("No active AIBTC wallet — run wallet setup first");
      account = await wm.unlock(walletId, password);
    } catch (e: any) {
      fail("wallet_unlock_failed", e.message, "Check AIBTC_WALLET_PASSWORD and wallet configuration");
      return;
    }

    // ── Contract principal components ───────────────────────────────────
    const [coreAddr, coreName]     = (opts.core as string).split(".");
    const [resAddr, resName]       = (opts.reserveContract as string).split(".");
    const [comAddr, comName]       = (opts.commissionContract as string).split(".");
    const [stakeAddr, stakeName]   = (opts.stakingContract as string).split(".");
    const [dhAddr, dhName]         = (opts.directHelpersContract as string).split(".");
    const [stxTokAddr, stxTokName] = (opts.ststxToken as string).split(".");

    // ═══════════════════════════════════════════════════════════════════
    // ── DEPOSIT ────────────────────────────────────────────────────────
    // ═══════════════════════════════════════════════════════════════════
    if (action === "deposit") {
      const amountUstx = parseInt(opts.amountUstx, 10);
      if (!Number.isFinite(amountUstx) || amountUstx <= 0) {
        fail("bad_amount", "--amount-ustx must be a positive integer", "Supply the deposit amount in uSTX (1 STX = 1_000_000 uSTX)");
        wm.lock();
        return;
      }
      const capPerOp = Math.min(
        HARD_CAP_PER_DEPOSIT_USTX,
        parseInt(opts.maxDepositUstx, 10) || HARD_CAP_PER_DEPOSIT_USTX
      );
      if (amountUstx > capPerOp) {
        blocked("exceeds_per_op_cap", `amount ${amountUstx} uSTX > per-op cap ${capPerOp} uSTX`, "Reduce --amount-ustx");
        wm.lock();
        return;
      }
      if (ledger.totalUstxMoved + amountUstx > HARD_CAP_DAILY_USTX) {
        blocked("exceeds_daily_cap", `deposit would push daily volume over ${HARD_CAP_DAILY_USTX} uSTX`, "Wait for daily cap reset");
        wm.lock();
        return;
      }
      const reserve = !Number.isNaN(parseInt(opts.reserveUstx, 10)) ? parseInt(opts.reserveUstx, 10) : DEFAULT_RESERVE_USTX;
      if (stxBal - amountUstx < reserve + minGas) {
        blocked(
          "reserve_violation",
          `post-deposit STX ${stxBal - amountUstx} uSTX < reserve ${reserve} + gas ${minGas}`,
          "Lower --amount-ustx or --reserve-ustx"
        );
        wm.lock();
        return;
      }

      // Slippage gate
      const expectedRate = BigInt(opts.expectedRateUstxPerStstx || "0");
      if (expectedRate <= 0n) {
        fail("expected_rate_missing", "--expected-rate-ustx-per-ststx required", "Run `status` to get live rate first");
        wm.lock();
        return;
      }
      const liveRate = await getStxPerStstx(opts.reserveContract, opts.dataCore, wallet);
      if (liveRate === null || liveRate <= 0n) {
        fail("rate_read_failed", "Could not read live stx-per-ststx from core contract", "Check Hiro API reachability");
        wm.lock();
        return;
      }
      const deviationBps = Number(((liveRate - expectedRate) * 10_000n) / (expectedRate === 0n ? 1n : expectedRate));
      const absDev = Math.abs(deviationBps);
      if (absDev > slippageBps) {
        blocked(
          "rate_slippage_exceeded",
          `Current rate ${liveRate} deviates ${absDev} bps from expected ${expectedRate} (max ${slippageBps} bps)`,
          "Run `status` to refresh rate and resubmit"
        );
        wm.lock();
        return;
      }

      const expectedStstx = (BigInt(amountUstx) * 1_000_000n) / liveRate;

      const callOptions: ContractCallOptions = {
        contractAddress: coreAddr,
        contractName: coreName,
        functionName: "deposit",
        functionArgs: [
          contractPrincipalCV(resAddr, resName),
          contractPrincipalCV(comAddr, comName),
          contractPrincipalCV(stakeAddr, stakeName),
          contractPrincipalCV(dhAddr, dhName),
          uintCV(amountUstx),
          noneCV(),
          noneCV(),
        ],
        postConditionMode: PostConditionMode.Deny,
        postConditions: [
          Pc.principal(wallet).willSendLte(amountUstx).ustx(),
        ],
      };

      if (opts.dryRun) {
        const { signedTx, txid } = await signContractCall(account, callOptions);
        out("success", "Dry-run: deposit transaction signed (not broadcast)", {
          operation: "deposit",
          wallet,
          txid,
          signed_tx_preview: signedTx.slice(0, 64) + "…",
          amount_ustx: amountUstx,
          live_stx_per_ststx: liveRate.toString(),
          estimated_ststx_minted: expectedStstx.toString(),
          slippage_bps_observed: absDev,
        });
        wm.lock();
        return;
      }

      let txid: string;
      try {
        const result = await callContract(account, callOptions);
        txid = result.txid;
      } catch (e: any) {
        fail("broadcast_failed", e.message, "Check balance, contract parameters, and network");
        wm.lock();
        return;
      }
      wm.lock();

      const finalStatus = await awaitConfirmation(txid);

      if (finalStatus !== "failed") {
        ledger.lastEpoch[action] = now;
        ledger.totalUstxMoved += amountUstx;
        ledger.entries.push({ ts: new Date().toISOString(), action, amount: amountUstx, txid });
        saveLedger(ledger);
      }

      if (finalStatus === "success") {
        out("success", "Deposit broadcast and confirmed on Stacks mainnet", {
          operation: "deposit",
          wallet,
          txid,
          explorer_url: `https://explorer.hiro.so/txid/0x${txid}?chain=mainnet`,
          tx_status: "success",
          amount_ustx: amountUstx,
          live_stx_per_ststx: liveRate.toString(),
          estimated_ststx_minted: expectedStstx.toString(),
          slippage_bps_observed: absDev,
          safety_checks: {
            mainnet_wallet: true,
            within_per_op_cap: true,
            within_daily_cap: true,
            reserve_preserved: true,
            gas_preserved: true,
            cooldown_clear: true,
            slippage_within_tolerance: true,
            confirm_token_matched: true,
            post_condition_mode: "deny",
          },
        });
      } else if (finalStatus === "failed") {
        fail("tx_failed", `Transaction 0x${txid} failed on-chain`, `Check https://explorer.hiro.so/txid/0x${txid}?chain=mainnet`);
      } else {
        out("success", "Deposit broadcast — awaiting confirmation (polling timed out)", {
          operation: "deposit",
          wallet,
          txid,
          explorer_url: `https://explorer.hiro.so/txid/0x${txid}?chain=mainnet`,
          tx_status: "pending",
          note: "Transaction was broadcast. Check the explorer for final status.",
          amount_ustx: amountUstx,
        });
      }
      return;
    }

    // ═══════════════════════════════════════════════════════════════════
    // ── INIT-WITHDRAW ─────────────────────────────────────────────────
    // ═══════════════════════════════════════════════════════════════════
    if (action === "init-withdraw") {
      const amountStstx = parseInt(opts.amountStstx, 10);
      if (!Number.isFinite(amountStstx) || amountStstx <= 0) {
        fail("bad_amount", "--amount-ststx must be a positive integer", "Supply the withdraw amount in stSTX micro-units");
        wm.lock();
        return;
      }
      const capPerOp = Math.min(
        HARD_CAP_PER_WITHDRAW_STSTX,
        parseInt(opts.maxWithdrawStstx, 10) || HARD_CAP_PER_WITHDRAW_STSTX
      );
      if (amountStstx > capPerOp) {
        blocked("exceeds_per_op_cap", `amount ${amountStstx} stSTX > per-op cap ${capPerOp}`, "Reduce --amount-ststx");
        wm.lock();
        return;
      }

      const ststxBal = await getTokenBalance(wallet, opts.ststxToken);
      if (ststxBal < amountStstx) {
        blocked("insufficient_ststx", `stSTX balance ${ststxBal} < requested ${amountStstx}`, "Reduce --amount-ststx to at most wallet balance");
        wm.lock();
        return;
      }

      const expectedRate = BigInt(opts.expectedRateUstxPerStstx || "0");
      if (expectedRate <= 0n) {
        fail("expected_rate_missing", "--expected-rate-ustx-per-ststx required", "Run `status` to get live rate first");
        wm.lock();
        return;
      }
      const liveRate = await getStxPerStstx(opts.reserveContract, opts.dataCore, wallet);
      if (liveRate === null || liveRate <= 0n) {
        fail("rate_read_failed", "Could not read live stx-per-ststx", "Check Hiro API and contract principals");
        wm.lock();
        return;
      }
      const deviationBps = Number(((liveRate - expectedRate) * 10_000n) / (expectedRate === 0n ? 1n : expectedRate));
      const absDev = Math.abs(deviationBps);
      if (absDev > slippageBps) {
        blocked(
          "rate_slippage_exceeded",
          `Current rate ${liveRate} deviates ${absDev} bps from expected ${expectedRate} (max ${slippageBps} bps)`,
          "Re-read rate with `status` and resubmit"
        );
        wm.lock();
        return;
      }

      if (ledger.totalUstxMoved + amountStstx > HARD_CAP_DAILY_USTX) {
        blocked("exceeds_daily_cap", "init-withdraw would push daily volume over cap", "Wait for cap reset");
        wm.lock();
        return;
      }

      const queuedStxValue = (BigInt(amountStstx) * liveRate) / 1_000_000n;

      const callOptions: ContractCallOptions = {
        contractAddress: coreAddr,
        contractName: coreName,
        functionName: "init-withdraw",
        functionArgs: [
          contractPrincipalCV(resAddr, resName),
          contractPrincipalCV(dhAddr, dhName),
          uintCV(amountStstx),
        ],
        postConditionMode: PostConditionMode.Deny,
        postConditions: [
          Pc.principal(wallet).willSendLte(amountStstx).ft(`${stxTokAddr}.${stxTokName}`, "ststx"),
        ],
      };

      if (opts.dryRun) {
        const { signedTx, txid } = await signContractCall(account, callOptions);
        out("success", "Dry-run: init-withdraw transaction signed (not broadcast)", {
          operation: "init-withdraw",
          wallet,
          txid,
          signed_tx_preview: signedTx.slice(0, 64) + "…",
          amount_ststx: amountStstx,
          queued_stx_value_ustx: queuedStxValue.toString(),
          live_stx_per_ststx: liveRate.toString(),
        });
        wm.lock();
        return;
      }

      let txid: string;
      try {
        const result = await callContract(account, callOptions);
        txid = result.txid;
      } catch (e: any) {
        fail("broadcast_failed", e.message, "Check stSTX balance, contract parameters, and network");
        wm.lock();
        return;
      }
      wm.lock();

      const finalStatus = await awaitConfirmation(txid);

      if (finalStatus !== "failed") {
        ledger.lastEpoch[action] = now;
        ledger.totalUstxMoved += amountStstx;
        ledger.entries.push({ ts: new Date().toISOString(), action, amount: amountStstx, txid });
        saveLedger(ledger);
      }

      if (finalStatus === "success") {
        out("success", "Init-withdraw broadcast and confirmed — NFT ticket minted", {
          operation: "init-withdraw",
          wallet,
          txid,
          explorer_url: `https://explorer.hiro.so/txid/0x${txid}?chain=mainnet`,
          tx_status: "success",
          amount_ststx: amountStstx,
          queued_stx_value_ustx: queuedStxValue.toString(),
          live_stx_per_ststx: liveRate.toString(),
          slippage_bps_observed: absDev,
          notes: [
            "Run `status` to find the new NFT ticket id.",
            "Ticket matures in ~1 PoX cycle (~2 weeks). Check `status` > withdrawal_tickets > matured.",
          ],
          safety_checks: {
            mainnet_wallet: true,
            sufficient_ststx: true,
            within_per_op_cap: true,
            within_daily_cap: true,
            cooldown_clear: true,
            slippage_within_tolerance: true,
            confirm_token_matched: true,
            post_condition_mode: "deny",
          },
        });
      } else if (finalStatus === "failed") {
        fail("tx_failed", `Transaction 0x${txid} failed on-chain`, `Check https://explorer.hiro.so/txid/0x${txid}?chain=mainnet`);
      } else {
        out("success", "Init-withdraw broadcast — awaiting confirmation (polling timed out)", {
          operation: "init-withdraw",
          wallet,
          txid,
          explorer_url: `https://explorer.hiro.so/txid/0x${txid}?chain=mainnet`,
          tx_status: "pending",
          amount_ststx: amountStstx,
        });
      }
      return;
    }

    // ═══════════════════════════════════════════════════════════════════
    // ── WITHDRAW (CLAIM MATURED TICKET) ───────────────────────────────
    // ═══════════════════════════════════════════════════════════════════
    if (action === "withdraw") {
      const nftId = parseInt(opts.id, 10);
      if (!Number.isFinite(nftId) || nftId <= 0) {
        fail("bad_id", "--id must be a positive integer NFT id", "Get ids from `status` > withdrawal_tickets");
        wm.lock();
        return;
      }

      const tickets = await getWithdrawalTickets(wallet, opts.withdrawNft);
      const owned = tickets.find((t) => t.id === nftId);
      if (!owned) {
        blocked(
          "ticket_not_owned",
          `Wallet ${wallet} does not hold withdrawal ticket #${nftId}`,
          "Confirm --id matches an NFT held by the active wallet"
        );
        wm.lock();
        return;
      }

      const [ticketCycle, currentCycle] = await Promise.all([
        getTicketCycle("SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.data-core-v1", nftId, wallet),
        getCurrentPoxCycle(opts.core, wallet),
      ]);
      if (ticketCycle === null || currentCycle === null) {
        fail("cycle_read_failed", "Could not read ticket maturity cycle or current PoX cycle", "Check Hiro API and core contract");
        wm.lock();
        return;
      }
      if (currentCycle <= ticketCycle) {
        blocked(
          "ticket_not_matured",
          `Ticket #${nftId} matures in cycle ${ticketCycle}; current PoX cycle is ${currentCycle}`,
          `Wait until cycle > ${ticketCycle} before withdrawing`
        );
        wm.lock();
        return;
      }

      const callOptions: ContractCallOptions = {
        contractAddress: coreAddr,
        contractName: coreName,
        functionName: "withdraw",
        functionArgs: [
          contractPrincipalCV(resAddr, resName),
          contractPrincipalCV(comAddr, comName),
          contractPrincipalCV(stakeAddr, stakeName),
          uintCV(nftId),
        ],
        postConditionMode: PostConditionMode.Deny,
        postConditions: [
          Pc.principal(wallet).willSendAsset().nft(opts.withdrawNft as string, "ststx-withdraw-nft", uintCV(nftId)),
        ],
      };

      if (opts.dryRun) {
        const { signedTx, txid } = await signContractCall(account, callOptions);
        out("success", "Dry-run: withdraw transaction signed (not broadcast)", {
          operation: "withdraw",
          wallet,
          txid,
          signed_tx_preview: signedTx.slice(0, 64) + "…",
          nft_id: nftId,
          ticket_cycle: ticketCycle,
          current_cycle: currentCycle,
        });
        wm.lock();
        return;
      }

      let txid: string;
      try {
        const result = await callContract(account, callOptions);
        txid = result.txid;
      } catch (e: any) {
        fail("broadcast_failed", e.message, "Check NFT ownership, cycle maturity, and network");
        wm.lock();
        return;
      }
      wm.lock();

      const finalStatus = await awaitConfirmation(txid);

      if (finalStatus !== "failed") {
        ledger.lastEpoch[action] = now;
        ledger.entries.push({ ts: new Date().toISOString(), action, amount: nftId, txid });
        saveLedger(ledger);
      }

      if (finalStatus === "success") {
        out("success", "Withdraw broadcast and confirmed — STX claimed from matured ticket", {
          operation: "withdraw",
          wallet,
          txid,
          explorer_url: `https://explorer.hiro.so/txid/0x${txid}?chain=mainnet`,
          tx_status: "success",
          nft_id: nftId,
          ticket_cycle: ticketCycle,
          current_cycle: currentCycle,
          safety_checks: {
            mainnet_wallet: true,
            ticket_ownership_verified: true,
            ticket_matured: true,
            cooldown_clear: true,
            confirm_token_matched: true,
            post_condition_mode: "deny",
          },
        });
      } else if (finalStatus === "failed") {
        fail("tx_failed", `Transaction 0x${txid} failed on-chain`, `Check https://explorer.hiro.so/txid/0x${txid}?chain=mainnet`);
      } else {
        out("success", "Withdraw broadcast — awaiting confirmation (polling timed out)", {
          operation: "withdraw",
          wallet,
          txid,
          explorer_url: `https://explorer.hiro.so/txid/0x${txid}?chain=mainnet`,
          tx_status: "pending",
          nft_id: nftId,
        });
      }
      return;
    }
  });

program.parse();

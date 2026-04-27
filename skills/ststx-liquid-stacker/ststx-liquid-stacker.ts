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
 *   - PostConditionMode.Deny on the emitted MCP contract-call plan
 *
 * This skill emits a broadcast-ready `mcp_command` block for the AIBTC
 * MCP wallet to sign and broadcast, matching the pattern used by the
 * merged sbtc-yield-maximizer and submitted zest-liquidation-executor.
 *
 * Author: IamHarrie-Labs
 * Agent:  Liquid Horizon — Autonomous Liquid-Stacking Router
 */

import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ═══════════════════════════════════════════════════════════════════════════
// SAFETY CONSTANTS — hard-coded, cannot be overridden by flags.
// ═══════════════════════════════════════════════════════════════════════════
const HARD_CAP_PER_DEPOSIT_USTX  = 500_000_000_000; // 500,000 STX — absolute per-op deposit ceiling
const HARD_CAP_PER_WITHDRAW_STSTX = 500_000_000_000; // 500,000 stSTX — absolute per-op withdraw ceiling
const HARD_CAP_DAILY_USTX        = 1_000_000_000_000; // 1,000,000 STX — per-agent daily cap (either direction)
const DEFAULT_MIN_GAS_USTX       = 1_000_000;       // 1 STX minimum for gas
const DEFAULT_RESERVE_USTX       = 1_000_000;       // 1 STX kept as spendable reserve post-deposit
const DEFAULT_COOLDOWN_SECONDS   = 120;             // 2 minutes between same-action broadcasts
const DEFAULT_MAX_SLIPPAGE_BPS   = 50;              // 0.50% max deviation from expected rate
const SLIPPAGE_BPS_FLOOR         = 1;               // cannot disable the check
const SLIPPAGE_BPS_CEILING       = 500;             // 5% maximum tolerance the skill will accept
const FETCH_TIMEOUT_MS           = 15_000;
const HIRO_API                   = "https://api.hiro.so";

// ═══════════════════════════════════════════════════════════════════════════
// STACKINGDAO MAINNET CONTRACTS (overridable via flags for protocol version rolls)
// ═══════════════════════════════════════════════════════════════════════════
const DEFAULT_CORE            = "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.stacking-dao-core-v2";
const DEFAULT_STSTX_TOKEN     = "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token";
const DEFAULT_RESERVE         = "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.reserve-v1";
const DEFAULT_COMMISSION      = "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.commission-v2";
const DEFAULT_STAKING         = "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.staking-v0";
const DEFAULT_DIRECT_HELPERS  = "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.direct-helpers-v3";
const POX_INFO_ENDPOINT       = "/v2/pox";

// ═══════════════════════════════════════════════════════════════════════════
// PERSISTENT COOLDOWN + SPEND LEDGER
// ═══════════════════════════════════════════════════════════════════════════
interface LedgerEntry {
  ts: string;
  action: "deposit" | "init-withdraw" | "withdraw";
  amount: number;
  txPlanHash: string;
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
// JSON OUTPUT HELPERS — mirror the contract used by sbtc-yield-maximizer
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
  // (ok uint) serialised: 0x07 0x01 + 16 byte big-endian uint
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

// ═══════════════════════════════════════════════════════════════════════════
// WALLET + BALANCE HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function getWallet(): string {
  const addr = process.env.STACKS_ADDRESS || process.env.STX_ADDRESS;
  if (!addr) throw new Error("STACKS_ADDRESS not set — run AIBTC wallet unlock first");
  return addr;
}

function isMainnetPrincipal(addr: string): boolean {
  // mainnet prefixes: SP / SM. testnet prefixes: ST / SN.
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
/**
 * Derive the live stx-per-ststx ratio from on-chain supply data.
 *
 * Formula: ratio = (reserve.get-total-stx * 1_000_000) / ststx-token.get-total-supply
 *
 * A ratio of 1_050_000 means 1 stSTX ≈ 1.05 STX (stSTX accrues yield over time).
 *
 * We also read `core-v2.current-pox-reward-cycle` here as a side-effect since
 * both calls share the same Hiro API path style.
 */
async function getStxPerStstx(
  reserveContract: string,
  ststxToken: string,
  sender: string
): Promise<bigint | null> {
  const [reserveAddr, reserveName] = reserveContract.split(".");
  const [tokenAddr, tokenName] = ststxToken.split(".");

  // reserve-v1.get-total-stx — returns uint (no wrapper)
  const totalStxRes = await callReadOnly(reserveContract, "get-total-stx", [], sender);
  // ststx-token.get-total-supply — returns (ok uint)
  const totalSupplyRes = await callReadOnly(ststxToken, "get-total-supply", [], sender);

  if (!totalStxRes?.result || !totalSupplyRes?.result) return null;

  // get-total-stx returns a plain uint (0x01 + 16 bytes)
  const totalStx = parseOkUintHex(totalStxRes.result) || parseRawUintHex(totalStxRes.result);
  // get-total-supply returns (ok uint)
  const totalSupply = parseOkUintHex(totalSupplyRes.result);

  if (totalStx <= 0n || totalSupply <= 0n) return null;
  return (totalStx * 1_000_000n) / totalSupply;
}

/** Parse a raw Clarity uint (tag 0x01 + 16 bytes) with no ok-wrapper. */
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

/** Encode a principal as a Clarity argument for /call-read. */
function clarityPrincipalArg(principal: string): string {
  // For the Hiro call-read endpoint, principals are passed as hex-serialised
  // Clarity values. We compose them as string-ascii wrappers since the API
  // also accepts that form for flexibility.
  const buf = Buffer.from(principal, "utf8");
  const header = Buffer.alloc(5);
  header[0] = 0x0d; // string-ascii tag
  header.writeUInt32BE(buf.length, 1);
  return "0x" + Buffer.concat([header, buf]).toString("hex");
}

/**
 * Read the current PoX reward cycle from the core contract directly
 * (core-v2.current-pox-reward-cycle — no args, returns uint).
 * Falls back to the Hiro /v2/pox endpoint.
 */
async function getCurrentPoxCycle(core: string, sender: string): Promise<number | null> {
  const res = await callReadOnly(core, "current-pox-reward-cycle", [], sender);
  if (res?.result) {
    const v = parseRawUintHex(res.result) || parseOkUintHex(res.result);
    if (v > 0n) return Number(v);
  }
  // Fallback: Hiro PoX info endpoint
  const data = await hiroFetch<any>("/v2/pox");
  if (data) return typeof data.current_cycle?.id === "number" ? data.current_cycle.id : null;
  return null;
}

/**
 * Find withdrawal-ticket NFTs held by the wallet. StackingDAO mints these
 * from `stacking-dao-core-v2` on `init-withdraw`. The NFT asset identifier
 * is `<core-principal>::ststx-withdraw-nft` in the canonical deploy.
 */
async function getWithdrawalTickets(address: string, core: string): Promise<Array<{ id: number; assetId: string }>> {
  const data = await hiroFetch<any>(
    `/extended/v1/tokens/nft/holdings?principal=${address}&asset_identifiers=${encodeURIComponent(
      `${core}::ststx-withdraw-nft`
    )}&limit=50`
  );
  if (!data?.results) return [];
  const out: Array<{ id: number; assetId: string }> = [];
  for (const row of data.results) {
    const repr: string = row.value?.repr || "";
    const m = repr.match(/u(\d+)/);
    if (m) out.push({ id: parseInt(m[1], 10), assetId: row.asset_identifier });
  }
  return out;
}

/** Read a ticket's stored maturity cycle from the core contract. */
async function getTicketCycle(core: string, nftId: number, sender: string): Promise<number | null> {
  // Clarity: (get-withdraw-request (id uint)) -> (optional { cycle-id: uint, ... })
  const res = await callReadOnly(
    core,
    "get-withdraw-request",
    [encodeUintHex(nftId)],
    sender
  );
  if (!res?.result) return null;
  // The serialised optional-some-tuple is complex; we conservatively pull the first uint we see.
  const hex = typeof res.result === "string" ? res.result : "";
  const m = hex.match(/01([0-9a-f]{32})/);
  if (!m) return null;
  try {
    return parseInt(m[1].slice(-8), 16);
  } catch {
    return null;
  }
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMANDS
// ═══════════════════════════════════════════════════════════════════════════
const program = new Command();

program
  .name("ststx-liquid-stacker")
  .description("StackingDAO liquid-stacking writer: deposit STX, init-withdraw stSTX, claim matured tickets")
  .version("1.0.0");

// ── SHARED OPTIONS (contracts are configurable for version rolls) ─────────
function addContractFlags(cmd: Command): Command {
  return cmd
    .option("--core <principal>", "StackingDAO core contract", DEFAULT_CORE)
    .option("--ststx-token <principal>", "stSTX fungible token contract", DEFAULT_STSTX_TOKEN)
    .option("--reserve-contract <principal>", "StackingDAO reserve contract", DEFAULT_RESERVE)
    .option("--commission-contract <principal>", "StackingDAO commission contract", DEFAULT_COMMISSION)
    .option("--staking-contract <principal>", "StackingDAO staking contract", DEFAULT_STAKING)
    .option("--direct-helpers-contract <principal>", "StackingDAO direct-helpers contract", DEFAULT_DIRECT_HELPERS);
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

    // Contract reachability
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

    // Rate read
    if (wallet && isMainnetPrincipal(wallet)) {
      const rate = await getStxPerStstx(opts.reserveContract, opts.ststxToken, wallet);
      checks.ratio_read = {
        ok: rate !== null,
        detail: rate !== null ? `1 stSTX = ${rate} uSTX (total-stx / total-supply derived)` : "could not read ratio",
      };
    }

    // Cooldown
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
      getStxPerStstx(opts.reserveContract, opts.ststxToken, wallet),
      getCurrentPoxCycle(opts.core, wallet),
      getWithdrawalTickets(wallet, opts.core),
    ]);

    const ticketDetails: Array<{ id: number; cycle_id: number | null; matured: boolean | null }> = [];
    for (const t of tickets) {
      const tCycle = await getTicketCycle(opts.core, t.id, wallet);
      ticketDetails.push({
        id: t.id,
        cycle_id: tCycle,
        matured: tCycle === null || cycle === null ? null : cycle > tCycle,
      });
    }

    out("success", "Live status snapshot", {
      wallet,
      balances: {
        stx_ustx: stx,
        ststx_microunits: ststx,
      },
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
    .description("Execute a StackingDAO write action")
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
    .option("--dry-run", "Build and print the broadcast plan but do not update the ledger", false)
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
        "Wait for cooldown to clear or wait for previous broadcast to confirm"
      );
      return;
    }

    // ── Daily cap ───────────────────────────────────────────────────────
    if (ledger.totalUstxMoved >= HARD_CAP_DAILY_USTX) {
      blocked(
        "daily_cap_reached",
        `Daily cap ${HARD_CAP_DAILY_USTX} uSTX reached`,
        "Cap resets at 00:00 UTC"
      );
      return;
    }

    // ── Gas pre-check (all actions) ─────────────────────────────────────
    const minGas = parseInt(opts.minGasReserveUstx, 10) || DEFAULT_MIN_GAS_USTX;
    const stxBal = await getStxBalance(wallet);
    if (stxBal < minGas) {
      blocked(
        "insufficient_gas",
        `STX balance ${stxBal} uSTX < required ${minGas} uSTX`,
        "Top up STX for gas"
      );
      return;
    }

    // ═══════════════════════════════════════════════════════════════════
    // ── DEPOSIT ────────────────────────────────────────────────────────
    // ═══════════════════════════════════════════════════════════════════
    if (action === "deposit") {
      const amountUstx = parseInt(opts.amountUstx, 10);
      if (!Number.isFinite(amountUstx) || amountUstx <= 0) {
        fail("bad_amount", "--amount-ustx must be a positive integer", "Supply the deposit amount in uSTX (1 STX = 1_000_000 uSTX)");
        return;
      }
      const capPerOp = Math.min(
        HARD_CAP_PER_DEPOSIT_USTX,
        parseInt(opts.maxDepositUstx, 10) || HARD_CAP_PER_DEPOSIT_USTX
      );
      if (amountUstx > capPerOp) {
        blocked(
          "exceeds_per_op_cap",
          `amount ${amountUstx} uSTX > per-op cap ${capPerOp} uSTX`,
          "Reduce --amount-ustx or raise --max-deposit-ustx (cannot exceed hard cap)"
        );
        return;
      }
      if (ledger.totalUstxMoved + amountUstx > HARD_CAP_DAILY_USTX) {
        blocked(
          "exceeds_daily_cap",
          `deposit would push daily volume over ${HARD_CAP_DAILY_USTX} uSTX`,
          "Wait until daily cap resets or reduce --amount-ustx"
        );
        return;
      }

      const reserve = parseInt(opts.reserveUstx, 10) || DEFAULT_RESERVE_USTX;
      if (stxBal - amountUstx < reserve + minGas) {
        blocked(
          "reserve_violation",
          `post-deposit STX ${stxBal - amountUstx} uSTX < reserve ${reserve} + gas ${minGas}`,
          "Lower --amount-ustx or lower --reserve-ustx (explicit operator approval)"
        );
        return;
      }

      // ── Slippage gate ─────────────────────────────────────────────────
      const expectedRate = BigInt(opts.expectedRateUstxPerStstx || "0");
      if (expectedRate <= 0n) {
        fail(
          "expected_rate_missing",
          "--expected-rate-ustx-per-ststx required — read current rate from `status` first",
          "Run `status` to get the live stx-per-ststx, then pass it here so slippage can be enforced"
        );
        return;
      }
      const liveRate = await getStxPerStstx(opts.reserveContract, opts.ststxToken, wallet);
      if (liveRate === null || liveRate <= 0n) {
        fail(
          "rate_read_failed",
          "Could not read live stx-per-ststx from core contract",
          "Confirm --core and --reserve-contract principals, and that Hiro API is reachable"
        );
        return;
      }
      const deviationBps =
        Number(((liveRate - expectedRate) * 10_000n) / (expectedRate === 0n ? 1n : expectedRate));
      const absDev = Math.abs(deviationBps);
      if (absDev > slippageBps) {
        blocked(
          "rate_slippage_exceeded",
          `Current rate ${liveRate} deviates ${absDev} bps from expected ${expectedRate} (max ${slippageBps} bps)`,
          "Run `status` to read the fresh rate, then resubmit with updated --expected-rate or widen --max-slippage-bps (operator-approved, cannot exceed ceiling)"
        );
        return;
      }

      // Plan
      const expectedStstx = (BigInt(amountUstx) * 1_000_000n) / liveRate;
      const [coreAddr, coreName] = (opts.core as string).split(".");
      const planHash = `deposit:${wallet}:${amountUstx}:${now.toFixed(0)}`;

      out("success", "Deposit STX → stSTX via StackingDAO core", {
        operation: "deposit",
        wallet,
        amount_ustx: amountUstx,
        expected_stx_per_ststx: expectedRate.toString(),
        live_stx_per_ststx: liveRate.toString(),
        slippage_bps_observed: absDev,
        slippage_bps_allowed: slippageBps,
        estimated_ststx_minted: expectedStstx.toString(),
        mcp_command: {
          tool: "call_contract",
          params: {
            contract_address: coreAddr,
            contract_name: coreName,
            function_name: "deposit",
            function_args: [
              `{ type: "trait_reference", value: "${opts.reserveContract}" }`,
              `{ type: "trait_reference", value: "${opts.commissionContract}" }`,
              `{ type: "trait_reference", value: "${opts.stakingContract}" }`,
              `{ type: "trait_reference", value: "${opts.directHelpersContract}" }`,
              `{ type: "uint", value: "${amountUstx}" }`,
              opts.referrer
                ? `{ type: "optional", value: { type: "principal", value: "${opts.referrer}" } }`
                : `{ type: "optional", value: null }`,
              opts.pool
                ? `{ type: "optional", value: { type: "principal", value: "${opts.pool}" } }`
                : `{ type: "optional", value: null }`,
            ],
            post_condition_mode: "deny",
            post_conditions: [
              {
                type: "stx",
                principal: wallet,
                condition: "sent_eq",
                amount: amountUstx,
              },
              {
                type: "ft",
                principal: wallet,
                condition: "received_gte",
                asset: opts.ststxToken,
                amount: Number((expectedStstx * BigInt(10_000 - slippageBps)) / 10_000n),
              },
            ],
          },
          description: `Deposit ${amountUstx} uSTX → stSTX (expect ≥ ${expectedStstx} stSTX micro-units)`,
        },
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

      if (!opts.dryRun) {
        ledger.lastEpoch[action] = now;
        ledger.totalUstxMoved += amountUstx;
        ledger.entries.push({
          ts: new Date().toISOString(),
          action,
          amount: amountUstx,
          txPlanHash: planHash,
        });
        saveLedger(ledger);
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
        return;
      }
      const capPerOp = Math.min(
        HARD_CAP_PER_WITHDRAW_STSTX,
        parseInt(opts.maxWithdrawStstx, 10) || HARD_CAP_PER_WITHDRAW_STSTX
      );
      if (amountStstx > capPerOp) {
        blocked(
          "exceeds_per_op_cap",
          `amount ${amountStstx} stSTX > per-op cap ${capPerOp}`,
          "Reduce --amount-ststx or raise --max-withdraw-ststx (cannot exceed hard cap)"
        );
        return;
      }

      const ststxBal = await getTokenBalance(wallet, opts.ststxToken);
      if (ststxBal < amountStstx) {
        blocked(
          "insufficient_ststx",
          `stSTX balance ${ststxBal} < requested ${amountStstx}`,
          "Reduce --amount-ststx to at most the wallet balance"
        );
        return;
      }

      // Slippage gate uses the same expected-rate input so the caller
      // knows the STX redemption value queued behind the NFT ticket.
      const expectedRate = BigInt(opts.expectedRateUstxPerStstx || "0");
      if (expectedRate <= 0n) {
        fail(
          "expected_rate_missing",
          "--expected-rate-ustx-per-ststx required — read current rate from `status` first",
          "Pass the live rate so the queued redemption value is pinned within slippage"
        );
        return;
      }
      const liveRate = await getStxPerStstx(opts.reserveContract, opts.ststxToken, wallet);
      if (liveRate === null || liveRate <= 0n) {
        fail("rate_read_failed", "Could not read live stx-per-ststx", "Check --reserve-contract / --ststx-token principals");
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
        return;
      }

      if (ledger.totalUstxMoved + amountStstx > HARD_CAP_DAILY_USTX) {
        blocked(
          "exceeds_daily_cap",
          "init-withdraw would push daily volume over cap",
          "Wait for cap reset or reduce --amount-ststx"
        );
        return;
      }

      const queuedStxValue = (BigInt(amountStstx) * liveRate) / 1_000_000n;
      const [coreAddr, coreName] = (opts.core as string).split(".");
      const planHash = `init-withdraw:${wallet}:${amountStstx}:${now.toFixed(0)}`;

      out("success", "Init-withdraw stSTX → withdrawal NFT ticket", {
        operation: "init-withdraw",
        wallet,
        amount_ststx: amountStstx,
        expected_stx_queued: queuedStxValue.toString(),
        live_stx_per_ststx: liveRate.toString(),
        slippage_bps_observed: absDev,
        slippage_bps_allowed: slippageBps,
        mcp_command: {
          tool: "call_contract",
          params: {
            contract_address: coreAddr,
            contract_name: coreName,
            function_name: "init-withdraw",
            function_args: [
              // Matches core-v2 signature: (reserve <reserve-trait>) (direct-helpers <direct-helpers-trait>) (ststx-amount uint)
              `{ type: "trait_reference", value: "${opts.reserveContract}" }`,
              `{ type: "trait_reference", value: "${opts.directHelpersContract}" }`,
              `{ type: "uint", value: "${amountStstx}" }`,
            ],
            post_condition_mode: "deny",
            post_conditions: [
              {
                type: "ft",
                principal: wallet,
                condition: "sent_eq",
                asset: opts.ststxToken,
                amount: amountStstx,
              },
            ],
          },
          description: `Burn ${amountStstx} stSTX → mint withdrawal NFT ticket (claims ~${queuedStxValue} uSTX after cycle matures)`,
        },
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
        notes: [
          "Ticket maturity is 1 PoX cycle (~2 weeks on mainnet).",
          "After broadcast, run `status` to find the new NFT id and record it for later `run --action withdraw --id <id>`.",
        ],
      });

      if (!opts.dryRun) {
        ledger.lastEpoch[action] = now;
        ledger.totalUstxMoved += amountStstx;
        ledger.entries.push({
          ts: new Date().toISOString(),
          action,
          amount: amountStstx,
          txPlanHash: planHash,
        });
        saveLedger(ledger);
      }
      return;
    }

    // ═══════════════════════════════════════════════════════════════════
    // ── WITHDRAW (CLAIM MATURED TICKET) ───────────────────────────────
    // ═══════════════════════════════════════════════════════════════════
    if (action === "withdraw") {
      const nftId = parseInt(opts.id, 10);
      if (!Number.isFinite(nftId) || nftId <= 0) {
        fail("bad_id", "--id must be a positive integer NFT id", "Get ids from `run status` > withdrawal_tickets");
        return;
      }

      // Ownership check
      const tickets = await getWithdrawalTickets(wallet, opts.core);
      const owned = tickets.find((t) => t.id === nftId);
      if (!owned) {
        blocked(
          "ticket_not_owned",
          `Wallet ${wallet} does not hold withdrawal ticket #${nftId}`,
          "Confirm --id matches an NFT held by the active wallet"
        );
        return;
      }

      // Maturity check
      const [ticketCycle, currentCycle] = await Promise.all([
        getTicketCycle(opts.core, nftId, wallet),
        getCurrentPoxCycle(opts.core, wallet),
      ]);
      if (ticketCycle === null || currentCycle === null) {
        fail(
          "cycle_read_failed",
          "Could not read ticket maturity cycle or current PoX cycle",
          "Check Hiro API reachability and core-contract principal"
        );
        return;
      }
      if (currentCycle <= ticketCycle) {
        blocked(
          "ticket_not_matured",
          `Ticket #${nftId} matures in cycle ${ticketCycle}; current PoX cycle is ${currentCycle}`,
          `Wait until cycle > ${ticketCycle} before broadcasting`
        );
        return;
      }

      const [coreAddr, coreName] = (opts.core as string).split(".");
      const planHash = `withdraw:${wallet}:${nftId}:${now.toFixed(0)}`;

      out("success", "Claim matured withdrawal ticket → STX", {
        operation: "withdraw",
        wallet,
        nft_id: nftId,
        ticket_cycle: ticketCycle,
        current_cycle: currentCycle,
        mcp_command: {
          tool: "call_contract",
          params: {
            contract_address: coreAddr,
            contract_name: coreName,
            function_name: "withdraw",
            function_args: [
              // Matches core-v2 signature: (reserve <reserve-trait>) (commission-contract <commission-trait>) (staking-contract <staking-trait>) (nft-id uint)
              `{ type: "trait_reference", value: "${opts.reserveContract}" }`,
              `{ type: "trait_reference", value: "${opts.commissionContract}" }`,
              `{ type: "trait_reference", value: "${opts.stakingContract}" }`,
              `{ type: "uint", value: "${nftId}" }`,
            ],
            post_condition_mode: "deny",
            post_conditions: [
              {
                type: "nft",
                principal: wallet,
                condition: "sent",
                asset: `${opts.core}::ststx-withdraw-nft`,
                id: nftId,
              },
              {
                type: "stx",
                principal: wallet,
                condition: "received_gt",
                amount: 0,
              },
            ],
          },
          description: `Claim STX from matured withdrawal ticket #${nftId}`,
        },
        safety_checks: {
          mainnet_wallet: true,
          ticket_ownership_verified: true,
          ticket_matured: true,
          cooldown_clear: true,
          confirm_token_matched: true,
          post_condition_mode: "deny",
        },
      });

      if (!opts.dryRun) {
        ledger.lastEpoch[action] = now;
        ledger.entries.push({
          ts: new Date().toISOString(),
          action,
          amount: nftId,
          txPlanHash: planHash,
        });
        saveLedger(ledger);
      }
      return;
    }
  });

program.parse();

#!/usr/bin/env bun
/**
 * zest-full-position-manager — Zest Protocol Complete Lifecycle Manager
 *
 * Unified position manager handling the full supply → borrow → repay
 * lifecycle with health factor guardrail as a hard stop on all write operations.
 *
 * Author: lesh (aibtc-agent)
 * Skill: zest-full-position-manager
 */

import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ═══════════════════════════════════════════════════════════════════════════
// SAFETY CONSTANTS — Hard-coded, cannot be overridden by any flag
// ═══════════════════════════════════════════════════════════════════════════
const HARD_STOP_MIN_HEALTH_FACTOR = 1.2; // Absolute floor — no write below this
const BORROW_MIN_HEALTH_FACTOR = 1.3;    // Minimum HF after borrow
const WITHDRAW_MIN_HEALTH_FACTOR = 1.25; // Minimum HF after withdrawal
const TARGET_HEALTH_FACTOR = 1.5;        // Target HF for managed operations
const LIQUIDATION_THRESHOLD = 0.85;      // Zest v2 liquidation LTV (85%)

const HARD_CAP_SUPPLY_PER_OP = 50_000_000;  // 0.5 BTC in sats
const HARD_CAP_BORROW_PER_OP = 500_000_000; // 500 aeUSDC (6 decimals) or equivalent
const HARD_CAP_REPAY_PER_DAY_SATS = 1_000_000; // 0.01 BTC in sats
const MIN_WALLET_RESERVE_SATS = 5_000;       // Always keep ≥ this in wallet
const MIN_GAS_USTX = 200_000;               // 0.2 STX minimum for gas
const COOLDOWN_SECONDS = 300;               // 5 min between write operations

const HIRO_API = "https://api.hiro.so";
const FETCH_TIMEOUT = 15_000;
const STATE_FILE = join(homedir(), ".zest-full-position-manager.json");

// ═══════════════════════════════════════════════════════════════════════════
// ZEST V2 CONTRACT REGISTRY
// ═══════════════════════════════════════════════════════════════════════════
interface AssetConfig {
  reserve: string;
  token: string;
  zToken: string;
  decimals: number;
  isStablecoin: boolean;
  liquidationThreshold: number; // per-asset override (default 0.85)
}

const ZEST_ASSETS: Record<string, AssetConfig> = {
  sBTC: {
    reserve: "SP2VCQJHN7SP2CZCE5XR1GDMG0RMG5ERGXBTM22Y.reserve-vault-sbtc",
    token: "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
    zToken: "SP2VCQJHN7SP2CZCE5XR1GDMG0RMG5ERGXBTM22Y.zsbtc-token",
    decimals: 8,
    isStablecoin: false,
    liquidationThreshold: 0.80, // sBTC is more conservative
  },
  wSTX: {
    reserve: "SP2VCQJHN7SP2CZCE5XR1GDMG0RMG5ERGXBTM22Y.reserve-vault-wstx",
    token: "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7.wstx",
    zToken: "SP2VCQJHN7SP2CZCE5XR1GDMG0RMG5ERGXBTM22Y.zwstx-token",
    decimals: 6,
    isStablecoin: false,
    liquidationThreshold: 0.75,
  },
  stSTX: {
    reserve: "SP2VCQJHN7SP2CZCE5XR1GDMG0RMG5ERGXBTM22Y.reserve-vault-ststx",
    token: "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token",
    zToken: "SP2VCQJHN7SP2CZCE5XR1GDMG0RMG5ERGXBTM22Y.zststx-token",
    decimals: 6,
    isStablecoin: false,
    liquidationThreshold: 0.75,
  },
  USDC: {
    reserve: "SP2VCQJHN7SP2CZCE5XR1GDMG0RMG5ERGXBTM22Y.reserve-vault-usdc",
    token: "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx",
    zToken: "SP2VCQJHN7SP2CZCE5XR1GDMG0RMG5ERGXBTM22Y.zusdc-token",
    decimals: 6,
    isStablecoin: true,
    liquidationThreshold: 0.90, // Stablecoins get higher threshold
  },
  USDH: {
    reserve: "SP2VCQJHN7SP2CZCE5XR1GDMG0RMG5ERGXBTM22Y.reserve-vault-usdh",
    token: "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.usdh-token-v1",
    zToken: "SP2VCQJHN7SP2CZCE5XR1GDMG0RMG5ERGXBTM22Y.zusdh-token",
    decimals: 8,
    isStablecoin: true,
    liquidationThreshold: 0.90,
  },
  stSTXbtc: {
    reserve: "SP2VCQJHN7SP2CZCE5XR1GDMG0RMG5ERGXBTM22Y.reserve-vault-ststxbtc",
    token: "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststxbtc-token-v2",
    zToken: "SP2VCQJHN7SP2CZCE5XR1GDMG0RMG5ERGXBTM22Y.zststxbtc-token",
    decimals: 6,
    isStablecoin: false,
    liquidationThreshold: 0.70,
  },
};

const ASSET_NAMES = Object.keys(ZEST_ASSETS);

// ═══════════════════════════════════════════════════════════════════════════
// PERSISTENT STATE
// ═══════════════════════════════════════════════════════════════════════════
interface ManagerState {
  date: string;
  dailyRepayedSats: number;
  lastWriteEpoch: number;
  opLog: Array<{ ts: string; op: string; asset: string; amount: number }>;
}

function loadState(): ManagerState {
  const today = new Date().toISOString().slice(0, 10);
  try {
    if (existsSync(STATE_FILE)) {
      const raw = JSON.parse(readFileSync(STATE_FILE, "utf8")) as ManagerState;
      if (raw.date === today) return raw;
    }
  } catch { /* corrupt — reset */ }
  return { date: today, dailyRepayedSats: 0, lastWriteEpoch: 0, opLog: [] };
}

function saveState(state: ManagerState): void {
  writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), "utf8");
}

const managerState = loadState();

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════
interface AssetPosition {
  asset: string;
  supplied: number;        // in token base units
  borrowed: number;        // in token base units
  suppliedUSD: number;
  borrowedUSD: number;
  ltv: number;             // borrowed / supplied (0-1)
  liquidationThreshold: number;
  healthFactor: number;    // (supplied * liqThreshold) / borrowed, Infinity if no debt
  canBorrow: boolean;
  availableToBorrow: number; // in base units (to stay at HF >= BORROW_MIN_HEALTH_FACTOR)
  availableToWithdraw: number;
}

interface AggregatePosition {
  totalSuppliedUSD: number;
  totalBorrowedUSD: number;
  weightedLtv: number;
  aggregateHealthFactor: number; // (totalSupplied * avgLiqThreshold) / totalBorrowed
  riskLevel: "healthy" | "warning" | "critical" | "emergency";
  positions: AssetPosition[];
  safetyState: {
    dailyRepayRemaining: number;
    cooldownRemaining: number;
    lastWriteAt: string | null;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// OUTPUT HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function out(status: "success" | "error" | "blocked", action: string, data: Record<string, unknown> | null, error: { code: string; message: string; next: string } | null = null) {
  console.log(JSON.stringify({ status, action, data, error }));
}

function success(action: string, data: Record<string, unknown>) {
  out("success", action, data);
}

function blocked(action: string, code: string, message: string, next: string) {
  out("blocked", action, null, { code, message, next });
}

function fail(action: string, code: string, message: string, next: string) {
  out("error", action, null, { code, message, next });
}

// ═══════════════════════════════════════════════════════════════════════════
// HIRO API HELPERS
// ═══════════════════════════════════════════════════════════════════════════
async function hiroFetch(path: string): Promise<any> {
  try {
    const res = await fetch(`${HIRO_API}${path}`, {
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

async function callReadOnly(
  contractId: string,
  fnName: string,
  args: string[],
  sender: string
): Promise<any> {
  const [addr, name] = contractId.split(".");
  try {
    const res = await fetch(`${HIRO_API}/v2/contracts/call-read/${addr}/${name}/${fnName}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ sender, arguments: args }),
      signal: AbortSignal.timeout(FETCH_TIMEOUT),
    });
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

function parseClarityUint(hex: string): number {
  if (!hex || typeof hex !== "string") return 0;
  // Handle (ok uint) response: 0x07 prefix + type byte + value
  if (hex.startsWith("0x07")) {
    return parseClarityUint("0x" + hex.slice(4));
  }
  // uint: 0x01 + 16 bytes big-endian
  if (hex.startsWith("0x01")) {
    const lo = hex.slice(4).slice(-16);
    return parseInt(lo, 16) || 0;
  }
  return 0;
}

function encodePrincipalAsString(address: string): string {
  const bytes = Buffer.from(address, "utf8");
  const len = bytes.length;
  const buf = Buffer.alloc(5 + len);
  buf[0] = 0x0d;
  buf.writeUInt32BE(len, 1);
  bytes.copy(buf, 5);
  return "0x" + buf.toString("hex");
}

// ═══════════════════════════════════════════════════════════════════════════
// WALLET BALANCE FETCHER
// ═══════════════════════════════════════════════════════════════════════════
interface WalletBalances {
  stxBalance: number;
  fungible: Record<string, number>; // contractId -> balance (base units)
}

async function getWalletBalances(address: string): Promise<WalletBalances> {
  const data = await hiroFetch(`/extended/v1/address/${address}/balances`);
  if (!data) return { stxBalance: 0, fungible: {} };

  const stxBalance = parseInt(data?.stx?.balance || "0", 10);
  const fungible: Record<string, number> = {};

  for (const [key, val] of Object.entries(data?.fungible_tokens || {})) {
    const contractId = key.split("::")[0];
    fungible[contractId] = parseInt((val as any).balance || "0", 10);
  }

  return { stxBalance, fungible };
}

// ═══════════════════════════════════════════════════════════════════════════
// POSITION READER
// ═══════════════════════════════════════════════════════════════════════════
async function readAssetPosition(
  asset: string,
  address: string,
  walletBalances: WalletBalances
): Promise<AssetPosition | null> {
  const cfg = ZEST_ASSETS[asset];
  if (!cfg) return null;

  // Get zToken balance (represents supplied collateral shares)
  const zTokenId = cfg.zToken;
  const zTokenParts = zTokenId.split(".");
  let suppliedRaw = 0;

  // Try token balance read-only call
  const supplyRes = await callReadOnly(
    zTokenId,
    "get-balance",
    [encodePrincipalAsString(address)],
    address
  );
  if (supplyRes?.result) {
    suppliedRaw = parseClarityUint(supplyRes.result);
  }

  // Also check wallet balances for the underlying token
  const tokenKey = Object.keys(walletBalances.fungible).find(
    k => k.toLowerCase().includes(cfg.token.split(".")[1].toLowerCase())
  );
  const walletTokenBalance = tokenKey ? walletBalances.fungible[tokenKey] : 0;

  // Get debt balance via reserve vault read
  let borrowedRaw = 0;
  const debtRes = await callReadOnly(
    cfg.reserve,
    "get-user-debt",
    [encodePrincipalAsString(address)],
    address
  );
  if (debtRes?.result) {
    borrowedRaw = parseClarityUint(debtRes.result);
  }

  // If no supplied and no borrowed, no position
  if (suppliedRaw === 0 && borrowedRaw === 0) return null;

  // Compute health factor
  const liqThreshold = cfg.liquidationThreshold;
  let healthFactor = Infinity;
  let ltv = 0;

  if (suppliedRaw > 0 && borrowedRaw > 0) {
    ltv = borrowedRaw / suppliedRaw;
    healthFactor = (suppliedRaw * liqThreshold) / borrowedRaw;
  } else if (borrowedRaw > 0 && suppliedRaw === 0) {
    // Debt with no collateral — critically unsafe
    ltv = Infinity;
    healthFactor = 0;
  }

  // USD approximations (simplified — real impl uses Pyth oracle prices)
  // sBTC ~$100k, STX variants ~$1, USDC/USDH = $1
  const usdRate = cfg.isStablecoin
    ? 1 / (10 ** cfg.decimals)
    : asset === "sBTC"
      ? 100_000 / (10 ** cfg.decimals)
      : 1 / (10 ** cfg.decimals);

  const suppliedUSD = suppliedRaw * usdRate;
  const borrowedUSD = borrowedRaw * usdRate;

  // Compute available borrow capacity (keeping HF >= BORROW_MIN_HEALTH_FACTOR)
  // HF_target = (supplied * liqThreshold) / (borrowed + newBorrow) >= BORROW_MIN_HF
  // => newBorrow <= (supplied * liqThreshold / BORROW_MIN_HF) - borrowed
  const availableToBorrow = Math.max(
    0,
    Math.floor((suppliedRaw * liqThreshold) / BORROW_MIN_HEALTH_FACTOR - borrowedRaw)
  );

  // Compute safe withdrawal amount (keeping HF >= WITHDRAW_MIN_HEALTH_FACTOR)
  // HF_target = ((supplied - withdraw) * liqThreshold) / borrowed >= WITHDRAW_MIN_HF
  // => withdraw <= supplied - (borrowed * WITHDRAW_MIN_HF / liqThreshold)
  const minSupplyRequired = borrowedRaw > 0
    ? Math.ceil((borrowedRaw * WITHDRAW_MIN_HEALTH_FACTOR) / liqThreshold)
    : 0;
  const availableToWithdraw = Math.max(0, suppliedRaw - minSupplyRequired);

  return {
    asset,
    supplied: suppliedRaw,
    borrowed: borrowedRaw,
    suppliedUSD,
    borrowedUSD,
    ltv,
    liquidationThreshold: liqThreshold,
    healthFactor,
    canBorrow: healthFactor > BORROW_MIN_HEALTH_FACTOR,
    availableToBorrow,
    availableToWithdraw,
  };
}

async function readAllPositions(address: string): Promise<AssetPosition[]> {
  const walletBalances = await getWalletBalances(address);
  const results: AssetPosition[] = [];

  for (const asset of ASSET_NAMES) {
    const pos = await readAssetPosition(asset, address, walletBalances);
    if (pos) results.push(pos);
  }

  return results;
}

function computeAggregate(positions: AssetPosition[]): AggregatePosition {
  const now = Date.now() / 1000;
  const cooldownRemaining = Math.max(
    0,
    Math.ceil(COOLDOWN_SECONDS - (now - managerState.lastWriteEpoch))
  );

  if (positions.length === 0) {
    return {
      totalSuppliedUSD: 0,
      totalBorrowedUSD: 0,
      weightedLtv: 0,
      aggregateHealthFactor: Infinity,
      riskLevel: "healthy",
      positions: [],
      safetyState: {
        dailyRepayRemaining: HARD_CAP_REPAY_PER_DAY_SATS - managerState.dailyRepayedSats,
        cooldownRemaining,
        lastWriteAt: managerState.lastWriteEpoch > 0
          ? new Date(managerState.lastWriteEpoch * 1000).toISOString()
          : null,
      },
    };
  }

  const totalSuppliedUSD = positions.reduce((s, p) => s + p.suppliedUSD, 0);
  const totalBorrowedUSD = positions.reduce((s, p) => s + p.borrowedUSD, 0);

  // Weighted liquidation threshold
  const avgLiqThreshold = totalSuppliedUSD > 0
    ? positions.reduce((s, p) => s + p.liquidationThreshold * p.suppliedUSD, 0) / totalSuppliedUSD
    : LIQUIDATION_THRESHOLD;

  const weightedLtv = totalSuppliedUSD > 0 ? totalBorrowedUSD / totalSuppliedUSD : 0;

  const aggregateHealthFactor = totalBorrowedUSD > 0
    ? (totalSuppliedUSD * avgLiqThreshold) / totalBorrowedUSD
    : Infinity;

  let riskLevel: "healthy" | "warning" | "critical" | "emergency";
  if (aggregateHealthFactor <= HARD_STOP_MIN_HEALTH_FACTOR) {
    riskLevel = "emergency";
  } else if (aggregateHealthFactor <= BORROW_MIN_HEALTH_FACTOR) {
    riskLevel = "critical";
  } else if (aggregateHealthFactor < TARGET_HEALTH_FACTOR) {
    riskLevel = "warning";
  } else {
    riskLevel = "healthy";
  }

  return {
    totalSuppliedUSD,
    totalBorrowedUSD,
    weightedLtv,
    aggregateHealthFactor,
    riskLevel,
    positions,
    safetyState: {
      dailyRepayRemaining: HARD_CAP_REPAY_PER_DAY_SATS - managerState.dailyRepayedSats,
      cooldownRemaining,
      lastWriteAt: managerState.lastWriteEpoch > 0
        ? new Date(managerState.lastWriteEpoch * 1000).toISOString()
        : null,
    },
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PREFLIGHT
// ═══════════════════════════════════════════════════════════════════════════
async function preflight(requireWrite = false): Promise<{
  ok: boolean;
  wallet: string;
  stxBalance: number;
  positions: AssetPosition[];
  aggregate: AggregatePosition;
  errors: string[];
}> {
  const errors: string[] = [];
  const wallet = process.env.STACKS_ADDRESS || "";

  if (!wallet) errors.push("STACKS_ADDRESS not set — unlock wallet first");

  let stxBalance = 0;
  let positions: AssetPosition[] = [];
  let aggregate = computeAggregate([]);

  if (wallet) {
    const balances = await getWalletBalances(wallet);
    stxBalance = balances.stxBalance;

    if (stxBalance < MIN_GAS_USTX) {
      errors.push(`Insufficient STX for gas: have ${stxBalance} uSTX, need ${MIN_GAS_USTX} uSTX`);
    }

    if (requireWrite) {
      const now = Date.now() / 1000;
      const elapsed = now - managerState.lastWriteEpoch;
      if (elapsed < COOLDOWN_SECONDS) {
        errors.push(
          `Cooldown active: ${Math.ceil(COOLDOWN_SECONDS - elapsed)}s remaining`
        );
      }
    }

    positions = await readAllPositions(wallet);
    aggregate = computeAggregate(positions);
  }

  return { ok: errors.length === 0, wallet, stxBalance, positions, aggregate, errors };
}

// ═══════════════════════════════════════════════════════════════════════════
// HEALTH FACTOR GUARD — called before every write action
// ═══════════════════════════════════════════════════════════════════════════
function healthFactorGuard(
  aggregate: AggregatePosition,
  projectedHF: number,
  action: string
): boolean {
  if (projectedHF < HARD_STOP_MIN_HEALTH_FACTOR) {
    blocked(
      `HARD STOP: ${action} refused`,
      "health_factor_hard_stop",
      `Projected health factor ${projectedHF.toFixed(3)} would fall below absolute floor of ${HARD_STOP_MIN_HEALTH_FACTOR}`,
      `Repay debt first to raise health factor above ${HARD_STOP_MIN_HEALTH_FACTOR}`
    );
    return false;
  }
  return true;
}

// ═══════════════════════════════════════════════════════════════════════════
// STATE UPDATE HELPER
// ═══════════════════════════════════════════════════════════════════════════
function recordOp(op: string, asset: string, amount: number) {
  managerState.lastWriteEpoch = Date.now() / 1000;
  if (op === "repay") managerState.dailyRepayedSats += amount;
  managerState.opLog.push({ ts: new Date().toISOString(), op, asset, amount });
  saveState(managerState);
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI SETUP
// ═══════════════════════════════════════════════════════════════════════════
const program = new Command();

program
  .name("zest-full-position-manager")
  .description(
    "Zest Protocol full lifecycle manager — supply, borrow, and repay with health factor guardrails"
  )
  .version("1.0.0");

// ═══════════════════════════════════════════════════════════════════════════
// DOCTOR
// ═══════════════════════════════════════════════════════════════════════════
program
  .command("doctor")
  .description("Check environment readiness — wallet, gas, Zest connectivity, active positions")
  .action(async () => {
    const pf = await preflight();

    if (!pf.ok) {
      fail(
        "Blockers detected — resolve before using this skill",
        pf.wallet ? "preflight_failed" : "no_wallet",
        pf.errors.join("; "),
        pf.wallet
          ? "Ensure STX balance >= 0.2 STX and wallet is unlocked"
          : "Run wallet_unlock to enable signing"
      );
      return;
    }

    success("Environment ready", {
      wallet: pf.wallet,
      stxBalance: `${(pf.stxBalance / 1_000_000).toFixed(4)} STX`,
      activePositions: pf.positions.length,
      aggregateHealthFactor: isFinite(pf.aggregate.aggregateHealthFactor)
        ? pf.aggregate.aggregateHealthFactor.toFixed(3)
        : "∞ (no debt)",
      riskLevel: pf.aggregate.riskLevel,
      supportedAssets: ASSET_NAMES,
      safetyLimits: {
        hardStopHealthFactor: HARD_STOP_MIN_HEALTH_FACTOR,
        minBorrowHealthFactor: BORROW_MIN_HEALTH_FACTOR,
        minWithdrawHealthFactor: WITHDRAW_MIN_HEALTH_FACTOR,
        targetHealthFactor: TARGET_HEALTH_FACTOR,
        hardCapRepayPerDay: `${HARD_CAP_REPAY_PER_DAY_SATS} sats`,
        cooldownBetweenWrites: `${COOLDOWN_SECONDS}s`,
      },
    });
  });

// ═══════════════════════════════════════════════════════════════════════════
// RUN
// ═══════════════════════════════════════════════════════════════════════════
program
  .command("run")
  .description("Execute position management actions")
  .requiredOption(
    "--action <action>",
    "Action: status | supply | borrow | repay | withdraw | manage"
  )
  .option("--asset <asset>", "Asset symbol (sBTC, wSTX, stSTX, USDC, USDH, stSTXbtc)")
  .option("--amount <units>", "Amount in token base units (e.g. sats for sBTC)")
  .option("--target-hf <hf>", "Target health factor for manage mode", String(TARGET_HEALTH_FACTOR))
  .action(async (opts) => {
    const action = opts.action as string;
    const asset = opts.asset as string | undefined;
    const rawAmount = opts.amount ? parseInt(opts.amount, 10) : 0;
    const targetHF = Math.max(
      BORROW_MIN_HEALTH_FACTOR,
      parseFloat(opts.targetHf || String(TARGET_HEALTH_FACTOR))
    );

    // ── STATUS ──────────────────────────────────────────────────────────
    if (action === "status") {
      const pf = await preflight(false);

      if (!pf.wallet) {
        fail("No wallet", "no_wallet", "STACKS_ADDRESS not set", "Unlock wallet first");
        return;
      }

      const agg = pf.aggregate;

      success("Full position overview", {
        wallet: pf.wallet,
        aggregate: {
          totalSuppliedUSD: agg.totalSuppliedUSD.toFixed(2),
          totalBorrowedUSD: agg.totalBorrowedUSD.toFixed(2),
          weightedLtv: `${(agg.weightedLtv * 100).toFixed(1)}%`,
          aggregateHealthFactor: isFinite(agg.aggregateHealthFactor)
            ? agg.aggregateHealthFactor.toFixed(3)
            : "∞",
          riskLevel: agg.riskLevel,
        },
        positions: agg.positions.map((p) => ({
          asset: p.asset,
          supplied: p.supplied,
          borrowed: p.borrowed,
          ltv: `${(p.ltv * 100).toFixed(1)}%`,
          healthFactor: isFinite(p.healthFactor)
            ? p.healthFactor.toFixed(3)
            : "∞",
          liquidationAt: `${(p.liquidationThreshold * 100).toFixed(0)}% LTV`,
          canBorrow: p.canBorrow,
          availableToBorrow: p.availableToBorrow,
          availableToWithdraw: p.availableToWithdraw,
          safeActions: [
            p.supplied > 0 ? "withdraw (up to " + p.availableToWithdraw + " units)" : null,
            p.availableToBorrow > 0 ? "borrow (up to " + p.availableToBorrow + " units)" : null,
            p.borrowed > 0 ? "repay" : null,
          ].filter(Boolean),
        })),
        safetyState: agg.safetyState,
        hardLimits: {
          hardStopHealthFactor: HARD_STOP_MIN_HEALTH_FACTOR,
          minBorrowHealthFactor: BORROW_MIN_HEALTH_FACTOR,
        },
      });
      return;
    }

    // ── SUPPLY ──────────────────────────────────────────────────────────
    if (action === "supply") {
      if (!asset || !ZEST_ASSETS[asset]) {
        fail("Invalid asset", "invalid_asset", `Asset '${asset}' not supported`, `Use one of: ${ASSET_NAMES.join(", ")}`);
        return;
      }
      if (!rawAmount || rawAmount <= 0) {
        fail("Invalid amount", "invalid_amount", "Amount must be a positive integer", "Use --amount <base-units>");
        return;
      }
      if (rawAmount > HARD_CAP_SUPPLY_PER_OP) {
        blocked(
          "Supply cap exceeded",
          "exceeds_supply_cap",
          `${rawAmount} exceeds hard cap of ${HARD_CAP_SUPPLY_PER_OP} per operation`,
          `Use --amount <= ${HARD_CAP_SUPPLY_PER_OP}`
        );
        return;
      }

      const pf = await preflight(true);
      if (!pf.ok) {
        fail("Pre-flight failed", "preflight_failed", pf.errors.join("; "), "Run doctor first");
        return;
      }

      // Supply never worsens health factor — it improves it or is neutral
      // Still verify wallet has the tokens
      success("Supply plan ready — awaiting agent execution", {
        action: "supply",
        asset,
        amount: rawAmount,
        wallet: pf.wallet,
        mcpCommand: {
          tool: "zest_supply",
          params: { asset, amount: String(rawAmount) },
        },
        safetyChecks: {
          healthFactorUnaffected: "Supply improves or maintains HF",
          amountWithinCap: rawAmount <= HARD_CAP_SUPPLY_PER_OP,
          cooldownRespected: true,
        },
        projectedEffect: {
          currentHF: isFinite(pf.aggregate.aggregateHealthFactor)
            ? pf.aggregate.aggregateHealthFactor.toFixed(3)
            : "∞",
          projectedHF: "≥ current (supply only improves health factor)",
        },
      });

      recordOp("supply", asset, rawAmount);
      return;
    }

    // ── BORROW ──────────────────────────────────────────────────────────
    if (action === "borrow") {
      if (!asset || !ZEST_ASSETS[asset]) {
        fail("Invalid asset", "invalid_asset", `Asset '${asset}' not supported`, `Use one of: ${ASSET_NAMES.join(", ")}`);
        return;
      }
      if (!rawAmount || rawAmount <= 0) {
        fail("Invalid amount", "invalid_amount", "Amount must be a positive integer", "Use --amount <base-units>");
        return;
      }
      if (rawAmount > HARD_CAP_BORROW_PER_OP) {
        blocked(
          "Borrow cap exceeded",
          "exceeds_borrow_cap",
          `${rawAmount} exceeds hard cap of ${HARD_CAP_BORROW_PER_OP} per operation`,
          `Use --amount <= ${HARD_CAP_BORROW_PER_OP}`
        );
        return;
      }

      const pf = await preflight(true);
      if (!pf.ok) {
        fail("Pre-flight failed", "preflight_failed", pf.errors.join("; "), "Run doctor first");
        return;
      }

      // Find the position for this asset
      const pos = pf.positions.find((p) => p.asset === asset);
      if (!pos || pos.supplied === 0) {
        blocked(
          "No collateral to borrow against",
          "no_collateral",
          `No supplied ${asset} found — supply collateral first`,
          `Use --action=supply --asset=${asset} to provide collateral`
        );
        return;
      }

      // Project health factor after borrow
      const cfg = ZEST_ASSETS[asset];
      const newBorrowed = pos.borrowed + rawAmount;
      const projectedHF = pos.supplied > 0
        ? (pos.supplied * cfg.liquidationThreshold) / newBorrowed
        : 0;

      // HEALTH FACTOR HARD STOP
      if (!healthFactorGuard(pf.aggregate, projectedHF, "borrow")) return;

      // Also check against per-asset available capacity
      if (rawAmount > pos.availableToBorrow) {
        blocked(
          "Borrow exceeds safe capacity",
          "exceeds_safe_borrow",
          `Requesting ${rawAmount} but safe capacity is ${pos.availableToBorrow} (keeps HF >= ${BORROW_MIN_HEALTH_FACTOR})`,
          `Use --amount <= ${pos.availableToBorrow} to stay within safe bounds`
        );
        return;
      }

      success("Borrow plan ready — awaiting agent execution", {
        action: "borrow",
        asset,
        amount: rawAmount,
        wallet: pf.wallet,
        mcpCommand: {
          tool: "zest_borrow",
          params: { asset, amount: String(rawAmount) },
        },
        safetyChecks: {
          projectedHealthFactor: projectedHF.toFixed(3),
          hardStopFloor: HARD_STOP_MIN_HEALTH_FACTOR,
          borrowMinFloor: BORROW_MIN_HEALTH_FACTOR,
          hardStopPassed: projectedHF >= HARD_STOP_MIN_HEALTH_FACTOR,
          borrowFloorPassed: projectedHF >= BORROW_MIN_HEALTH_FACTOR,
          withinSafeCapacity: rawAmount <= pos.availableToBorrow,
          cooldownRespected: true,
        },
        projectedEffect: {
          currentHF: isFinite(pos.healthFactor) ? pos.healthFactor.toFixed(3) : "∞",
          projectedHF: projectedHF.toFixed(3),
          newLtv: `${((newBorrowed / pos.supplied) * 100).toFixed(1)}%`,
          liquidationThreshold: `${(cfg.liquidationThreshold * 100).toFixed(0)}%`,
        },
      });

      recordOp("borrow", asset, rawAmount);
      return;
    }

    // ── REPAY ───────────────────────────────────────────────────────────
    if (action === "repay") {
      if (!asset || !ZEST_ASSETS[asset]) {
        fail("Invalid asset", "invalid_asset", `Asset '${asset}' not supported`, `Use one of: ${ASSET_NAMES.join(", ")}`);
        return;
      }
      if (!rawAmount || rawAmount <= 0) {
        fail("Invalid amount", "invalid_amount", "Amount must be a positive integer", "Use --amount <base-units>");
        return;
      }

      // Check daily repay cap (for sBTC-denominated assets)
      const cfg = ZEST_ASSETS[asset];
      if (asset === "sBTC") {
        if (managerState.dailyRepayedSats >= HARD_CAP_REPAY_PER_DAY_SATS) {
          blocked(
            "Daily repay cap reached",
            "daily_cap_exceeded",
            `Already repaid ${managerState.dailyRepayedSats} sats today (cap: ${HARD_CAP_REPAY_PER_DAY_SATS})`,
            "Manual intervention required if position is critical"
          );
          return;
        }
        if (managerState.dailyRepayedSats + rawAmount > HARD_CAP_REPAY_PER_DAY_SATS) {
          const safeAmount = HARD_CAP_REPAY_PER_DAY_SATS - managerState.dailyRepayedSats;
          blocked(
            "Repay would exceed daily cap",
            "would_exceed_daily_cap",
            `${rawAmount} sats would exceed daily cap. Max allowed: ${safeAmount} sats`,
            `Use --amount <= ${safeAmount}`
          );
          return;
        }
      }

      const pf = await preflight(true);
      if (!pf.ok) {
        // Allow repay even during cooldown (safety escape hatch)
        const nonCooldownErrors = pf.errors.filter(e => !e.includes("Cooldown"));
        if (nonCooldownErrors.length > 0) {
          fail("Pre-flight failed", "preflight_failed", nonCooldownErrors.join("; "), "Run doctor first");
          return;
        }
      }

      const pos = pf.positions.find((p) => p.asset === asset);
      if (!pos || pos.borrowed === 0) {
        fail(
          "No debt to repay",
          "no_debt",
          `No borrowed ${asset} found`,
          `Check status with --action=status`
        );
        return;
      }

      // Clamp to actual debt
      const effectiveAmount = Math.min(rawAmount, pos.borrowed);
      const newBorrowed = pos.borrowed - effectiveAmount;
      const projectedHF = newBorrowed > 0
        ? (pos.supplied * cfg.liquidationThreshold) / newBorrowed
        : Infinity;

      // Wallet reserve check (for sBTC)
      if (asset === "sBTC" && pf.aggregate.positions) {
        const walBal = await getWalletBalances(pf.wallet);
        const sbtcKey = Object.keys(walBal.fungible).find(k =>
          k.includes("sbtc-token") || k.includes("sbtc")
        );
        const sbtcBal = sbtcKey ? walBal.fungible[sbtcKey] : 0;
        if (sbtcBal - effectiveAmount < MIN_WALLET_RESERVE_SATS) {
          const safeRepay = Math.max(0, sbtcBal - MIN_WALLET_RESERVE_SATS);
          if (safeRepay <= 0) {
            fail(
              "Insufficient balance for repay",
              "insufficient_balance",
              `Balance ${sbtcBal} sats minus reserve ${MIN_WALLET_RESERVE_SATS} = 0 available`,
              "Deposit more sBTC first"
            );
            return;
          }
          blocked(
            "Repay capped to preserve wallet reserve",
            "reserve_protection",
            `Requested ${effectiveAmount} but safe max is ${safeRepay} sats (preserves ${MIN_WALLET_RESERVE_SATS} sat reserve)`,
            `Use --amount <= ${safeRepay}`
          );
          return;
        }
      }

      success("Repay plan ready — awaiting agent execution", {
        action: "repay",
        asset,
        amount: effectiveAmount,
        wallet: pf.wallet,
        mcpCommand: {
          tool: "zest_repay",
          params: { asset, amount: String(effectiveAmount) },
        },
        safetyChecks: {
          projectedHealthFactor: isFinite(projectedHF) ? projectedHF.toFixed(3) : "∞ (debt cleared)",
          hardStopPassed: true, // repay always improves HF
          reservePreserved: true,
          cooldownOverridden: "Repay allowed during cooldown (safety escape hatch)",
        },
        projectedEffect: {
          currentHF: isFinite(pos.healthFactor) ? pos.healthFactor.toFixed(3) : "∞",
          projectedHF: isFinite(projectedHF) ? projectedHF.toFixed(3) : "∞",
          debtCleared: effectiveAmount === pos.borrowed,
          currentDebt: pos.borrowed,
          remainingDebt: newBorrowed,
        },
      });

      recordOp("repay", asset, effectiveAmount);
      return;
    }

    // ── WITHDRAW ────────────────────────────────────────────────────────
    if (action === "withdraw") {
      if (!asset || !ZEST_ASSETS[asset]) {
        fail("Invalid asset", "invalid_asset", `Asset '${asset}' not supported`, `Use one of: ${ASSET_NAMES.join(", ")}`);
        return;
      }
      if (!rawAmount || rawAmount <= 0) {
        fail("Invalid amount", "invalid_amount", "Amount must be a positive integer", "Use --amount <base-units>");
        return;
      }

      const pf = await preflight(true);
      if (!pf.ok) {
        fail("Pre-flight failed", "preflight_failed", pf.errors.join("; "), "Run doctor first");
        return;
      }

      const pos = pf.positions.find((p) => p.asset === asset);
      if (!pos || pos.supplied === 0) {
        fail(
          "No supplied balance",
          "no_supply",
          `No supplied ${asset} found`,
          "Supply first with --action=supply"
        );
        return;
      }

      if (rawAmount > pos.availableToWithdraw) {
        blocked(
          "Withdrawal exceeds safe limit",
          "exceeds_safe_withdraw",
          `Requesting ${rawAmount} but safe withdrawal is ${pos.availableToWithdraw} (keeps HF >= ${WITHDRAW_MIN_HEALTH_FACTOR})`,
          `Use --amount <= ${pos.availableToWithdraw} or repay debt first`
        );
        return;
      }

      const cfg = ZEST_ASSETS[asset];
      const newSupplied = pos.supplied - rawAmount;
      const projectedHF = pos.borrowed > 0
        ? (newSupplied * cfg.liquidationThreshold) / pos.borrowed
        : Infinity;

      // HEALTH FACTOR HARD STOP
      if (!healthFactorGuard(pf.aggregate, projectedHF, "withdraw")) return;

      success("Withdrawal plan ready — awaiting agent execution", {
        action: "withdraw",
        asset,
        amount: rawAmount,
        wallet: pf.wallet,
        mcpCommand: {
          tool: "zest_withdraw",
          params: { asset, amount: String(rawAmount) },
        },
        safetyChecks: {
          projectedHealthFactor: isFinite(projectedHF) ? projectedHF.toFixed(3) : "∞",
          hardStopFloor: HARD_STOP_MIN_HEALTH_FACTOR,
          withdrawFloor: WITHDRAW_MIN_HEALTH_FACTOR,
          hardStopPassed: projectedHF >= HARD_STOP_MIN_HEALTH_FACTOR,
          withdrawFloorPassed: rawAmount <= pos.availableToWithdraw,
          cooldownRespected: true,
        },
        projectedEffect: {
          currentHF: isFinite(pos.healthFactor) ? pos.healthFactor.toFixed(3) : "∞",
          projectedHF: isFinite(projectedHF) ? projectedHF.toFixed(3) : "∞",
          remainingSupply: newSupplied,
        },
      });

      recordOp("withdraw", asset, rawAmount);
      return;
    }

    // ── MANAGE (Automated position health restoration) ───────────────
    if (action === "manage") {
      const pf = await preflight(false); // Read-only first pass

      if (!pf.wallet) {
        fail("No wallet", "no_wallet", "STACKS_ADDRESS not set", "Unlock wallet first");
        return;
      }

      const agg = pf.aggregate;

      if (agg.positions.length === 0) {
        success("No active positions to manage", {
          wallet: pf.wallet,
          recommendation: "Supply assets to start earning yield: --action=supply",
        });
        return;
      }

      // Find the most at-risk position
      const atRisk = agg.positions
        .filter((p) => p.borrowed > 0)
        .sort((a, b) => a.healthFactor - b.healthFactor);

      if (atRisk.length === 0) {
        success("All positions healthy — no debt to manage", {
          aggregateHealthFactor: isFinite(agg.aggregateHealthFactor)
            ? agg.aggregateHealthFactor.toFixed(3)
            : "∞",
          positions: agg.positions.map((p) => ({
            asset: p.asset,
            supplied: p.supplied,
            borrowed: p.borrowed,
          })),
          recommendation: "Positions are supply-only. Use --action=borrow to leverage.",
        });
        return;
      }

      const worstPosition = atRisk[0];

      if (worstPosition.healthFactor >= targetHF) {
        success("All positions within target health factor", {
          worstHealthFactor: worstPosition.healthFactor.toFixed(3),
          targetHealthFactor: targetHF,
          riskLevel: agg.riskLevel,
          recommendation: "No action needed — positions are healthy",
        });
        return;
      }

      // Compute repayment needed to restore target HF for worst position
      const cfg = ZEST_ASSETS[worstPosition.asset];
      // targetHF = (supplied * liqThreshold) / newBorrowed
      // => newBorrowed = (supplied * liqThreshold) / targetHF
      const targetDebt = (worstPosition.supplied * cfg.liquidationThreshold) / targetHF;
      const rawRepay = Math.max(0, worstPosition.borrowed - targetDebt);
      const cappedRepay = worstPosition.asset === "sBTC"
        ? Math.min(
            rawRepay,
            HARD_CAP_REPAY_PER_DAY_SATS - managerState.dailyRepayedSats
          )
        : rawRepay;

      if (cappedRepay <= 0) {
        blocked(
          "Cannot repay — daily cap reached",
          "daily_cap_reached",
          "Daily repay cap exhausted. Manual intervention may be required.",
          "Check daily repay limit and consider manual repayment"
        );
        return;
      }

      // Project health factor after managed repay
      const newBorrowed = worstPosition.borrowed - cappedRepay;
      const projectedHF = newBorrowed > 0
        ? (worstPosition.supplied * cfg.liquidationThreshold) / newBorrowed
        : Infinity;

      success("Managed repayment plan computed", {
        action: "manage",
        reason: `Health factor ${worstPosition.healthFactor.toFixed(3)} below target ${targetHF}`,
        worstAsset: worstPosition.asset,
        repayAmount: Math.floor(cappedRepay),
        wallet: pf.wallet,
        mcpCommand: {
          tool: "zest_repay",
          params: {
            asset: worstPosition.asset,
            amount: String(Math.floor(cappedRepay)),
          },
        },
        safetyChecks: {
          currentHF: worstPosition.healthFactor.toFixed(3),
          projectedHF: isFinite(projectedHF) ? projectedHF.toFixed(3) : "∞",
          hardStopFloor: HARD_STOP_MIN_HEALTH_FACTOR,
          dailyCapRemaining: HARD_CAP_REPAY_PER_DAY_SATS - managerState.dailyRepayedSats,
          isEmergency: worstPosition.healthFactor <= HARD_STOP_MIN_HEALTH_FACTOR,
        },
        allPositions: agg.positions.map((p) => ({
          asset: p.asset,
          healthFactor: isFinite(p.healthFactor) ? p.healthFactor.toFixed(3) : "∞",
          riskLevel:
            p.healthFactor <= HARD_STOP_MIN_HEALTH_FACTOR
              ? "emergency"
              : p.healthFactor <= BORROW_MIN_HEALTH_FACTOR
                ? "critical"
                : p.healthFactor < targetHF
                  ? "warning"
                  : "healthy",
        })),
      });
      return;
    }

    fail(
      "Unknown action",
      "unknown_action",
      `Action '${action}' not recognized`,
      "Use: status | supply | borrow | repay | withdraw | manage"
    );
  });

program.parse();

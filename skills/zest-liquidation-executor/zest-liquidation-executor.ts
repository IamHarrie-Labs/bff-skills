#!/usr/bin/env bun
/**
 * zest-liquidation-executor — Autonomous Zest Protocol Liquidator
 *
 * Scans Zest Protocol v2 for undercollateralized borrowing positions,
 * calculates liquidation profitability (bonus minus gas), and executes
 * liquidation-call transactions to earn collateral bonuses while
 * protecting the protocol from bad debt accumulation.
 *
 * This is a foundational DeFi primitive — the first liquidation executor
 * on Zest Protocol for autonomous Bitcoin agents.
 *
 * Author: IamHarrie
 * Agent: Harrie Agent — Autonomous DeFi Liquidator
 */

import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ═══════════════════════════════════════════════════════════════════════════
// SAFETY CONSTANTS — Hard-coded. Cannot be overridden by flags.
// ═══════════════════════════════════════════════════════════════════════════
const HARD_CAP_PER_LIQUIDATION_SATS = 1_000_000; // 0.01 BTC — max debt covered per call
const HARD_CAP_PER_DAY_SATS = 5_000_000;         // 0.05 BTC — total daily cap
const CLOSE_FACTOR = 0.5;                          // Zest protocol: max 50% of debt per call
const MIN_WALLET_RESERVE_SATS = 10_000;            // Always keep this in wallet
const MIN_GAS_USTX = 500_000;                      // 0.5 STX minimum for gas
const COOLDOWN_SECONDS = 300;                      // 5 minutes between liquidations
const MIN_PROFIT_BPS_FLOOR = 10;                   // Agent cannot go below 10 bps
const DEFAULT_MIN_PROFIT_BPS = 50;                 // Default 0.5% profit threshold
const MAX_BORROWERS_TO_SCAN = 100;                 // Scan at most N borrowers per run
const BORDERLINE_HF = 0.98;                        // Health factors above this are risky to target
const FETCH_TIMEOUT_MS = 15_000;

// ═══════════════════════════════════════════════════════════════════════════
// ZEST PROTOCOL v2 CONTRACTS (Stacks Mainnet)
// ═══════════════════════════════════════════════════════════════════════════
const POOL_BORROW    = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.pool-borrow-v2-3";
const BORROW_HELPER  = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.borrow-helper-v2-1-7";
const PRICE_ORACLE   = "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.oracle-v2-3";

const HIRO_API = "https://api.hiro.so";

// ═══════════════════════════════════════════════════════════════════════════
// SUPPORTED ASSETS — Zest v2 collateral registry
// ═══════════════════════════════════════════════════════════════════════════
interface AssetConfig {
  token: string;        // Stacks principal
  lpToken: string;      // Zest zToken
  oracle: string;       // Pyth oracle principal for this asset
  decimals: number;
  liquidationBonus: number;    // e.g. 1.10 = 10% bonus
  liquidationThreshold: number; // e.g. 75 = 75% LTV at which liquidation triggers
  symbol: string;
}

const ASSETS: Record<string, AssetConfig> = {
  sBTC: {
    token:    "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
    lpToken:  "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zsbtc-v2-0",
    oracle:   "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.pyth-oracle-v2-3",
    decimals: 8,
    liquidationBonus:    1.10,
    liquidationThreshold: 75,
    symbol: "sBTC",
  },
  wSTX: {
    token:    "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.wstx",
    lpToken:  "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zwstx-v2-0",
    oracle:   "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.pyth-oracle-v2-3",
    decimals: 6,
    liquidationBonus:    1.10,
    liquidationThreshold: 75,
    symbol: "wSTX",
  },
  stSTX: {
    token:    "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token",
    lpToken:  "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zststx-v2-0",
    oracle:   "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.pyth-oracle-v2-3",
    decimals: 6,
    liquidationBonus:    1.10,
    liquidationThreshold: 75,
    symbol: "stSTX",
  },
  USDC: {
    token:    "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx",
    lpToken:  "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zusdc-v2-0",
    oracle:   "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.pyth-oracle-v2-3",
    decimals: 6,
    liquidationBonus:    1.05,
    liquidationThreshold: 80,
    symbol: "USDC",
  },
  USDH: {
    token:    "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.usdh-token-v1",
    lpToken:  "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zusdh-v2-0",
    oracle:   "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.pyth-oracle-v2-3",
    decimals: 8,
    liquidationBonus:    1.05,
    liquidationThreshold: 80,
    symbol: "USDH",
  },
  stSTXbtc: {
    token:    "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststxbtc-token-v2",
    lpToken:  "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.zststxbtc-v2-0",
    oracle:   "SP2VCQJGH7PHP2DJK7Z0V48AGBHQAW3R3ZW1QF4N.pyth-oracle-v2-3",
    decimals: 6,
    liquidationBonus:    1.10,
    liquidationThreshold: 75,
    symbol: "stSTXbtc",
  },
};

// ═══════════════════════════════════════════════════════════════════════════
// PERSISTENT SPEND LEDGER
// ═══════════════════════════════════════════════════════════════════════════
interface SpendEntry { ts: string; sats: number; borrower: string; asset: string; txId: string; }
interface SpendLedger {
  date: string;
  totalSats: number;
  lastLiquidationEpoch: number;
  entries: SpendEntry[];
}

const LEDGER_FILE = join(homedir(), ".zest-liquidation-executor-spend.json");

function loadLedger(): SpendLedger {
  const today = new Date().toISOString().slice(0, 10);
  try {
    if (existsSync(LEDGER_FILE)) {
      const raw = JSON.parse(readFileSync(LEDGER_FILE, "utf8")) as SpendLedger;
      if (raw.date === today) return raw;
    }
  } catch { /* corrupt file — fresh start */ }
  return { date: today, totalSats: 0, lastLiquidationEpoch: 0, entries: [] };
}

function saveLedger(ledger: SpendLedger): void {
  writeFileSync(LEDGER_FILE, JSON.stringify(ledger, null, 2), "utf8");
}

// ═══════════════════════════════════════════════════════════════════════════
// TYPES
// ═══════════════════════════════════════════════════════════════════════════
interface BorrowerPosition {
  address: string;
  collateralAsset: string;
  collateralValue: number;   // in asset native units
  debtAsset: string;
  debtValue: number;         // in asset native units
  healthFactor: number;      // < 1.0 = liquidatable
  maxDebtToCover: number;    // applying close factor
  estimatedProfitSats: number;
  estimatedProfitBps: number;
  urgency: "urgent" | "liquidatable" | "borderline";
}

interface LiquidationPlan {
  borrower: string;
  collateralAsset: string;
  debtAsset: string;
  debtToCover: number;
  expectedCollateralSeized: number;
  estimatedProfitSats: number;
  estimatedProfitBps: number;
  healthFactor: number;
}

// ═══════════════════════════════════════════════════════════════════════════
// OUTPUT HELPERS
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
      headers: { "Accept": "application/json" },
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

/** Encode a Clarity principal as hex for read-only calls */
function encodePrincipal(address: string): string {
  // Standard Stacks address: 0x05 + version + hash160 (22 bytes total)
  // We use string-ascii encoding to pass address as an argument
  const buf = Buffer.from(address, "utf8");
  const header = Buffer.alloc(5);
  header[0] = 0x0d; // string-ascii tag
  header.writeUInt32BE(buf.length, 1);
  return "0x" + Buffer.concat([header, buf]).toString("hex");
}

/** Encode a Clarity uint as hex */
function encodeUint(value: number): string {
  const buf = Buffer.alloc(17);
  buf[0] = 0x01; // uint tag
  // Write as 16-byte big-endian
  const hi = Math.floor(value / 2 ** 32);
  const lo = value >>> 0;
  buf.writeUInt32BE(hi, 9);
  buf.writeUInt32BE(lo, 13);
  return "0x" + buf.toString("hex");
}

/** Parse Clarity (ok uint) response */
function parseClarityOkUint(result: string | undefined): number {
  if (!result) return 0;
  // (ok (uint N)) = 0x07 0x01 + 16 bytes
  if (result.startsWith("0x07") && result.length >= 38) {
    const inner = result.slice(4); // strip (ok) wrapper
    if (inner.startsWith("01")) {
      return parseInt(inner.slice(2).slice(-8), 16); // last 4 bytes
    }
  }
  if (result.startsWith("0x01") && result.length >= 34) {
    return parseInt(result.slice(4).slice(-8), 16);
  }
  return 0;
}

// ═══════════════════════════════════════════════════════════════════════════
// WALLET HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function getWallet(): string {
  const addr = process.env.STACKS_ADDRESS || process.env.STX_ADDRESS;
  if (!addr) throw new Error("STACKS_ADDRESS not set — run wallet unlock first");
  return addr;
}

async function getStxBalance(address: string): Promise<number> {
  const data = await hiroFetch<any>(`/extended/v1/address/${address}/stx`);
  if (!data) return 0;
  return parseInt(data.balance || "0", 10) - parseInt(data.locked || "0", 10);
}

async function getTokenBalance(address: string, tokenContract: string): Promise<number> {
  const data = await hiroFetch<any>(`/extended/v1/address/${address}/balances`);
  if (!data?.fungible_tokens) return 0;
  const key = Object.keys(data.fungible_tokens).find(k => k.startsWith(tokenContract));
  if (!key) return 0;
  return parseInt(data.fungible_tokens[key].balance || "0", 10);
}

// ═══════════════════════════════════════════════════════════════════════════
// ZEST PROTOCOL INTERFACE
// ═══════════════════════════════════════════════════════════════════════════

/**
 * Fetch user's reserve data from Zest pool-borrow contract.
 * Returns collateral balance (in aToken units) and variable debt.
 */
async function getUserReserveData(
  borrower: string,
  assetToken: string,
  sender: string
): Promise<{ supplied: number; borrowed: number } | null> {
  const [tokenAddr, tokenName] = assetToken.split(".");
  // Clarity call: (get-user-reserve-data user asset)
  const result = await callReadOnly(
    POOL_BORROW,
    "get-user-reserve-data",
    [encodePrincipal(borrower), encodePrincipal(assetToken)],
    sender
  );

  if (!result?.result) return null;

  // The result is a Clarity tuple — parse key fields
  // In Aave-derived protocols: current-atoken-balance and current-variable-debt
  const hex: string = result.result;

  // Fallback: use Hiro API token balance endpoint for the zToken
  return null; // Will be populated by the scan approach below
}

/**
 * Get asset price from Zest oracle (returns price in USD * 10^8).
 */
async function getAssetPrice(assetToken: string, sender: string): Promise<number> {
  const result = await callReadOnly(
    PRICE_ORACLE,
    "get-asset-price",
    [encodePrincipal(assetToken)],
    sender
  );
  if (!result?.result) return 0;
  return parseClarityOkUint(result.result);
}

/**
 * Scan recent Zest borrow events to discover active borrowers.
 * Uses the Hiro API contract events endpoint.
 */
async function discoverBorrowers(sender: string): Promise<string[]> {
  const [poolAddr, poolName] = POOL_BORROW.split(".");
  const addresses = new Set<string>();

  // Fetch recent transactions that called pool-borrow-v2-3
  const data = await hiroFetch<any>(
    `/extended/v1/address/${poolAddr}.${poolName}/transactions?limit=200`
  );

  if (data?.results) {
    for (const tx of data.results) {
      // Extract the sender of each borrow call
      const senderAddr: string = tx.sender_address;
      if (senderAddr && senderAddr.startsWith("SP")) {
        addresses.add(senderAddr);
      }
    }
  }

  // Also fetch contract events for borrow-type events
  const events = await hiroFetch<any>(
    `/extended/v1/contract/${poolAddr}.${poolName}/events?limit=200`
  );

  if (events?.results) {
    for (const event of events.results) {
      const addr: string = event.contract_log?.value?.repr
        ?.match(/principal ['"]?(SP[A-Z0-9]+)/)?.[1];
      if (addr) addresses.add(addr);
    }
  }

  return Array.from(addresses).slice(0, MAX_BORROWERS_TO_SCAN);
}

/**
 * For a given borrower, check their position across all assets via
 * the zToken balance (how much they have collateral) and
 * their debt tokens. Uses the Hiro balances endpoint for reliability.
 */
async function checkBorrowerPosition(
  borrower: string,
  sender: string
): Promise<BorrowerPosition | null> {
  // Fetch all fungible token balances for this borrower
  const balData = await hiroFetch<any>(
    `/extended/v1/address/${borrower}/balances`
  );
  if (!balData?.fungible_tokens) return null;

  const ft: Record<string, { balance: string }> = balData.fungible_tokens;

  let bestCollateralAsset = "";
  let bestCollateralValue = 0;
  let bestDebtAsset = "";
  let bestDebtValue = 0;

  // Check each asset's zToken (collateral) and debt token balances
  for (const [symbol, config] of Object.entries(ASSETS)) {
    // zToken balance = collateral supplied
    const [lpAddr, lpName] = config.lpToken.split(".");
    const lpKey = Object.keys(ft).find(k => k.startsWith(config.lpToken));
    const collateralBalance = lpKey ? parseInt(ft[lpKey].balance || "0", 10) : 0;

    if (collateralBalance > bestCollateralValue) {
      bestCollateralValue = collateralBalance;
      bestCollateralAsset = symbol;
    }

    // Debt token — Zest uses variable debt tokens (vd-token pattern)
    // Check for any variable debt token balance matching this asset
    const debtTokenKey = Object.keys(ft).find(k =>
      k.includes("variable-debt") && k.includes(symbol.toLowerCase())
    );
    const debtBalance = debtTokenKey ? parseInt(ft[debtTokenKey].balance || "0", 10) : 0;

    if (debtBalance > bestDebtValue) {
      bestDebtValue = debtBalance;
      bestDebtAsset = symbol;
    }
  }

  // No debt means no liquidation risk
  if (bestDebtValue === 0 || bestCollateralValue === 0) return null;

  const collateralConfig = ASSETS[bestCollateralAsset];
  const debtConfig = ASSETS[bestDebtAsset];
  if (!collateralConfig || !debtConfig) return null;

  // Calculate health factor:
  // HF = (collateral_value * liquidation_threshold) / debt_value
  // Both values need to be in the same unit — we use raw token units
  // For a simplified HF: normalize by decimals
  const collateralNorm = bestCollateralValue / (10 ** collateralConfig.decimals);
  const debtNorm = bestDebtValue / (10 ** debtConfig.decimals);

  // Weight collateral by liquidation threshold
  const weightedCollateral = collateralNorm * (collateralConfig.liquidationThreshold / 100);
  const healthFactor = debtNorm > 0 ? weightedCollateral / debtNorm : Infinity;

  // Only report if liquidatable (HF < 1.0)
  if (healthFactor >= 1.0) return null;

  // Apply close factor
  const maxDebtToCover = Math.floor(bestDebtValue * CLOSE_FACTOR);

  // Estimate profit: collateral received = debt_covered * bonus (in collateral terms)
  // Simplified: assume 1:1 price parity for same-pair liquidations
  const collateralToReceive = Math.floor(
    maxDebtToCover * collateralConfig.liquidationBonus
  );
  const profit = collateralToReceive - maxDebtToCover;
  const profitBps = maxDebtToCover > 0
    ? Math.floor((profit / maxDebtToCover) * 10_000)
    : 0;

  let urgency: "urgent" | "liquidatable" | "borderline";
  if (healthFactor < 0.8) urgency = "urgent";
  else if (healthFactor < BORDERLINE_HF) urgency = "liquidatable";
  else urgency = "borderline";

  return {
    address: borrower,
    collateralAsset: bestCollateralAsset,
    collateralValue: bestCollateralValue,
    debtAsset: bestDebtAsset,
    debtValue: bestDebtValue,
    healthFactor,
    maxDebtToCover,
    estimatedProfitSats: profit,
    estimatedProfitBps: profitBps,
    urgency,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// PROFITABILITY CALCULATOR
// ═══════════════════════════════════════════════════════════════════════════
function buildLiquidationPlan(
  position: BorrowerPosition,
  maxAmountOverride: number,
  hardCapRemaining: number
): LiquidationPlan {
  // Apply all caps: close factor, per-op cap, daily cap, user override
  let debtToCover = position.maxDebtToCover;
  debtToCover = Math.min(debtToCover, HARD_CAP_PER_LIQUIDATION_SATS);
  debtToCover = Math.min(debtToCover, hardCapRemaining);
  if (maxAmountOverride > 0) {
    debtToCover = Math.min(debtToCover, maxAmountOverride);
  }

  const collateralConfig = ASSETS[position.collateralAsset];
  const bonus = collateralConfig?.liquidationBonus ?? 1.05;
  const expectedCollateralSeized = Math.floor(debtToCover * bonus);
  const netProfit = expectedCollateralSeized - debtToCover;
  // Estimate gas cost: ~0.003 STX ≈ negligible in sats, but account for it
  const gasEstimateSats = 300; // conservative ~$0.01 gas at current STX price
  const profitAfterGas = Math.max(0, netProfit - gasEstimateSats);
  const profitBps = debtToCover > 0
    ? Math.floor((profitAfterGas / debtToCover) * 10_000)
    : 0;

  return {
    borrower: position.address,
    collateralAsset: position.collateralAsset,
    debtAsset: position.debtAsset,
    debtToCover,
    expectedCollateralSeized,
    estimatedProfitSats: profitAfterGas,
    estimatedProfitBps: profitBps,
    healthFactor: position.healthFactor,
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// COMMANDS
// ═══════════════════════════════════════════════════════════════════════════
const program = new Command();

program
  .name("zest-liquidation-executor")
  .description(
    "Autonomous Zest Protocol liquidator — earns collateral bonuses by repaying undercollateralized debt"
  )
  .version("1.0.0");

// ── DOCTOR ──────────────────────────────────────────────────────────────────
program
  .command("doctor")
  .description("Verify environment, wallet, gas, and Zest contract availability")
  .action(async () => {
    const checks: Record<string, { ok: boolean; detail: string }> = {};
    let wallet: string | null = null;

    // 1. Wallet
    try {
      wallet = getWallet();
      checks.wallet = { ok: true, detail: wallet };
    } catch (e: any) {
      checks.wallet = { ok: false, detail: e.message };
    }

    // 2. STX gas balance
    if (wallet) {
      const stxBal = await getStxBalance(wallet);
      checks.stx_gas = {
        ok: stxBal >= MIN_GAS_USTX,
        detail: `${stxBal} uSTX (need ${MIN_GAS_USTX} min = 0.5 STX)`,
      };

      // 3. sBTC balance (most common liquidation asset)
      const sbtcBal = await getTokenBalance(wallet, ASSETS.sBTC.token);
      checks.sbtc_balance = {
        ok: sbtcBal >= MIN_WALLET_RESERVE_SATS,
        detail: `${sbtcBal} sats sBTC`,
      };
    }

    // 4. Zest pool reachable
    const [poolAddr, poolName] = POOL_BORROW.split(".");
    const poolRes = await hiroFetch<any>(
      `/v2/contracts/interface/${poolAddr}/${poolName}`
    );
    checks.zest_pool_borrow = {
      ok: !!poolRes,
      detail: poolRes ? `${POOL_BORROW} reachable` : "contract unreachable",
    };

    // 5. Borrow helper reachable
    const [helperAddr, helperName] = BORROW_HELPER.split(".");
    const helperRes = await hiroFetch<any>(
      `/v2/contracts/interface/${helperAddr}/${helperName}`
    );
    checks.zest_borrow_helper = {
      ok: !!helperRes,
      detail: helperRes ? `${BORROW_HELPER} reachable` : "contract unreachable",
    };

    // 6. Daily cap remaining
    const ledger = loadLedger();
    const capRemaining = HARD_CAP_PER_DAY_SATS - ledger.totalSats;
    checks.daily_cap = {
      ok: capRemaining > 0,
      detail: `${capRemaining} sats remaining today (cap: ${HARD_CAP_PER_DAY_SATS})`,
    };

    // 7. Cooldown
    const elapsed = Date.now() / 1000 - ledger.lastLiquidationEpoch;
    checks.cooldown = {
      ok: elapsed >= COOLDOWN_SECONDS || ledger.lastLiquidationEpoch === 0,
      detail:
        ledger.lastLiquidationEpoch === 0
          ? "No previous liquidation — ready immediately"
          : `${Math.max(0, Math.ceil(COOLDOWN_SECONDS - elapsed))}s cooldown remaining`,
    };

    const allOk = Object.values(checks).every(c => c.ok);
    const blockers = Object.entries(checks)
      .filter(([, c]) => !c.ok)
      .map(([k, c]) => `${k}: ${c.detail}`);

    if (allOk) {
      out("success", "Environment ready — all checks passed", {
        wallet,
        checks,
        safety_limits: {
          hard_cap_per_liquidation: `${HARD_CAP_PER_LIQUIDATION_SATS} sats`,
          hard_cap_per_day: `${HARD_CAP_PER_DAY_SATS} sats`,
          close_factor: `${CLOSE_FACTOR * 100}%`,
          min_wallet_reserve: `${MIN_WALLET_RESERVE_SATS} sats`,
          cooldown: `${COOLDOWN_SECONDS}s`,
        },
        next: "Run with --action scan to find liquidatable positions",
      });
    } else {
      blocked("preflight_failed", blockers.join("; "), "Fix listed blockers and re-run doctor");
    }
  });

// ── RUN ─────────────────────────────────────────────────────────────────────
program
  .command("run")
  .description("Execute liquidation actions")
  .requiredOption("--action <action>", "Action: scan | liquidate | auto")
  .option("--borrower <address>", "Borrower address to liquidate (required for liquidate)")
  .option("--collateral <asset>", "Collateral asset symbol (e.g. sBTC)", "sBTC")
  .option("--debt <asset>", "Debt asset symbol the agent will repay (e.g. wSTX)", "wSTX")
  .option("--amount <sats>", "Max debt to cover in native units (applies hard cap automatically)", "0")
  .option("--min-profit-bps <bps>", `Min profit threshold in bps (floor: ${MIN_PROFIT_BPS_FLOOR})`, String(DEFAULT_MIN_PROFIT_BPS))
  .option("--max-amount <sats>", "Cap per this operation (agent hard cap still applies)", "0")
  .option("--dry-run", "Build plan but do not broadcast", false)
  .action(async (opts) => {
    const action = opts.action as string;
    const ledger = loadLedger();

    let wallet: string;
    try {
      wallet = getWallet();
    } catch (e: any) {
      fail("no_wallet", e.message, "Run: wallet_unlock or set STACKS_ADDRESS env var");
      return;
    }

    const minProfitBps = Math.max(MIN_PROFIT_BPS_FLOOR, parseInt(opts.minProfitBps, 10));
    const maxAmount = parseInt(opts.maxAmount || opts.amount || "0", 10);
    const capRemaining = HARD_CAP_PER_DAY_SATS - ledger.totalSats;

    if (capRemaining <= 0) {
      blocked(
        "daily_cap_reached",
        `Daily cap of ${HARD_CAP_PER_DAY_SATS} sats reached (${ledger.totalSats} spent today)`,
        "Cap resets at midnight UTC. Manual intervention available for critical positions."
      );
      return;
    }

    // ── SCAN ──────────────────────────────────────────────────────────────
    if (action === "scan") {
      out("success", "Scanning Zest Protocol for liquidatable positions...", {
        scanning: true,
        max_borrowers: MAX_BORROWERS_TO_SCAN,
        min_profit_filter_bps: minProfitBps,
      });

      const borrowers = await discoverBorrowers(wallet);

      if (borrowers.length === 0) {
        out("success", "No recent Zest borrowers found in event history", {
          borrowers_scanned: 0,
          liquidatable: [],
          recommendation: "Zest activity may be low — expand scan window or check back later",
        });
        return;
      }

      const positions: BorrowerPosition[] = [];
      for (const borrower of borrowers) {
        const pos = await checkBorrowerPosition(borrower, wallet);
        if (pos) positions.push(pos);
      }

      const liquidatable = positions
        .filter(p => p.estimatedProfitBps >= minProfitBps)
        .sort((a, b) => b.estimatedProfitSats - a.estimatedProfitSats);

      if (liquidatable.length === 0) {
        out("success", "All scanned positions are healthy or below profit threshold", {
          borrowers_scanned: borrowers.length,
          positions_at_risk: positions.length,
          liquidatable: [],
          recommendation:
            positions.length > 0
              ? `${positions.length} borderline positions found but profit < ${minProfitBps} bps. Lower --min-profit-bps or wait.`
              : "No undercollateralized positions found. Protocol is healthy.",
        });
        return;
      }

      // Build liquidation plans for top candidates
      const plans = liquidatable.slice(0, 5).map(pos =>
        buildLiquidationPlan(pos, maxAmount, capRemaining)
      );

      out("success", `Found ${liquidatable.length} liquidatable position(s)`, {
        borrowers_scanned: borrowers.length,
        liquidatable_count: liquidatable.length,
        top_opportunities: plans.map(plan => ({
          borrower: plan.borrower,
          collateral_asset: plan.collateralAsset,
          debt_asset: plan.debtAsset,
          health_factor: plan.healthFactor.toFixed(4),
          debt_to_cover: plan.debtToCover,
          expected_collateral_seized: plan.expectedCollateralSeized,
          estimated_profit_sats: plan.estimatedProfitSats,
          estimated_profit_bps: plan.estimatedProfitBps,
          urgency: liquidatable.find(p => p.address === plan.borrower)?.urgency,
        })),
        best_opportunity: plans[0]
          ? {
              borrower: plans[0].borrower,
              action: `bun run skills/zest-liquidation-executor/zest-liquidation-executor.ts run --action liquidate --borrower ${plans[0].borrower} --collateral ${plans[0].collateralAsset} --debt ${plans[0].debtAsset} --amount ${plans[0].debtToCover}`,
            }
          : null,
        daily_cap_remaining: `${capRemaining} sats`,
      });
      return;
    }

    // ── LIQUIDATE ─────────────────────────────────────────────────────────
    if (action === "liquidate") {
      const borrower = opts.borrower as string | undefined;
      if (!borrower) {
        fail("missing_borrower", "--borrower <address> is required for liquidate action", "Provide the borrower's Stacks address");
        return;
      }
      if (!borrower.startsWith("SP") && !borrower.startsWith("SM")) {
        fail("invalid_borrower", `Invalid Stacks address: ${borrower}`, "Address must start with SP or SM");
        return;
      }

      const collateralSymbol = opts.collateral as string;
      const debtSymbol = opts.debt as string;
      const collateralConfig = ASSETS[collateralSymbol];
      const debtConfig = ASSETS[debtSymbol];

      if (!collateralConfig) {
        fail("unknown_collateral", `Unknown collateral asset: ${collateralSymbol}`, `Supported: ${Object.keys(ASSETS).join(", ")}`);
        return;
      }
      if (!debtConfig) {
        fail("unknown_debt", `Unknown debt asset: ${debtSymbol}`, `Supported: ${Object.keys(ASSETS).join(", ")}`);
        return;
      }

      // Cooldown check
      const elapsed = Date.now() / 1000 - ledger.lastLiquidationEpoch;
      if (elapsed < COOLDOWN_SECONDS && ledger.lastLiquidationEpoch > 0) {
        blocked(
          "cooldown_active",
          `${Math.ceil(COOLDOWN_SECONDS - elapsed)}s cooldown remaining since last liquidation`,
          "Wait for cooldown or the position may be rescued. Use --action scan to re-check."
        );
        return;
      }

      // Fetch current position
      const position = await checkBorrowerPosition(borrower, wallet);
      if (!position) {
        blocked(
          "position_not_liquidatable",
          `Position for ${borrower} is healthy or not found — may have been rescued since scan`,
          "Run --action scan again to find current opportunities"
        );
        return;
      }

      // Borderline health factor warning
      if (position.healthFactor >= BORDERLINE_HF) {
        blocked(
          "health_factor_borderline",
          `Health factor ${position.healthFactor.toFixed(4)} ≥ ${BORDERLINE_HF} — too close to healthy, front-run risk is high`,
          "Wait for position to deteriorate further or use a different target"
        );
        return;
      }

      // Build plan with all caps applied
      const plan = buildLiquidationPlan(position, maxAmount, capRemaining);

      if (plan.estimatedProfitBps < minProfitBps) {
        blocked(
          "insufficient_profit",
          `Estimated profit ${plan.estimatedProfitBps} bps < minimum threshold ${minProfitBps} bps after gas`,
          `Lower --min-profit-bps or wait for health factor to deteriorate further`
        );
        return;
      }

      // Check wallet has enough debt asset
      const agentDebtBalance = await getTokenBalance(wallet, debtConfig.token);
      if (agentDebtBalance < plan.debtToCover + MIN_WALLET_RESERVE_SATS) {
        const needed = plan.debtToCover + MIN_WALLET_RESERVE_SATS;
        blocked(
          "insufficient_balance",
          `Agent wallet has ${agentDebtBalance} ${debtSymbol} but needs ${needed} (including ${MIN_WALLET_RESERVE_SATS} reserve)`,
          `Acquire at least ${needed - agentDebtBalance} more ${debtSymbol} before liquidating`
        );
        return;
      }

      // Check gas
      const stxBal = await getStxBalance(wallet);
      if (stxBal < MIN_GAS_USTX) {
        blocked(
          "insufficient_gas",
          `STX balance ${stxBal} uSTX < ${MIN_GAS_USTX} uSTX required for gas`,
          "Acquire more STX for transaction fees"
        );
        return;
      }

      if (opts.dryRun) {
        out("success", "DRY RUN — liquidation plan built (not broadcast)", {
          dry_run: true,
          plan,
          safety_checks: {
            within_hard_cap: plan.debtToCover <= HARD_CAP_PER_LIQUIDATION_SATS,
            within_daily_cap: plan.debtToCover <= capRemaining,
            reserve_preserved: true,
            gas_sufficient: true,
            cooldown_clear: true,
            profit_meets_threshold: plan.estimatedProfitBps >= minProfitBps,
            health_factor_safe: position.healthFactor < BORDERLINE_HF,
          },
        });
        return;
      }

      // ── EXECUTE via MCP ────────────────────────────────────────────────
      // Emit the MCP call for the agent framework to broadcast.
      // The borrow-helper contract handles Pyth oracle fees automatically.
      const [helperAddr, helperName] = BORROW_HELPER.split(".");
      const [collateralAddr, collateralName] = collateralConfig.token.split(".");
      const [debtAddr, debtName] = debtConfig.token.split(".");
      const [collateralLpAddr, collateralLpName] = collateralConfig.lpToken.split(".");

      console.error(
        `IRREVERSIBLE ACTION: liquidating ${borrower} — ${debtSymbol} debt covered: ${plan.debtToCover}, collateral seized: ${collateralSymbol}`
      );

      out("success", "Liquidation plan ready — executing via MCP call_contract", {
        plan,
        mcp_command: {
          tool: "call_contract",
          params: {
            contract_address: helperAddr,
            contract_name: helperName,
            function_name: "liquidation-call",
            function_args: [
              // collateral-lp-token (the aToken, e.g. zsbtc)
              `{ type: "principal", value: "${collateralConfig.lpToken}" }`,
              // collateral-reserve (the underlying token)
              `{ type: "principal", value: "${collateralConfig.token}" }`,
              // debt-reserve (the underlying token)
              `{ type: "principal", value: "${debtConfig.token}" }`,
              // user (borrower to liquidate)
              `{ type: "principal", value: "${borrower}" }`,
              // debt-to-cover (uint)
              `{ type: "uint", value: "${plan.debtToCover}" }`,
              // receive-atoken (bool — false = receive underlying collateral)
              `{ type: "bool", value: "false" }`,
            ],
            post_condition_mode: "deny",
          },
          description: `Liquidate ${borrower}: cover ${plan.debtToCover} ${debtSymbol} debt, receive ~${plan.expectedCollateralSeized} ${collateralSymbol} collateral`,
        },
        safety_checks: {
          within_hard_cap: plan.debtToCover <= HARD_CAP_PER_LIQUIDATION_SATS,
          within_daily_cap: plan.debtToCover <= capRemaining,
          wallet_reserve_preserved: agentDebtBalance - plan.debtToCover >= MIN_WALLET_RESERVE_SATS,
          gas_sufficient: stxBal >= MIN_GAS_USTX,
          profit_meets_threshold: plan.estimatedProfitBps >= minProfitBps,
          health_factor_safe: position.healthFactor < BORDERLINE_HF,
        },
        estimated_outcome: {
          debt_covered: `${plan.debtToCover} ${debtSymbol}`,
          collateral_received: `${plan.expectedCollateralSeized} ${collateralSymbol}`,
          net_profit_sats: plan.estimatedProfitSats,
          net_profit_bps: plan.estimatedProfitBps,
          health_factor_before: position.healthFactor.toFixed(4),
        },
      });

      // Update ledger
      ledger.totalSats += plan.debtToCover;
      ledger.lastLiquidationEpoch = Date.now() / 1000;
      ledger.entries.push({
        ts: new Date().toISOString(),
        sats: plan.debtToCover,
        borrower,
        asset: debtSymbol,
        txId: "pending_confirmation",
      });
      saveLedger(ledger);
      return;
    }

    // ── AUTO ──────────────────────────────────────────────────────────────
    if (action === "auto") {
      // Cooldown check
      const elapsed = Date.now() / 1000 - ledger.lastLiquidationEpoch;
      if (elapsed < COOLDOWN_SECONDS && ledger.lastLiquidationEpoch > 0) {
        out("success", "Cooldown active — no action taken", {
          cooldown_remaining_seconds: Math.ceil(COOLDOWN_SECONDS - elapsed),
          last_liquidation: new Date(ledger.lastLiquidationEpoch * 1000).toISOString(),
          next_eligible: new Date((ledger.lastLiquidationEpoch + COOLDOWN_SECONDS) * 1000).toISOString(),
        });
        return;
      }

      // Gas check
      const stxBal = await getStxBalance(wallet);
      if (stxBal < MIN_GAS_USTX) {
        blocked("insufficient_gas", `STX ${stxBal} uSTX < ${MIN_GAS_USTX} uSTX`, "Acquire more STX for gas");
        return;
      }

      // Scan
      const borrowers = await discoverBorrowers(wallet);
      if (borrowers.length === 0) {
        out("success", "No recent Zest borrowers found — all positions healthy", {
          borrowers_scanned: 0,
          action_taken: "none",
        });
        return;
      }

      const positions: BorrowerPosition[] = [];
      for (const borrower of borrowers) {
        const pos = await checkBorrowerPosition(borrower, wallet);
        if (pos) positions.push(pos);
      }

      const candidates = positions
        .filter(p =>
          p.healthFactor < BORDERLINE_HF &&
          p.estimatedProfitBps >= minProfitBps
        )
        .sort((a, b) => b.estimatedProfitSats - a.estimatedProfitSats);

      if (candidates.length === 0) {
        out("success", "Scan complete — no profitable liquidations found", {
          borrowers_scanned: borrowers.length,
          positions_at_risk: positions.length,
          action_taken: "none",
          recommendation: positions.length > 0
            ? `${positions.length} borderline position(s) exist but profit < ${minProfitBps} bps threshold`
            : "All positions healthy",
        });
        return;
      }

      const best = candidates[0];
      const plan = buildLiquidationPlan(best, maxAmount, capRemaining);

      // Check agent has sufficient debt asset
      const agentDebtBalance = await getTokenBalance(wallet, ASSETS[best.debtAsset]?.token ?? "");
      if (agentDebtBalance < plan.debtToCover + MIN_WALLET_RESERVE_SATS) {
        blocked(
          "insufficient_balance",
          `Need ${plan.debtToCover + MIN_WALLET_RESERVE_SATS} ${best.debtAsset}, have ${agentDebtBalance}`,
          `Acquire ${plan.debtToCover + MIN_WALLET_RESERVE_SATS - agentDebtBalance} more ${best.debtAsset} to proceed`
        );
        return;
      }

      const [helperAddr, helperName] = BORROW_HELPER.split(".");
      const debtConfig = ASSETS[best.debtAsset]!;
      const collateralConfig = ASSETS[best.collateralAsset]!;

      console.error(
        `IRREVERSIBLE ACTION: auto-liquidating ${best.address} — ${best.debtAsset} debt covered: ${plan.debtToCover}, collateral seized: ${best.collateralAsset}`
      );

      out("success", "Auto-liquidation plan ready — executing best opportunity", {
        auto_selected: true,
        candidates_found: candidates.length,
        executing: {
          borrower: plan.borrower,
          collateral_asset: plan.collateralAsset,
          debt_asset: plan.debtAsset,
          health_factor: plan.healthFactor.toFixed(4),
          urgency: best.urgency,
        },
        mcp_command: {
          tool: "call_contract",
          params: {
            contract_address: helperAddr,
            contract_name: helperName,
            function_name: "liquidation-call",
            function_args: [
              `{ type: "principal", value: "${collateralConfig.lpToken}" }`,
              `{ type: "principal", value: "${collateralConfig.token}" }`,
              `{ type: "principal", value: "${debtConfig.token}" }`,
              `{ type: "principal", value: "${plan.borrower}" }`,
              `{ type: "uint", value: "${plan.debtToCover}" }`,
              `{ type: "bool", value: "false" }`,
            ],
            post_condition_mode: "deny",
          },
        },
        estimated_outcome: {
          debt_covered: `${plan.debtToCover} ${plan.debtAsset}`,
          collateral_received: `${plan.expectedCollateralSeized} ${plan.collateralAsset}`,
          net_profit_sats: plan.estimatedProfitSats,
          net_profit_bps: plan.estimatedProfitBps,
        },
        safety_checks: {
          within_hard_cap: plan.debtToCover <= HARD_CAP_PER_LIQUIDATION_SATS,
          within_daily_cap: plan.debtToCover <= capRemaining,
          cooldown_clear: true,
          gas_sufficient: true,
          profit_positive: plan.estimatedProfitSats > 0,
        },
        daily_cap_after: `${capRemaining - plan.debtToCover} sats remaining`,
      });

      ledger.totalSats += plan.debtToCover;
      ledger.lastLiquidationEpoch = Date.now() / 1000;
      ledger.entries.push({
        ts: new Date().toISOString(),
        sats: plan.debtToCover,
        borrower: plan.borrower,
        asset: plan.debtAsset,
        txId: "pending_confirmation",
      });
      saveLedger(ledger);
      return;
    }

    fail(
      "unknown_action",
      `Action '${action}' not recognized`,
      "Use: scan | liquidate | auto"
    );
  });

program.parse();

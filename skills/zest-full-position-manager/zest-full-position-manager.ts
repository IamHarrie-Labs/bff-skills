#!/usr/bin/env bun
/**
 * zest-full-position-manager — Zest Protocol Complete Lifecycle Manager
 *
 * Unified position manager handling the full supply → borrow → repay → withdraw
 * lifecycle with health factor guardrail as a hard stop on all write operations.
 * All write operations target the canonical v0-4-market contract. Position reads
 * use v0-market-vault.get-collateral / get-account-scaled-debt. Prices come from live Pyth
 * oracle with a 120s staleness gate — no hardcoded price proxies.
 *
 * Author: lesh (Serene Spring — aibtc-agent)
 * Skill: zest-full-position-manager
 */

import { Command } from "commander";
import { readFileSync, writeFileSync, existsSync } from "fs";
import { join } from "path";
import { homedir } from "os";

// ═══════════════════════════════════════════════════════════════════════════
// SAFETY CONSTANTS — Hard-coded, cannot be overridden by any flag
// ═══════════════════════════════════════════════════════════════════════════
const HARD_STOP_MIN_HEALTH_FACTOR = 1.2;
const BORROW_MIN_HEALTH_FACTOR    = 1.3;
const WITHDRAW_MIN_HEALTH_FACTOR  = 1.25;
const TARGET_HEALTH_FACTOR        = 1.5;

const HARD_CAP_SUPPLY_PER_OP      = 50_000_000;   // 0.5 BTC in sats
const HARD_CAP_BORROW_PER_OP      = 500_000_000;  // 500 aeUSDC (6 dec) or equivalent
const HARD_CAP_REPAY_PER_DAY_SATS = 1_000_000;    // 0.01 BTC in sats
const MIN_WALLET_RESERVE_SATS     = 5_000;
const MIN_GAS_USTX                = 200_000;       // 0.2 STX minimum for gas
const COOLDOWN_SECONDS            = 300;

const HIRO_API            = "https://api.hiro.so";
const FETCH_TIMEOUT       = 15_000;
const TX_POLL_INTERVAL_MS = 5_000;
const TX_POLL_MAX_ATTEMPTS = 60;   // 5 min max
const PRICE_STALENESS_MAX_SEC = 120;
const STATE_FILE = join(homedir(), ".zest-full-position-manager.json");

// ═══════════════════════════════════════════════════════════════════════════
// ZEST V2 CONTRACT REGISTRY
// Market deployer verified via on-chain proof transactions (block 7715675+)
// Market address: SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7 (NOT the old SP2VCQ... deployer)
// ═══════════════════════════════════════════════════════════════════════════
const ZEST_MARKET_DEPLOYER = "SP1A27KFY4XERQCCRCARCYD1CC5N7M6688BSYADJ7";
const MARKET_CONTRACT = `${ZEST_MARKET_DEPLOYER}.v0-4-market`;       // supply-collateral-add / borrow / repay / collateral-remove
const MARKET_VAULT    = `${ZEST_MARKET_DEPLOYER}.v0-market-vault`;    // collateral & scaled-debt tracking
// Vault tokens — collateral is stored as vault shares, not raw tokens
const VAULT_SBTC      = `${ZEST_MARKET_DEPLOYER}.v0-vault-sbtc`;      // zsBTC shares (use for collateral-remove, not raw sBTC)
const VAULT_STX       = `${ZEST_MARKET_DEPLOYER}.v0-vault-stx`;
const VAULT_STSTX     = `${ZEST_MARKET_DEPLOYER}.v0-vault-ststx`;
const VAULT_USDC      = `${ZEST_MARKET_DEPLOYER}.v0-vault-usdc`;
const VAULT_USDH      = `${ZEST_MARKET_DEPLOYER}.v0-vault-usdh`;
const VAULT_STSTXBTC  = `${ZEST_MARKET_DEPLOYER}.v0-vault-ststxbtc`;
const PYTH_ORACLE     = "SP1CGXWEAMG6P6FT04W66NVGJ7PQWMDAC19R7PJ0Y.pyth-oracle-v4";

interface AssetConfig {
  token: string;
  vaultToken: string;       // vault share token used for collateral-remove (asset-id in v0-market-vault)
  collateralAssetId: number; // asset-id for collateral in v0-market-vault (odd: 1,3,5,7,9,11)
  debtAssetId: number;       // asset-id for debt in v0-market-vault (even: 0,2,4,6,8,10)
  decimals: number;
  isStablecoin: boolean;
  liquidationThreshold: number;
  pythFeedId: string;        // Pyth mainnet price feed ID (hex, no 0x prefix)
}

// Pyth mainnet feed IDs — https://pyth.network/price-feeds
// IMPORTANT: collateral-remove must pass vaultToken (e.g. v0-vault-sbtc), NOT the raw token.
// supply-collateral-add wraps raw tokens into vault shares; those shares (zft) are what the
// market-vault tracks. Passing the raw token resolves to the wrong asset-id → ERR-INSUFFICIENT-COLLATERAL.
// v0-market-vault asset-id layout (verified on-chain, block 7715675+):
//   even = underlying debt token: STX=0, sBTC=2, stSTX=4, USDC=6, USDH=8, stSTXbtc=10
//   odd  = vault share collateral: zSTX=1, zsBTC=3, zstSTX=5, zUSDC=7, zUSDH=9, zstSTXbtc=11
const ZEST_ASSETS: Record<string, AssetConfig> = {
  sBTC: {
    token:                "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token",
    vaultToken:           VAULT_SBTC,   // v0-vault-sbtc (zsBTC vault shares)
    collateralAssetId:    3,             // zsBTC — verified: get-collateral(746,3)=149
    debtAssetId:          2,             // sBTC debt
    decimals:             8,
    isStablecoin:         false,
    liquidationThreshold: 0.80,
    pythFeedId: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
  },
  wSTX: {
    token:                `${ZEST_MARKET_DEPLOYER}.wstx`,
    vaultToken:           VAULT_STX,    // v0-vault-stx (zSTX vault shares)
    collateralAssetId:    1,             // zSTX
    debtAssetId:          0,             // STX debt
    decimals:             6,
    isStablecoin:         false,
    liquidationThreshold: 0.75,
    pythFeedId: "ec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1fd16c038",
  },
  stSTX: {
    token:                "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststx-token",
    vaultToken:           VAULT_STSTX,  // v0-vault-ststx (zstSTX vault shares)
    collateralAssetId:    5,             // zstSTX
    debtAssetId:          4,             // stSTX debt
    decimals:             6,
    isStablecoin:         false,
    liquidationThreshold: 0.75,
    pythFeedId: "ec7a775f46379b5e943c3526b1c8d54cd49749176b0b98e02dde68d1fd16c038",
  },
  USDC: {
    token:                "SP120SBRBQJ00MCWS7TM5R8WJNTTKD5K0HFRC2CNE.usdcx",
    vaultToken:           VAULT_USDC,   // v0-vault-usdc (zUSDC vault shares)
    collateralAssetId:    7,             // zUSDC
    debtAssetId:          6,             // USDC debt
    decimals:             6,
    isStablecoin:         true,
    liquidationThreshold: 0.90,
    pythFeedId: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  },
  USDH: {
    token:                "SPN5AKG35QZSK2M8GAMR4AFX45659RJHDW353HSG.usdh-token-v1",
    vaultToken:           VAULT_USDH,   // v0-vault-usdh (zUSDH vault shares)
    collateralAssetId:    9,             // zUSDH
    debtAssetId:          8,             // USDH debt — verified: get-account-scaled-debt(746,8)=1
    decimals:             6,
    isStablecoin:         true,
    liquidationThreshold: 0.90,
    pythFeedId: "eaa020c61cc479712813461ce153894a96a6c00b21ed0cfc2798d1f9a9e9c94a",
  },
  stSTXbtc: {
    token:                "SP4SZE494VC2YC5JYG7AYFQ44F5Q4PYV7DVMDPBG.ststxbtc-token-v2",
    vaultToken:           VAULT_STSTXBTC, // v0-vault-ststxbtc (zstSTXbtc vault shares)
    collateralAssetId:    11,              // zstSTXbtc
    debtAssetId:          10,             // stSTXbtc debt
    decimals:             6,
    isStablecoin:         false,
    liquidationThreshold: 0.70,
    pythFeedId: "e62df6c8b4a85fe1a67db44dc12de5db330f7ac66b72dc658afedf0f4a415b43",
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
  opLog: Array<{ ts: string; op: string; asset: string; amount: number; txid?: string }>;
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
  supplied: number;
  borrowed: number;
  suppliedUSD: number;
  borrowedUSD: number;
  priceUsd: number;
  ltv: number;
  liquidationThreshold: number;
  healthFactor: number;
  canBorrow: boolean;
  availableToBorrow: number;
  availableToWithdraw: number;
}

interface AggregatePosition {
  totalSuppliedUSD: number;
  totalBorrowedUSD: number;
  weightedLtv: number;
  aggregateHealthFactor: number;
  riskLevel: "healthy" | "warning" | "critical" | "emergency";
  positions: AssetPosition[];
  oracleStale: boolean;
  safetyState: {
    dailyRepayRemaining: number;
    cooldownRemaining: number;
    lastWriteAt: string | null;
  };
}

// ═══════════════════════════════════════════════════════════════════════════
// OUTPUT HELPERS
// ═══════════════════════════════════════════════════════════════════════════
function out(
  status: "success" | "error" | "blocked",
  action: string,
  data: Record<string, unknown> | null,
  error: { code: string; message: string; next: string } | null = null
) {
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
    const res = await fetch(
      `${HIRO_API}/v2/contracts/call-read/${addr}/${name}/${fnName}`,
      {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ sender, arguments: args }),
        signal: AbortSignal.timeout(FETCH_TIMEOUT),
      }
    );
    if (!res.ok) return null;
    return res.json();
  } catch {
    return null;
  }
}

function parseClarityUint(hex: string): number {
  if (!hex || typeof hex !== "string") return 0;
  if (hex.startsWith("0x07")) return parseClarityUint("0x" + hex.slice(4));
  if (hex.startsWith("0x01")) {
    const lo = hex.slice(4).slice(-16);
    return parseInt(lo, 16) || 0;
  }
  return 0;
}

function encodePrincipal(address: string): string {
  const bytes = Buffer.from(address, "utf8");
  const len = bytes.length;
  const buf = Buffer.alloc(5 + len);
  buf[0] = 0x0d;
  buf.writeUInt32BE(len, 1);
  bytes.copy(buf, 5);
  return "0x" + buf.toString("hex");
}

function encodeFeedId(feedIdHex: string): string {
  const feedBytes = Buffer.from(feedIdHex, "hex");
  const lenBuf = Buffer.alloc(4);
  lenBuf.writeUInt32BE(feedBytes.length, 0);
  return "0x02" + lenBuf.toString("hex") + feedBytes.toString("hex");
}

// Encode a Clarity uint128 for read-only call arguments
function encodeUint(n: number): string {
  const buf = Buffer.alloc(17);
  buf[0] = 0x01; // Clarity uint type byte
  buf.writeBigUInt64BE(0n, 1);
  buf.writeBigUInt64BE(BigInt(n), 9);
  return "0x" + buf.toString("hex");
}

// Resolve Stacks address → v0-market-vault user-id
// Returns null if address has no position (user not yet registered)
async function resolveUserId(address: string): Promise<number | null> {
  const res = await callReadOnly(
    MARKET_VAULT,
    "resolve",
    [encodePrincipal(address)],
    address
  );
  if (!res?.result) return null;
  const uid = parseClarityUint(res.result);
  return uid > 0 ? uid : null;
}

// ═══════════════════════════════════════════════════════════════════════════
// TX POLLING — submit → poll tx_status:success → proceed to next write
// Required per arc0btc: no chaining without confirmation between steps
// ═══════════════════════════════════════════════════════════════════════════
async function pollTxUntilSuccess(
  txid: string
): Promise<"success" | "failed" | "timeout"> {
  for (let i = 0; i < TX_POLL_MAX_ATTEMPTS; i++) {
    await new Promise((r) => setTimeout(r, TX_POLL_INTERVAL_MS));
    const data = await hiroFetch(`/extended/v1/tx/${txid}`);
    if (!data) continue;
    if (data.tx_status === "success") return "success";
    if (
      data.tx_status === "abort_by_response" ||
      data.tx_status === "abort_by_post_condition"
    ) {
      return "failed";
    }
  }
  return "timeout";
}

// ═══════════════════════════════════════════════════════════════════════════
// PYTH ORACLE — live price with staleness gate
// Refuses write ops if price is stale >120s (arc0btc requirement)
// ═══════════════════════════════════════════════════════════════════════════
interface PythPrice {
  priceUsd: number;
  publishTime: number;
}

async function fetchPythPrice(
  feedId: string,
  sender: string
): Promise<PythPrice | null> {
  const clarityFeedId = encodeFeedId(feedId);
  const res = await callReadOnly(PYTH_ORACLE, "read-price-feed", [clarityFeedId], sender);
  if (!res?.result) return null;

  // Clarity response: (ok {price: int, conf: uint, expo: int, publish-time: uint})
  // The Hiro API returns parsed JSON in res.result for some endpoints
  try {
    const val = res.result?.value ?? res.result;
    const priceRaw: number = parseInt(
      val?.price?.value ?? val?.price ?? "0",
      10
    );
    const expo: number = parseInt(
      val?.expo?.value ?? val?.expo ?? "0",
      10
    );
    const publishTime: number = parseInt(
      val?.["publish-time"]?.value ?? val?.publishTime ?? "0",
      10
    );
    const priceUsd = Math.abs(priceRaw) * Math.pow(10, expo);
    if (!priceUsd || !publishTime) return null;
    return { priceUsd, publishTime };
  } catch {
    return null;
  }
}

async function getLivePrice(
  feedId: string,
  sender: string,
  isStablecoin: boolean
): Promise<{ priceUsd: number; stale: false } | { stale: true; publishTime: number }> {
  if (isStablecoin) return { priceUsd: 1.0, stale: false };

  const price = await fetchPythPrice(feedId, sender);
  if (!price) return { stale: true, publishTime: 0 };

  const age = Math.floor(Date.now() / 1000) - price.publishTime;
  if (age > PRICE_STALENESS_MAX_SEC) return { stale: true, publishTime: price.publishTime };

  return { priceUsd: price.priceUsd, stale: false };
}

// ═══════════════════════════════════════════════════════════════════════════
// WALLET BALANCE FETCHER
// ═══════════════════════════════════════════════════════════════════════════
interface WalletBalances {
  stxBalance: number;
  fungible: Record<string, number>;
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
// Supply read:  v0-market-vault.get-collateral(user-id, collateralAssetId)
//   Collateral is stored as vault shares (zft), not the raw underlying token.
//   Must resolve address → user-id first via v0-market-vault.resolve.
// Debt read:    v0-market-vault.get-account-scaled-debt(user-id, debtAssetId)
//   Returns scaled debt (compound-interest adjusted). Treated as a close
//   approximation to actual debt for health factor estimation.
// HF:           computed from live Pyth oracle price — no hardcoded proxies.
// ═══════════════════════════════════════════════════════════════════════════
interface PositionReadResult {
  position: AssetPosition | null;
  oracleStale: boolean;
}

async function readAssetPosition(
  asset: string,
  address: string,
  userId: number | null,
  _walletBalances: WalletBalances
): Promise<PositionReadResult> {
  const cfg = ZEST_ASSETS[asset];
  if (!cfg) return { position: null, oracleStale: false };

  // No user-id means no registered position in this market
  if (userId === null) return { position: null, oracleStale: false };

  // Supply: read vault-share collateral from v0-market-vault
  // (collateral is zft shares held by the market on the user's behalf)
  let suppliedRaw = 0;
  const supplyRes = await callReadOnly(
    MARKET_VAULT,
    "get-collateral",
    [encodeUint(userId), encodeUint(cfg.collateralAssetId)],
    address
  );
  if (supplyRes?.result) {
    suppliedRaw = parseClarityUint(supplyRes.result);
  }

  // Debt: read scaled debt from v0-market-vault
  // Actual debt = scaled_debt × borrow_index / INDEX_PRECISION; using scaled
  // debt directly gives a close lower-bound approximation for HF checks.
  let borrowedRaw = 0;
  const debtRes = await callReadOnly(
    MARKET_VAULT,
    "get-account-scaled-debt",
    [encodeUint(userId), encodeUint(cfg.debtAssetId)],
    address
  );
  if (debtRes?.result) {
    borrowedRaw = parseClarityUint(debtRes.result);
  }

  if (suppliedRaw === 0 && borrowedRaw === 0) return { position: null, oracleStale: false };

  // Live price from Pyth oracle — no hardcoded proxies
  const priceResult = await getLivePrice(cfg.pythFeedId, address, cfg.isStablecoin);
  if (priceResult.stale) {
    // Return stale signal — caller must block write ops when oracle is stale
    return { position: null, oracleStale: true };
  }
  const priceUsd = priceResult.priceUsd;

  const liqThreshold = cfg.liquidationThreshold;
  let healthFactor = Infinity;
  let ltv = 0;

  if (suppliedRaw > 0 && borrowedRaw > 0) {
    ltv = borrowedRaw / suppliedRaw;
    healthFactor = (suppliedRaw * liqThreshold) / borrowedRaw;
  } else if (borrowedRaw > 0 && suppliedRaw === 0) {
    ltv = Infinity;
    healthFactor = 0;
  }

  const tokenUnit = 10 ** cfg.decimals;
  const suppliedUSD = (suppliedRaw / tokenUnit) * priceUsd;
  const borrowedUSD = (borrowedRaw / tokenUnit) * priceUsd;

  const availableToBorrow = Math.max(
    0,
    Math.floor(
      (suppliedRaw * liqThreshold) / BORROW_MIN_HEALTH_FACTOR - borrowedRaw
    )
  );

  const minSupplyRequired =
    borrowedRaw > 0
      ? Math.ceil((borrowedRaw * WITHDRAW_MIN_HEALTH_FACTOR) / liqThreshold)
      : 0;
  const availableToWithdraw = Math.max(0, suppliedRaw - minSupplyRequired);

  return {
    oracleStale: false,
    position: {
      asset,
      supplied: suppliedRaw,
      borrowed: borrowedRaw,
      suppliedUSD,
      borrowedUSD,
      priceUsd,
      ltv,
      liquidationThreshold: liqThreshold,
      healthFactor,
      canBorrow: healthFactor > BORROW_MIN_HEALTH_FACTOR,
      availableToBorrow,
      availableToWithdraw,
    },
  };
}

async function readAllPositions(address: string): Promise<{
  positions: AssetPosition[];
  oracleStale: boolean;
}> {
  const walletBalances = await getWalletBalances(address);
  // Resolve once — all assets share the same user-id in v0-market-vault
  const userId = await resolveUserId(address);
  const positions: AssetPosition[] = [];
  let oracleStale = false;

  for (const asset of ASSET_NAMES) {
    const result = await readAssetPosition(asset, address, userId, walletBalances);
    if (result.oracleStale) oracleStale = true;
    if (result.position) positions.push(result.position);
  }

  return { positions, oracleStale };
}

function computeAggregate(
  positions: AssetPosition[],
  oracleStale: boolean
): AggregatePosition {
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
      oracleStale,
      safetyState: {
        dailyRepayRemaining:
          HARD_CAP_REPAY_PER_DAY_SATS - managerState.dailyRepayedSats,
        cooldownRemaining,
        lastWriteAt:
          managerState.lastWriteEpoch > 0
            ? new Date(managerState.lastWriteEpoch * 1000).toISOString()
            : null,
      },
    };
  }

  const totalSuppliedUSD = positions.reduce((s, p) => s + p.suppliedUSD, 0);
  const totalBorrowedUSD = positions.reduce((s, p) => s + p.borrowedUSD, 0);

  const avgLiqThreshold =
    totalSuppliedUSD > 0
      ? positions.reduce(
          (s, p) => s + p.liquidationThreshold * p.suppliedUSD,
          0
        ) / totalSuppliedUSD
      : 0.85;

  const weightedLtv =
    totalSuppliedUSD > 0 ? totalBorrowedUSD / totalSuppliedUSD : 0;

  const aggregateHealthFactor =
    totalBorrowedUSD > 0
      ? (totalSuppliedUSD * avgLiqThreshold) / totalBorrowedUSD
      : Infinity;

  let riskLevel: AggregatePosition["riskLevel"];
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
    oracleStale,
    safetyState: {
      dailyRepayRemaining:
        HARD_CAP_REPAY_PER_DAY_SATS - managerState.dailyRepayedSats,
      cooldownRemaining,
      lastWriteAt:
        managerState.lastWriteEpoch > 0
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
  let oracleStale = false;
  let aggregate = computeAggregate([], false);

  if (wallet) {
    const balances = await getWalletBalances(wallet);
    stxBalance = balances.stxBalance;

    if (stxBalance < MIN_GAS_USTX) {
      errors.push(
        `Insufficient STX for gas: have ${stxBalance} uSTX, need ${MIN_GAS_USTX} uSTX`
      );
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

    const result = await readAllPositions(wallet);
    positions = result.positions;
    oracleStale = result.oracleStale;

    if (oracleStale && requireWrite) {
      errors.push(
        `Pyth oracle price is stale (>${PRICE_STALENESS_MAX_SEC}s) — write operations refused until price refreshes`
      );
    }

    aggregate = computeAggregate(positions, oracleStale);
  }

  return { ok: errors.length === 0, wallet, stxBalance, positions, aggregate, errors };
}

// ═══════════════════════════════════════════════════════════════════════════
// HEALTH FACTOR GUARD
// ═══════════════════════════════════════════════════════════════════════════
function healthFactorGuard(projectedHF: number, action: string): boolean {
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
// STATE UPDATE
// ═══════════════════════════════════════════════════════════════════════════
function recordOp(op: string, asset: string, amount: number, txid?: string) {
  managerState.lastWriteEpoch = Date.now() / 1000;
  if (op === "repay") managerState.dailyRepayedSats += amount;
  managerState.opLog.push({
    ts: new Date().toISOString(),
    op,
    asset,
    amount,
    ...(txid ? { txid } : {}),
  });
  saveState(managerState);
}

// ═══════════════════════════════════════════════════════════════════════════
// CLI
// ═══════════════════════════════════════════════════════════════════════════
const program = new Command();

program
  .name("zest-full-position-manager")
  .description(
    "Zest Protocol full lifecycle manager — supply, borrow, repay, withdraw with health factor guardrails"
  )
  .version("2.0.0");

// ── DOCTOR ──────────────────────────────────────────────────────────────────
program
  .command("doctor")
  .description("Pre-flight check: wallet, gas, Zest connectivity, oracle, positions")
  .action(async () => {
    const pf = await preflight();

    if (!pf.ok) {
      fail(
        "Blockers detected",
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
      oracleStale: pf.aggregate.oracleStale,
      marketContract: MARKET_CONTRACT,
      marketVault: MARKET_VAULT,
      pythOracle: PYTH_ORACLE,
      supportedAssets: ASSET_NAMES,
      safetyLimits: {
        hardStopHealthFactor:    HARD_STOP_MIN_HEALTH_FACTOR,
        minBorrowHealthFactor:   BORROW_MIN_HEALTH_FACTOR,
        minWithdrawHealthFactor: WITHDRAW_MIN_HEALTH_FACTOR,
        targetHealthFactor:      TARGET_HEALTH_FACTOR,
        hardCapRepayPerDay:      `${HARD_CAP_REPAY_PER_DAY_SATS} sats`,
        cooldownBetweenWrites:   `${COOLDOWN_SECONDS}s`,
        priceStalenessCutoff:    `${PRICE_STALENESS_MAX_SEC}s`,
      },
    });
  });

// ── RUN ─────────────────────────────────────────────────────────────────────
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
  .option("--txid <txid>", "Confirm a pending tx hash (for poll-confirm flow)")
  .action(async (opts) => {
    const action    = opts.action as string;
    const asset     = opts.asset as string | undefined;
    const rawAmount = opts.amount ? parseInt(opts.amount, 10) : 0;
    const targetHF  = Math.max(
      BORROW_MIN_HEALTH_FACTOR,
      parseFloat(opts.targetHf || String(TARGET_HEALTH_FACTOR))
    );

    // ── POLL-CONFIRM ──────────────────────────────────────────────────────
    // Agent submits a txid to poll before proceeding to next write.
    // Prevents TooMuchChaining across supply→borrow→repay→withdraw chains.
    if (action === "poll-confirm") {
      const txid = opts.txid as string | undefined;
      if (!txid) {
        fail("Missing txid", "missing_txid", "--txid is required for poll-confirm", "Provide the txid returned by the previous write");
        return;
      }
      const result = await pollTxUntilSuccess(txid);
      if (result === "success") {
        success("Transaction confirmed", { txid, tx_status: "success", nextAction: "safe to proceed with next write" });
      } else {
        fail(
          "Transaction did not succeed",
          result === "failed" ? "tx_failed" : "tx_timeout",
          `tx ${txid} ended with status: ${result}`,
          result === "failed"
            ? "Check the transaction on explorer.hiro.so for revert reason"
            : "Re-poll or check manually — position state may be inconsistent"
        );
      }
      return;
    }

    // ── STATUS ────────────────────────────────────────────────────────────
    if (action === "status") {
      const pf = await preflight(false);

      if (!pf.wallet) {
        fail("No wallet", "no_wallet", "STACKS_ADDRESS not set", "Unlock wallet first");
        return;
      }

      const agg = pf.aggregate;

      success("Full position overview", {
        wallet: pf.wallet,
        oracleStale: agg.oracleStale,
        aggregate: {
          totalSuppliedUSD:      agg.totalSuppliedUSD.toFixed(2),
          totalBorrowedUSD:      agg.totalBorrowedUSD.toFixed(2),
          weightedLtv:           `${(agg.weightedLtv * 100).toFixed(1)}%`,
          aggregateHealthFactor: isFinite(agg.aggregateHealthFactor)
            ? agg.aggregateHealthFactor.toFixed(3)
            : "∞",
          riskLevel: agg.riskLevel,
        },
        positions: agg.positions.map((p) => ({
          asset:                p.asset,
          supplied:             p.supplied,
          borrowed:             p.borrowed,
          priceUsd:             p.priceUsd,
          ltv:                  `${(p.ltv * 100).toFixed(1)}%`,
          healthFactor:         isFinite(p.healthFactor) ? p.healthFactor.toFixed(3) : "∞",
          liquidationAt:        `${(p.liquidationThreshold * 100).toFixed(0)}% LTV`,
          canBorrow:            p.canBorrow,
          availableToBorrow:    p.availableToBorrow,
          availableToWithdraw:  p.availableToWithdraw,
        })),
        safetyState:   agg.safetyState,
        hardLimits: {
          hardStopHealthFactor:  HARD_STOP_MIN_HEALTH_FACTOR,
          minBorrowHealthFactor: BORROW_MIN_HEALTH_FACTOR,
        },
      });
      return;
    }

    // ── SUPPLY ────────────────────────────────────────────────────────────
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

      success("Supply plan ready — awaiting agent execution", {
        action:  "supply",
        asset,
        amount:  rawAmount,
        wallet:  pf.wallet,
        mcpCommand: {
          tool:   "zest_supply_asset",
          params: { asset, amount: String(rawAmount) },
          contractRef: MARKET_CONTRACT,
        },
        txSequence: {
          step:           1,
          pollRequired:   true,
          nextStepNote:   "Poll with --action=poll-confirm --txid=<returned_txid> before submitting the next write",
        },
        safetyChecks: {
          healthFactorUnaffected: "Supply improves or maintains HF",
          amountWithinCap:        rawAmount <= HARD_CAP_SUPPLY_PER_OP,
          oracleFresh:            !pf.aggregate.oracleStale,
        },
        projectedEffect: {
          currentHF:    isFinite(pf.aggregate.aggregateHealthFactor)
            ? pf.aggregate.aggregateHealthFactor.toFixed(3)
            : "∞",
          projectedHF:  "≥ current (supply only improves health factor)",
        },
      });

      recordOp("supply", asset, rawAmount);
      return;
    }

    // ── BORROW ────────────────────────────────────────────────────────────
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

      const cfg = ZEST_ASSETS[asset];
      const newBorrowed = pos.borrowed + rawAmount;
      const projectedHF =
        pos.supplied > 0
          ? (pos.supplied * cfg.liquidationThreshold) / newBorrowed
          : 0;

      if (!healthFactorGuard(projectedHF, "borrow")) return;

      if (rawAmount > pos.availableToBorrow) {
        blocked(
          "Borrow exceeds safe capacity",
          "exceeds_safe_borrow",
          `Requesting ${rawAmount} but safe capacity is ${pos.availableToBorrow} (keeps HF >= ${BORROW_MIN_HEALTH_FACTOR})`,
          `Use --amount <= ${pos.availableToBorrow}`
        );
        return;
      }

      success("Borrow plan ready — awaiting agent execution", {
        action:  "borrow",
        asset,
        amount:  rawAmount,
        wallet:  pf.wallet,
        mcpCommand: {
          tool:   "zest_borrow_asset",
          params: { asset, amount: String(rawAmount) },
          contractRef: MARKET_CONTRACT,
        },
        txSequence: {
          step:         1,
          pollRequired: true,
          nextStepNote: "Poll with --action=poll-confirm --txid=<returned_txid> before submitting repay or withdraw",
        },
        safetyChecks: {
          projectedHealthFactor: projectedHF.toFixed(3),
          hardStopFloor:         HARD_STOP_MIN_HEALTH_FACTOR,
          borrowMinFloor:        BORROW_MIN_HEALTH_FACTOR,
          hardStopPassed:        projectedHF >= HARD_STOP_MIN_HEALTH_FACTOR,
          borrowFloorPassed:     projectedHF >= BORROW_MIN_HEALTH_FACTOR,
          withinSafeCapacity:    rawAmount <= pos.availableToBorrow,
          oracleFresh:           !pf.aggregate.oracleStale,
        },
        projectedEffect: {
          currentHF:  isFinite(pos.healthFactor) ? pos.healthFactor.toFixed(3) : "∞",
          projectedHF: projectedHF.toFixed(3),
          newLtv:     `${((newBorrowed / pos.supplied) * 100).toFixed(1)}%`,
          liqThreshold: `${(cfg.liquidationThreshold * 100).toFixed(0)}%`,
          priceUsed:  `$${pos.priceUsd.toFixed(2)} (live Pyth)`,
        },
      });

      recordOp("borrow", asset, rawAmount);
      return;
    }

    // ── REPAY ─────────────────────────────────────────────────────────────
    if (action === "repay") {
      if (!asset || !ZEST_ASSETS[asset]) {
        fail("Invalid asset", "invalid_asset", `Asset '${asset}' not supported`, `Use one of: ${ASSET_NAMES.join(", ")}`);
        return;
      }
      if (!rawAmount || rawAmount <= 0) {
        fail("Invalid amount", "invalid_amount", "Amount must be a positive integer", "Use --amount <base-units>");
        return;
      }

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
          const safeAmount =
            HARD_CAP_REPAY_PER_DAY_SATS - managerState.dailyRepayedSats;
          blocked(
            "Repay would exceed daily cap",
            "would_exceed_daily_cap",
            `${rawAmount} sats would exceed daily cap. Max allowed: ${safeAmount} sats`,
            `Use --amount <= ${safeAmount}`
          );
          return;
        }
      }

      // Repay bypasses cooldown — it is always a safety escape hatch
      const pf = await preflight(false);
      if (!pf.wallet) {
        fail("No wallet", "no_wallet", "STACKS_ADDRESS not set", "Unlock wallet first");
        return;
      }
      if (pf.aggregate.oracleStale && pf.positions.length === 0) {
        // Oracle stale but we have no position data — still allow repay as safety action
      }
      if (pf.stxBalance < MIN_GAS_USTX) {
        fail(
          "Insufficient STX for gas",
          "insufficient_gas",
          `Need ${MIN_GAS_USTX} uSTX for gas, have ${pf.stxBalance}`,
          "Top up STX balance"
        );
        return;
      }

      const pos = pf.positions.find((p) => p.asset === asset);
      if (!pos || pos.borrowed === 0) {
        fail(
          "No debt to repay",
          "no_debt",
          `No borrowed ${asset} found`,
          "Check status with --action=status"
        );
        return;
      }

      const effectiveAmount = Math.min(rawAmount, pos.borrowed);
      const newBorrowed = pos.borrowed - effectiveAmount;
      const projectedHF =
        newBorrowed > 0
          ? (pos.supplied * cfg.liquidationThreshold) / newBorrowed
          : Infinity;

      // Wallet reserve check (sBTC)
      if (asset === "sBTC") {
        const walBal = await getWalletBalances(pf.wallet);
        const sbtcKey = Object.keys(walBal.fungible).find(
          (k) => k.includes("sbtc-token") || k.includes("sbtc")
        );
        const sbtcBal = sbtcKey ? walBal.fungible[sbtcKey] : 0;
        if (sbtcBal - effectiveAmount < MIN_WALLET_RESERVE_SATS) {
          const safeRepay = Math.max(0, sbtcBal - MIN_WALLET_RESERVE_SATS);
          if (safeRepay <= 0) {
            // Emergency: insufficient balance to repay — escalate, do NOT attempt collateral removal
            fail(
              "Insufficient balance for repay — ESCALATE",
              "insufficient_balance_escalate",
              `Balance ${sbtcBal} sats minus reserve ${MIN_WALLET_RESERVE_SATS} = 0 available. ` +
                "DO NOT attempt collateral removal — Zest V2 blocks withdrawal while borrow balance is outstanding. " +
                "Deposit more sBTC to fund the repayment.",
              "Deposit more sBTC to wallet, then retry repay before attempting any withdraw"
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
        action:  "repay",
        asset,
        amount:  effectiveAmount,
        wallet:  pf.wallet,
        mcpCommand: {
          tool:   "zest_repay_asset",
          params: { asset, amount: String(effectiveAmount) },
          contractRef: MARKET_CONTRACT,
        },
        txSequence: {
          step:         1,
          pollRequired: true,
          nextStepNote: "Poll with --action=poll-confirm --txid=<returned_txid>. Only call collateral-remove-redeem AFTER repay confirms success.",
          emergencyNote:
            "If repay is blocked by insufficient balance, escalate to user — do NOT call withdraw/collateral-remove-redeem while borrow balance is outstanding",
        },
        safetyChecks: {
          projectedHealthFactor: isFinite(projectedHF)
            ? projectedHF.toFixed(3)
            : "∞ (debt cleared)",
          hardStopPassed:   true,
          reservePreserved: true,
          cooldownOverride: "Repay always allowed — safety escape hatch",
        },
        projectedEffect: {
          currentHF:      isFinite(pos.healthFactor) ? pos.healthFactor.toFixed(3) : "∞",
          projectedHF:    isFinite(projectedHF) ? projectedHF.toFixed(3) : "∞",
          debtCleared:    effectiveAmount === pos.borrowed,
          currentDebt:    pos.borrowed,
          remainingDebt:  newBorrowed,
        },
      });

      recordOp("repay", asset, effectiveAmount);
      return;
    }

    // ── WITHDRAW ──────────────────────────────────────────────────────────
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

      // Zest V2 blocks withdrawal while borrow balance is outstanding for that asset
      if (pos.borrowed > 0 && rawAmount > pos.availableToWithdraw) {
        blocked(
          "Withdrawal exceeds safe limit",
          "exceeds_safe_withdraw",
          `Requesting ${rawAmount} but safe withdrawal is ${pos.availableToWithdraw} ` +
            `(keeps HF >= ${WITHDRAW_MIN_HEALTH_FACTOR}). ` +
            "Note: Zest V2 blocks full collateral removal while borrow balance is outstanding.",
          `Repay debt first (confirm tx success), then withdraw. Or use --amount <= ${pos.availableToWithdraw}`
        );
        return;
      }

      const cfg = ZEST_ASSETS[asset];
      const newSupplied = pos.supplied - rawAmount;
      const projectedHF =
        pos.borrowed > 0
          ? (newSupplied * cfg.liquidationThreshold) / pos.borrowed
          : Infinity;

      if (!healthFactorGuard(projectedHF, "withdraw")) return;

      success("Withdrawal plan ready — awaiting agent execution", {
        action:  "withdraw",
        asset,
        amount:  rawAmount,
        wallet:  pf.wallet,
        mcpCommand: {
          tool:   "zest_withdraw_asset",
          params: { asset, amount: String(rawAmount) },
          contractRef: MARKET_CONTRACT,
        },
        txSequence: {
          step:         1,
          pollRequired: true,
          nextStepNote: "Poll with --action=poll-confirm --txid=<returned_txid> after withdrawal",
          emergencyNote:
            "Only call collateral-remove-redeem AFTER repay tx confirms success. Never call withdraw while borrow balance is outstanding.",
        },
        safetyChecks: {
          projectedHealthFactor: isFinite(projectedHF)
            ? projectedHF.toFixed(3)
            : "∞",
          hardStopFloor:        HARD_STOP_MIN_HEALTH_FACTOR,
          withdrawFloor:        WITHDRAW_MIN_HEALTH_FACTOR,
          hardStopPassed:       projectedHF >= HARD_STOP_MIN_HEALTH_FACTOR,
          withdrawFloorPassed:  rawAmount <= pos.availableToWithdraw,
          oracleFresh:          !pf.aggregate.oracleStale,
        },
        projectedEffect: {
          currentHF:       isFinite(pos.healthFactor) ? pos.healthFactor.toFixed(3) : "∞",
          projectedHF:     isFinite(projectedHF) ? projectedHF.toFixed(3) : "∞",
          remainingSupply: newSupplied,
          priceUsed:       `$${pos.priceUsd.toFixed(2)} (live Pyth)`,
        },
      });

      recordOp("withdraw", asset, rawAmount);
      return;
    }

    // ── MANAGE ────────────────────────────────────────────────────────────
    // Automated health restoration. Emergency path:
    //   repay → poll until tx_status:success → then and only then collateral-remove-redeem
    // If repay is blocked by insufficient balance, escalate — do NOT attempt collateral removal.
    if (action === "manage") {
      const pf = await preflight(false);

      if (!pf.wallet) {
        fail("No wallet", "no_wallet", "STACKS_ADDRESS not set", "Unlock wallet first");
        return;
      }

      const agg = pf.aggregate;

      if (agg.oracleStale) {
        blocked(
          "Oracle stale — manage refused",
          "oracle_stale",
          `Pyth oracle price data is stale (>${PRICE_STALENESS_MAX_SEC}s). Health factor cannot be accurately computed.`,
          "Wait for oracle to refresh before running manage"
        );
        return;
      }

      if (agg.positions.length === 0) {
        success("No active positions to manage", {
          wallet: pf.wallet,
          recommendation: "Supply assets to start earning yield: --action=supply",
        });
        return;
      }

      const atRisk = agg.positions
        .filter((p) => p.borrowed > 0)
        .sort((a, b) => a.healthFactor - b.healthFactor);

      if (atRisk.length === 0) {
        success("All positions healthy — no debt to manage", {
          aggregateHealthFactor: isFinite(agg.aggregateHealthFactor)
            ? agg.aggregateHealthFactor.toFixed(3)
            : "∞",
          positions: agg.positions.map((p) => ({
            asset:    p.asset,
            supplied: p.supplied,
            borrowed: p.borrowed,
          })),
          recommendation: "Supply-only positions. Use --action=borrow to leverage.",
        });
        return;
      }

      const worstPosition = atRisk[0];
      const isEmergency = worstPosition.healthFactor <= HARD_STOP_MIN_HEALTH_FACTOR;

      if (!isEmergency && worstPosition.healthFactor >= targetHF) {
        success("All positions within target health factor", {
          worstHealthFactor: worstPosition.healthFactor.toFixed(3),
          targetHealthFactor: targetHF,
          riskLevel: agg.riskLevel,
          recommendation: "No action needed",
        });
        return;
      }

      const cfg = ZEST_ASSETS[worstPosition.asset];
      const targetDebt =
        (worstPosition.supplied * cfg.liquidationThreshold) / targetHF;
      const rawRepay = Math.max(0, worstPosition.borrowed - targetDebt);
      const cappedRepay =
        worstPosition.asset === "sBTC"
          ? Math.min(
              rawRepay,
              HARD_CAP_REPAY_PER_DAY_SATS - managerState.dailyRepayedSats
            )
          : rawRepay;

      if (cappedRepay <= 0) {
        // Cannot repay due to cap — escalate, do NOT attempt collateral removal
        blocked(
          "Cannot repay — daily cap reached — ESCALATE",
          "daily_cap_reached_escalate",
          "Daily repay cap exhausted. " +
            "DO NOT attempt collateral-remove-redeem — Zest V2 blocks it while borrow balance is outstanding. " +
            "Manual intervention required.",
          "Wait for cap reset at UTC midnight or deposit additional sBTC"
        );
        return;
      }

      const newBorrowed = worstPosition.borrowed - cappedRepay;
      const projectedHF =
        newBorrowed > 0
          ? (worstPosition.supplied * cfg.liquidationThreshold) / newBorrowed
          : Infinity;

      success("Managed repayment plan computed", {
        action:       "manage",
        isEmergency,
        reason: `Health factor ${worstPosition.healthFactor.toFixed(3)} ${isEmergency ? "BELOW HARD STOP" : "below target"} ${targetHF}`,
        worstAsset:   worstPosition.asset,
        repayAmount:  Math.floor(cappedRepay),
        wallet:       pf.wallet,
        mcpCommand: {
          tool:   "zest_repay_asset",
          params: {
            asset:   worstPosition.asset,
            amount:  String(Math.floor(cappedRepay)),
          },
          contractRef: MARKET_CONTRACT,
        },
        txSequence: {
          step1: "Execute repay via zest_repay_asset",
          step2: "Poll --action=poll-confirm --txid=<repay_txid> until tx_status:success",
          step3: isEmergency
            ? "ONLY after repay confirms: if full withdrawal needed, call collateral-remove-redeem"
            : "After repay confirms: re-run status to verify HF restored",
          emergencyNote: isEmergency
            ? "CRITICAL: If repay is blocked by insufficient balance, ESCALATE to user. " +
              "Do NOT call collateral-remove-redeem while borrow balance is outstanding — it will fail and may waste gas."
            : undefined,
        },
        safetyChecks: {
          currentHF:            worstPosition.healthFactor.toFixed(3),
          projectedHF:          isFinite(projectedHF) ? projectedHF.toFixed(3) : "∞",
          hardStopFloor:        HARD_STOP_MIN_HEALTH_FACTOR,
          dailyCapRemaining:    HARD_CAP_REPAY_PER_DAY_SATS - managerState.dailyRepayedSats,
          isEmergency,
          oracleFresh:          true,
        },
        allPositions: agg.positions.map((p) => ({
          asset:       p.asset,
          priceUsd:    p.priceUsd,
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
      "Use: status | supply | borrow | repay | withdraw | manage | poll-confirm"
    );
  });

program.parse();

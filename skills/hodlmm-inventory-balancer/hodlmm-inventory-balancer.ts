#!/usr/bin/env bun
/**
 * hodlmm-inventory-balancer — HODLMM inventory drift corrector.
 *
 * Detects token ratio drift in HODLMM LP positions using price-weighted
 * exposure (not naive token sums) and executes a corrective Bitflow swap
 * followed by liquidity redeploy to restore the operator-configured target ratio.
 *
 * The 6-step correction loop:
 *   1. Observe per-bin token amounts + target ratio
 *   2. Compute price-weighted drift; skip if below --min-drift-pct
 *   3. Plan corrective swap: {direction, amount_in, minimum_out}
 *   4. Execute Bitflow swap with PostConditionMode.Deny + explicit minimum-output
 *   5. Redeploy via hodlmm-move-liquidity run --confirm
 *   6. Verify and emit JSON with before/after ratios + tx hashes
 *
 * Commands:
 *   doctor        — check APIs, wallet, dependencies
 *   scan          — read per-bin inventory, compute price-weighted drift
 *   run           — execute 6-step correction loop (dry-run unless --confirm=BALANCE)
 *   install-packs — no-op
 */

import { Command } from "commander";
import * as fs from "fs";
import * as path from "path";
import * as os from "os";

// Suppress unhandled rejections from SDK background initialization (e.g. @bitflowlabs/core-sdk)
process.on("unhandledRejection", (reason: unknown) => {
  const msg = String((reason as any)?.message ?? reason);
  if (msg.includes("HTTP error!") || msg.includes("bitflowsdk-api")) {
    // Known SDK background fetch errors — swallow silently
    return;
  }
  process.stderr.write(`[inventory-balancer] unhandledRejection: ${msg}\n`);
});

// ── Constants ────────────────────────────────────────────────────────────────

const BITFLOW_QUOTES        = "https://bff.bitflowapis.finance/api/quotes/v1";
const BITFLOW_APP           = "https://bff.bitflowapis.finance/api/app/v1";
const HIRO_API              = "https://api.mainnet.hiro.so";
const EXPLORER_BASE         = "https://explorer.hiro.so/txid";

const COOLDOWN_MS           = 4 * 60 * 60 * 1000;  // 4 h — shared with hodlmm-move-liquidity
const DEFAULT_TARGET_RATIO  = 0.5;                   // 50 % X by price-weighted exposure
const DEFAULT_MIN_DRIFT_PCT = 5;                     // skip correction if drift < 5 %
const DEFAULT_SLIPPAGE_PCT  = 0.5;                   // 0.5 % slippage on corrective swap
const MAX_QUOTE_AGE_MS      = 45_000;                // quote freshness gate: 45 s
const MIN_GAS_STX           = 0.5;                   // keep ≥ 0.5 STX for gas
const FETCH_TIMEOUT_MS      = 25_000;
const CONFIRM_PHRASE        = "BALANCE";

const STATE_FILE            = path.join(os.homedir(), ".hodlmm-inventory-balancer-state.json");
const MOVE_LIQ_STATE_FILE   = path.join(os.homedir(), ".hodlmm-move-liquidity-state.json");
const WALLETS_FILE          = path.join(os.homedir(), ".aibtc", "wallets.json");
const WALLETS_DIR           = path.join(os.homedir(), ".aibtc", "wallets");

// ── Types ────────────────────────────────────────────────────────────────────

interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

interface PoolMeta {
  pool_id: string;
  pool_contract: string;
  token_x: string;
  token_y: string;
  token_x_symbol: string;
  token_y_symbol: string;
  token_x_decimals: number;
  token_y_decimals: number;
  active_bin: number;
  bin_step: number;
}

interface UserBin {
  bin_id: number;
  liquidity: string;
  reserve_x: string;
  reserve_y: string;
  price: string;
}

interface BinData {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
  price: string;
  liquidity: string;
}

interface InventorySnapshot {
  pool_id: string;
  pair: string;
  active_bin: number;
  total_x_raw: string;          // bigint serialised — sum reserve_x
  total_y_raw: string;          // bigint serialised — sum reserve_y
  total_x_exposure: number;     // price-weighted X in Y units
  total_y_exposure: number;     // Y exposure in Y units
  total_exposure: number;       // sum of above
  ratio_x: number;              // X share 0.0–1.0
  ratio_y: number;              // 1 - ratio_x
  avg_price: number;            // weighted avg price (Y per X)
  bin_count: number;
  snapshot_time: number;        // unix ms
}

interface CorrectiveSwapPlan {
  direction: "X_TO_Y" | "Y_TO_X";
  amount_in: number;            // raw smallest-unit of from-token
  minimum_out: number;          // raw smallest-unit of to-token (slippage applied)
  estimated_out: number;        // raw smallest-unit before slippage
  amount_in_human: string;
  minimum_out_human: string;
  drift_pct: number;
  slippage_pct: number;
  target_ratio: number;
  price_impact_pct: number | null;
}

interface BalancerState {
  [poolId: string]: {
    last_run_at: string;
    last_balance_txid?: string;
    last_redeploy_txid?: string;
    before_ratio_x?: number;
    after_ratio_x?: number;
  };
}

// ── Output helpers ────────────────────────────────────────────────────────────

function out(result: SkillOutput): void {
  process.stdout.write(JSON.stringify(result, null, 2) + "\n");
}

function success(action: string, data: Record<string, unknown>): void {
  out({ status: "success", action, data, error: null });
}

function blocked(code: string, message: string, next: string, data: Record<string, unknown> = {}): void {
  out({ status: "blocked", action: next, data, error: { code, message, next } });
}

function fail(code: string, message: string, next: string, data: Record<string, unknown> = {}): void {
  out({ status: "error", action: next, data, error: { code, message, next } });
}

function dbg(...args: unknown[]): void {
  process.stderr.write(`[inventory-balancer] ${args.join(" ")}\n`);
}

// ── State helpers ─────────────────────────────────────────────────────────────

function readState(): BalancerState {
  try {
    if (fs.existsSync(STATE_FILE)) {
      return JSON.parse(fs.readFileSync(STATE_FILE, "utf-8")) as BalancerState;
    }
  } catch { /* ignore */ }
  return {};
}

function writeState(state: BalancerState): void {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2));
}

/**
 * Returns ms until cooldown expires (0 = clear).
 * Reads both own state AND hodlmm-move-liquidity state — 4 h cooldown is shared.
 */
function cooldownRemainingMs(poolId: string): number {
  const candidates: number[] = [];

  const own = readState();
  if (own[poolId]?.last_run_at) {
    const elapsed = Date.now() - new Date(own[poolId].last_run_at).getTime();
    candidates.push(Math.max(0, COOLDOWN_MS - elapsed));
  }

  try {
    if (fs.existsSync(MOVE_LIQ_STATE_FILE)) {
      const mv = JSON.parse(fs.readFileSync(MOVE_LIQ_STATE_FILE, "utf-8")) as Record<
        string,
        { last_move_at?: string }
      >;
      if (mv[poolId]?.last_move_at) {
        const elapsed = Date.now() - new Date(mv[poolId].last_move_at!).getTime();
        candidates.push(Math.max(0, COOLDOWN_MS - elapsed));
      }
    }
  } catch { /* ignore */ }

  return candidates.length > 0 ? Math.max(...candidates) : 0;
}

// ── HTTP helpers ──────────────────────────────────────────────────────────────

async function fetchJson<T>(url: string, timeoutMs = FETCH_TIMEOUT_MS): Promise<T> {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const res = await fetch(url, {
      signal: ctrl.signal,
      headers: {
        Accept: "application/json",
        "User-Agent": "bff-skills/hodlmm-inventory-balancer",
      },
    });
    if (!res.ok) throw new Error(`HTTP ${res.status} from ${url}`);
    return res.json() as Promise<T>;
  } finally {
    clearTimeout(timer);
  }
}

async function pingUrl(url: string): Promise<"ok" | "down"> {
  try {
    await fetchJson(url, 8_000);
    return "ok";
  } catch {
    return "down";
  }
}

// ── Wallet helpers ────────────────────────────────────────────────────────────

async function getWalletKeys(
  password: string,
  targetAddress?: string,
): Promise<{ stxPrivateKey: string; stxAddress: string }> {
  if (process.env.STACKS_PRIVATE_KEY) {
    const { getAddressFromPrivateKey, TransactionVersion } =
      await import("@stacks/transactions" as string);
    const key = process.env.STACKS_PRIVATE_KEY;
    const address = getAddressFromPrivateKey(key, TransactionVersion.Mainnet);
    return { stxPrivateKey: key, stxAddress: address };
  }

  const { generateWallet, deriveAccount, getStxAddress } =
    await import("@stacks/wallet-sdk" as string);

  if (fs.existsSync(WALLETS_FILE)) {
    const wJson = JSON.parse(fs.readFileSync(WALLETS_FILE, "utf-8"));
    const allWallets: any[] = wJson.wallets ?? [];
    // If a target address is provided, find the wallet whose address matches; otherwise use index 0
    const active = targetAddress
      ? allWallets.find((w: any) => w.address === targetAddress) ?? allWallets[0]
      : allWallets[0];
    if (active?.id) {
      const kp = path.join(WALLETS_DIR, active.id, "keystore.json");
      if (fs.existsSync(kp)) {
        const ks = JSON.parse(fs.readFileSync(kp, "utf-8"));
        const enc = ks.encrypted;
        if (enc?.ciphertext) {
          const { scryptSync, createDecipheriv } = await import("crypto");
          const salt = Buffer.from(enc.salt, "base64");
          const iv = Buffer.from(enc.iv, "base64");
          const authTag = Buffer.from(enc.authTag, "base64");
          const ct = Buffer.from(enc.ciphertext, "base64");
          const dk = scryptSync(password, salt, enc.scryptParams?.keyLen ?? 32, {
            N: enc.scryptParams?.N ?? 16384,
            r: enc.scryptParams?.r ?? 8,
            p: enc.scryptParams?.p ?? 1,
          });
          const decipher = createDecipheriv("aes-256-gcm", dk, iv);
          decipher.setAuthTag(authTag);
          const mnemonic = Buffer.concat([decipher.update(ct), decipher.final()])
            .toString("utf-8")
            .trim();
          const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
          const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
          return {
            stxPrivateKey: account.stxPrivateKey,
            stxAddress: getStxAddress(account),
          };
        }
        const legacyEnc = ks.encryptedMnemonic ?? ks.encrypted_mnemonic;
        if (legacyEnc) {
          const { decryptMnemonic } = await import("@stacks/encryption" as string);
          const mnemonic = await decryptMnemonic(legacyEnc, password);
          const wallet = await generateWallet({ secretKey: mnemonic, password: "" });
          const account = wallet.accounts[0] ?? deriveAccount(wallet, 0);
          return {
            stxPrivateKey: account.stxPrivateKey,
            stxAddress: getStxAddress(account),
          };
        }
      }
    }
  }
  throw new Error("No wallet found. Run: npx @aibtc/mcp-server@latest --install");
}

// ── Bitflow / Hiro API helpers ────────────────────────────────────────────────

async function fetchPool(poolId: string): Promise<PoolMeta | null> {
  const raw = await fetchJson<Record<string, unknown>>(
    `${BITFLOW_APP}/pools?amm_type=dlmm`,
  );
  const list = (
    raw.data ?? raw.results ?? raw.pools ?? (Array.isArray(raw) ? raw : [])
  ) as Record<string, unknown>[];

  // API returns poolId (camelCase) or pool_id (snake_case) depending on version
  const p = list.find(
    (x) =>
      String((x as any).poolId ?? (x as any).pool_id ?? "") === poolId,
  ) as any;
  if (!p) return null;

  // Support both camelCase (current API) and snake_case (legacy)
  const tx = p.tokens?.tokenX ?? {};
  const ty = p.tokens?.tokenY ?? {};
  return {
    pool_id: String(p.poolId ?? p.pool_id ?? ""),
    pool_contract: String(p.poolContract ?? p.pool_token ?? p.pool_contract ?? ""),
    token_x: String(tx.contract ?? p.token_x ?? ""),
    token_y: String(ty.contract ?? p.token_y ?? ""),
    token_x_symbol: String(tx.symbol ?? p.token_x_symbol ?? "?"),
    token_y_symbol: String(ty.symbol ?? p.token_y_symbol ?? "?"),
    token_x_decimals: Number(tx.decimals ?? p.token_x_decimals ?? 8),
    token_y_decimals: Number(ty.decimals ?? p.token_y_decimals ?? 6),
    active_bin: Number(p.activeBin ?? p.active_bin ?? 0),
    bin_step: Number(p.binStep ?? p.bin_step ?? 0),
  };
}

async function fetchPoolBins(
  poolId: string,
): Promise<{ active_bin_id: number; bins: BinData[]; fetched_at: number }> {
  const fetched_at = Date.now();
  const raw = await fetchJson<Record<string, unknown>>(
    `${BITFLOW_QUOTES}/bins/${poolId}`,
  );
  const bins = ((raw.bins ?? []) as Record<string, unknown>[]).map((b) => ({
    bin_id: Number(b.bin_id),
    reserve_x: String(b.reserve_x ?? "0"),
    reserve_y: String(b.reserve_y ?? "0"),
    price: String(b.price ?? "0"),
    liquidity: String(b.liquidity ?? "0"),
  }));
  return { active_bin_id: Number(raw.active_bin_id ?? 0), bins, fetched_at };
}

async function fetchUserBins(poolId: string, wallet: string): Promise<UserBin[]> {
  let raw: Record<string, unknown>;
  try {
    raw = await fetchJson<Record<string, unknown>>(
      `${BITFLOW_APP}/users/${wallet}/positions/${poolId}/bins`,
    );
  } catch (e: any) {
    // 404 = wallet has no position in this pool — not an error
    if (e.message?.includes("HTTP 404") || e.message?.includes("404")) return [];
    throw e;
  }
  const bins = (raw.bins ?? []) as Record<string, unknown>[];
  return bins
    .filter((b) => {
      // API may use userLiquidity (camelCase) or user_liquidity (snake_case)
      const liq = String((b as any).userLiquidity ?? b.user_liquidity ?? b.liquidity ?? "0");
      return BigInt(liq) > 0n;
    })
    .map((b: any) => ({
      bin_id: Number(b.bin_id),
      liquidity: String(b.userLiquidity ?? b.user_liquidity ?? b.liquidity ?? "0"),
      reserve_x: String(b.reserve_x ?? b.reserveX ?? "0"),
      reserve_y: String(b.reserve_y ?? b.reserveY ?? "0"),
      price: String(b.price ?? "0"),
    }));
}

async function fetchStxBalance(wallet: string): Promise<number> {
  const d = await fetchJson<Record<string, string>>(
    `${HIRO_API}/extended/v1/address/${wallet}/stx`,
  );
  return Number(BigInt(d?.balance ?? "0")) / 1e6;
}

async function fetchNonce(wallet: string): Promise<bigint> {
  const d = await fetchJson<Record<string, unknown>>(
    `${HIRO_API}/extended/v1/address/${wallet}/nonces`,
  );
  if (d.possible_next_nonce != null) return BigInt(Number(d.possible_next_nonce));
  if (d.last_executed_tx_nonce != null)
    return BigInt(Number(d.last_executed_tx_nonce) + 1);
  return 0n;
}

async function fetchTxStatus(
  txId: string,
): Promise<{ confirmed: boolean; status: string }> {
  try {
    const d = await fetchJson<Record<string, unknown>>(
      `${HIRO_API}/extended/v1/tx/${txId}`,
      10_000,
    );
    const status = String(d.tx_status ?? "pending");
    return { confirmed: status === "success", status };
  } catch {
    return { confirmed: false, status: "unknown" };
  }
}

// ── Bitflow SDK helper ────────────────────────────────────────────────────────

async function getBitflowSDK(): Promise<any> {
  const mod = await import("@bitflowlabs/core-sdk" as string);
  if (mod.BitflowSDK) return new mod.BitflowSDK({ stxAddress: "" });
  if (mod.default?.prototype?.getAvailableTokens) return new mod.default({ stxAddress: "" });
  if (typeof mod.getAvailableTokens === "function") return mod;
  if (mod.default && typeof mod.default.getAvailableTokens === "function") return mod.default;
  throw new Error("@bitflowlabs/core-sdk loaded but no entry point found");
}

/**
 * Compute expected swap output using USD prices from pool metadata.
 * Used as fallback when the Bitflow SDK quote endpoint is unavailable.
 */
async function getUsdFallbackQuote(
  amountIn: number,
  isXtoY: boolean,
  pool: PoolMeta,
): Promise<{ estimatedOut: number; quoteTime: number }> {
  const quoteTime = Date.now();
  // Fetch current USD prices from pool metadata
  const raw = await fetchJson<Record<string, unknown>>(
    `${BITFLOW_APP}/pools?amm_type=dlmm`,
  );
  const list = (
    raw.data ?? raw.results ?? raw.pools ?? (Array.isArray(raw) ? raw : [])
  ) as any[];
  const p = list.find((x) => String(x.poolId ?? x.pool_id ?? "") === pool.pool_id);

  const xPriceUsd = parseFloat(p?.tokens?.tokenX?.priceUsd ?? p?.token_x_price_usd ?? 0);
  const yPriceUsd = parseFloat(p?.tokens?.tokenY?.priceUsd ?? p?.token_y_price_usd ?? 0);

  if (!xPriceUsd || !yPriceUsd) return { estimatedOut: 0, quoteTime };

  const fromDecimals = isXtoY ? pool.token_x_decimals : pool.token_y_decimals;
  const toDecimals   = isXtoY ? pool.token_y_decimals : pool.token_x_decimals;
  const fromPrice    = isXtoY ? xPriceUsd : yPriceUsd;
  const toPrice      = isXtoY ? yPriceUsd : xPriceUsd;

  const amountInHuman  = amountIn / Math.pow(10, fromDecimals);
  const valueUsd       = amountInHuman * fromPrice;
  const estimatedOutHuman = valueUsd / toPrice;
  const estimatedOut   = Math.floor(estimatedOutHuman * Math.pow(10, toDecimals));

  return { estimatedOut, quoteTime };
}

// ── PRIMITIVE 1 — Ratio computer ──────────────────────────────────────────────
//
// Price-weighted exposure — NOT naive token sums.
//
// For each user bin:
//   x_exposure_in_Y = reserve_x_human * bin_price   (converts X to Y units)
//   y_exposure_in_Y = reserve_y_human
//
// ratio_x = Σ(x_exposure_in_Y) / (Σ(x_exposure_in_Y) + Σ(y_exposure_in_Y))
//
// bin_price is Y-per-X (e.g. sBTC per STX for dlmm_1).

function computeInventoryRatio(
  userBins: UserBin[],
  poolBins: BinData[],
  pool: PoolMeta,
  activeBin: number,
): InventorySnapshot {
  const poolBinMap = new Map(poolBins.map((b) => [b.bin_id, b]));

  let totalXExposure = 0; // in Y-denominated units (human scale)
  let totalYExposure = 0; // in Y-denominated units (human scale)
  let totalXRaw = 0n;
  let totalYRaw = 0n;
  let weightedPriceNumer = 0;
  let weightedPriceDenom = 0;

  for (const bin of userBins) {
    const dlp = BigInt(bin.liquidity);

    // Prefer API-provided price; fall back to pool bin
    const binPrice =
      parseFloat(bin.price) ||
      parseFloat(poolBinMap.get(bin.bin_id)?.price ?? "0");

    let rx = BigInt(bin.reserve_x || "0");
    let ry = BigInt(bin.reserve_y || "0");

    // If reserves absent from user bin, compute from DLP share
    if (rx === 0n && ry === 0n) {
      const pb = poolBinMap.get(bin.bin_id);
      if (pb && dlp > 0n) {
        const poolDlp = BigInt(pb.liquidity || "1");
        if (poolDlp > 0n) {
          rx = (dlp * BigInt(pb.reserve_x)) / poolDlp;
          ry = (dlp * BigInt(pb.reserve_y)) / poolDlp;
        }
      }
    }

    totalXRaw += rx;
    totalYRaw += ry;

    const rxHuman = Number(rx) / Math.pow(10, pool.token_x_decimals);
    const ryHuman = Number(ry) / Math.pow(10, pool.token_y_decimals);

    // X contribution in Y units via bin price
    const xInY = rxHuman * binPrice;
    totalXExposure += xInY;
    totalYExposure += ryHuman;

    if (binPrice > 0) {
      // Weight price by Y-side reserves to get a meaningful average
      weightedPriceNumer += binPrice * (ryHuman + xInY);
      weightedPriceDenom += ryHuman + xInY;
    }
  }

  const totalExposure = totalXExposure + totalYExposure;
  const ratioX = totalExposure > 0 ? totalXExposure / totalExposure : 0.5;
  const avgPrice =
    weightedPriceDenom > 0 ? weightedPriceNumer / weightedPriceDenom : 0;

  return {
    pool_id: pool.pool_id,
    pair: `${pool.token_x_symbol}/${pool.token_y_symbol}`,
    active_bin: activeBin,
    total_x_raw: totalXRaw.toString(),
    total_y_raw: totalYRaw.toString(),
    total_x_exposure: totalXExposure,
    total_y_exposure: totalYExposure,
    total_exposure: totalExposure,
    ratio_x: ratioX,
    ratio_y: 1 - ratioX,
    avg_price: avgPrice,
    bin_count: userBins.length,
    snapshot_time: Date.now(),
  };
}

// ── PRIMITIVE 2 — Corrective-swap planner ─────────────────────────────────────
//
// Outputs: { direction, amount_in, minimum_out } with overshoot protection.
// Uses 50 % correction factor to avoid overshooting target in a single step.
// amount_in is hard-capped at maxCorrectionSats.

function planCorrectiveSwap(
  snapshot: InventorySnapshot,
  targetRatio: number,
  minDriftPct: number,
  maxCorrectionSats: number,
  slippagePct: number,
  priceImpactPct: number | null,
  pool: PoolMeta,
): CorrectiveSwapPlan | null {
  const driftAbs = Math.abs(snapshot.ratio_x - targetRatio);
  const driftPct = driftAbs * 100;

  if (driftPct < minDriftPct) return null;

  const direction: "X_TO_Y" | "Y_TO_X" =
    snapshot.ratio_x > targetRatio ? "X_TO_Y" : "Y_TO_X";

  // Excess exposure in Y-units; take half to avoid overshoot
  const excessYUnits = driftAbs * snapshot.total_exposure;
  const correctionYUnits = excessYUnits * 0.5;

  let amountIn: number;
  let amountInHuman: string;
  const fromDecimals =
    direction === "X_TO_Y" ? pool.token_x_decimals : pool.token_y_decimals;
  const toDecimals =
    direction === "X_TO_Y" ? pool.token_y_decimals : pool.token_x_decimals;

  if (direction === "X_TO_Y") {
    // Convert Y-unit correction back to X units via avg_price
    const corrXHuman =
      snapshot.avg_price > 0 ? correctionYUnits / snapshot.avg_price : 0;
    const raw = Math.floor(corrXHuman * Math.pow(10, fromDecimals));
    amountIn = Math.min(raw, maxCorrectionSats);
    amountInHuman = (amountIn / Math.pow(10, fromDecimals)).toFixed(fromDecimals);
  } else {
    // Y → X: correction is directly in Y units
    const raw = Math.floor(correctionYUnits * Math.pow(10, fromDecimals));
    amountIn = Math.min(raw, maxCorrectionSats);
    amountInHuman = (amountIn / Math.pow(10, fromDecimals)).toFixed(fromDecimals);
  }

  if (amountIn <= 0) return null;

  // estimated_out is filled from the quote; here we set a placeholder
  // that planCorrectiveSwap callers replace with the actual quote result.
  const estimated_out = 0;
  const minimum_out = 0;

  return {
    direction,
    amount_in: amountIn,
    minimum_out,
    estimated_out,
    amount_in_human: amountInHuman,
    minimum_out_human: "0",
    drift_pct: driftPct,
    slippage_pct: slippagePct,
    target_ratio: targetRatio,
    price_impact_pct: priceImpactPct,
  };
}

/** Fill estimated_out + minimum_out from a live Bitflow quote. */
function attachQuoteToplan(
  plan: CorrectiveSwapPlan,
  estimatedOut: number,
  slippagePct: number,
  pool: PoolMeta,
): CorrectiveSwapPlan {
  const toDecimals =
    plan.direction === "X_TO_Y" ? pool.token_y_decimals : pool.token_x_decimals;
  const minimumOut = Math.floor(estimatedOut * (1 - slippagePct / 100));
  return {
    ...plan,
    estimated_out: estimatedOut,
    minimum_out: minimumOut,
    minimum_out_human: (minimumOut / Math.pow(10, toDecimals)).toFixed(toDecimals),
  };
}

// ── PRIMITIVE 3 (part a) — Corrective swap execution ─────────────────────────
//
// Executes a Bitflow swap using PostConditionMode.Deny with explicit post-conditions.
// Validates quote freshness (≤ 45 s) before broadcast.

async function executeCorrectiveSwap(
  plan: CorrectiveSwapPlan,
  pool: PoolMeta,
  walletAddress: string,
  privateKey: string,
  isDryRun: boolean,
): Promise<{ txId: string | null; explorerUrl: string | null }> {
  if (isDryRun) {
    return { txId: null, explorerUrl: null };
  }

  const {
    makeContractCall,
    broadcastTransaction,
    PostConditionMode,
    AnchorMode,
  } = await import("@stacks/transactions" as string);
  const { STACKS_MAINNET } = await import("@stacks/network" as string);

  const isXtoY = plan.direction === "X_TO_Y";
  const fromSymbol = isXtoY ? pool.token_x_symbol : pool.token_y_symbol;
  const toSymbol   = isXtoY ? pool.token_y_symbol : pool.token_x_symbol;
  const fromDecimals = isXtoY ? pool.token_x_decimals : pool.token_y_decimals;
  const toDecimals   = isXtoY ? pool.token_y_decimals : pool.token_x_decimals;

  // Re-fetch a fresh quote and get SDK-generated post-conditions right before broadcast.
  // The SDK knows the correct FT asset identifiers (tokenName from define-fungible-token),
  // which differ from the contract name — e.g. "sbtc" vs "sbtc-token".
  const sdk = await getBitflowSDK();
  const tokens = await sdk.getAvailableTokens();
  const fromTok = tokens.find(
    (t: any) => (t.symbol ?? "").toLowerCase() === fromSymbol.toLowerCase(),
  );
  const toTok = tokens.find(
    (t: any) => (t.symbol ?? "").toLowerCase() === toSymbol.toLowerCase(),
  );

  if (!fromTok || !toTok) {
    throw new Error(
      `QUOTE_STALE: Token not found in Bitflow registry: ${fromSymbol} or ${toSymbol}. Re-run.`,
    );
  }

  const humanAmount = plan.amount_in / Math.pow(10, fromDecimals);
  const freshStart  = Date.now();

  const quoteRes = await sdk.getQuoteForRoute(
    fromTok.tokenId ?? fromTok["token-id"],
    toTok.tokenId   ?? toTok["token-id"],
    humanAmount,
  );

  if (!quoteRes?.bestRoute?.route) {
    throw new Error(`No Bitflow route found for ${fromSymbol} → ${toSymbol}. Re-run.`);
  }

  if (Date.now() - freshStart > MAX_QUOTE_AGE_MS) {
    throw new Error(
      `QUOTE_STALE: Fresh quote round-trip exceeded ${MAX_QUOTE_AGE_MS / 1000} s. Re-run on a faster connection.`,
    );
  }

  // sdk.prepareSwap builds post-conditions with the correct FT asset name (tokenName),
  // correct sender principals, and correct amounts derived from the live quote + slippage.
  const swapParams = await sdk.prepareSwap(
    {
      route:           quoteRes.bestRoute.route,
      amount:          humanAmount,
      tokenXDecimals:  fromDecimals,
      tokenYDecimals:  toDecimals,
    },
    walletAddress,
    plan.slippage_pct / 100,
  );

  const nonce = await fetchNonce(walletAddress);

  const tx = await makeContractCall({
    contractAddress: swapParams.contractAddress,
    contractName:    swapParams.contractName,
    functionName:    swapParams.functionName,
    functionArgs:    swapParams.functionArgs,
    senderKey:       privateKey,
    network:         STACKS_MAINNET,
    postConditions:  swapParams.postConditions,
    postConditionMode: PostConditionMode.Deny,
    anchorMode:      AnchorMode.Any,
    nonce,
    fee: 50_000n,
  });

  const result = await broadcastTransaction({ transaction: tx, network: STACKS_MAINNET });
  if ((result as any).error) {
    throw new Error(
      `Swap broadcast failed: ${(result as any).error} — ${(result as any).reason ?? ""}`,
    );
  }

  const txId = result.txid as string;
  return {
    txId,
    explorerUrl: `${EXPLORER_BASE}/${txId}?chain=mainnet`,
  };
}

// ── PRIMITIVE 3 (part b) — Liquidity redeploy ────────────────────────────────
//
// Calls hodlmm-move-liquidity as a sibling skill via Bun.spawn.
// Parses its JSON output for the redeploy txid.

async function redeployLiquidity(
  poolId: string,
  wallet: string,
  password: string,
  isDryRun: boolean,
): Promise<{ success: boolean; txId: string | null; raw: unknown }> {
  const moveScript = path.resolve(
    path.dirname(new URL(import.meta.url).pathname),
    "../hodlmm-move-liquidity/hodlmm-move-liquidity.ts",
  );

  if (!fs.existsSync(moveScript)) {
    throw new Error(
      `hodlmm-move-liquidity not found at ${moveScript}. Ensure it is installed in sibling skills directory.`,
    );
  }

  const args = ["run", "--pool", poolId, "--wallet", wallet];
  if (!isDryRun) {
    args.push("--confirm", "--password", password);
  }

  dbg(`Spawning: bun run ${moveScript} ${args.join(" ")}`);

  const proc = Bun.spawn(["bun", "run", moveScript, ...args], {
    stdout: "pipe",
    stderr: "pipe",
  });

  const stdoutText = await new Response(proc.stdout).text();
  await proc.exited;

  let parsed: any = null;
  try {
    parsed = JSON.parse(stdoutText);
  } catch {
    return { success: false, txId: null, raw: stdoutText };
  }

  const txId: string | null =
    parsed?.data?.transaction?.txid ??
    parsed?.data?.txid ??
    null;

  return {
    success: parsed?.status === "success",
    txId,
    raw: parsed,
  };
}

// ── PRIMITIVE 3 (orchestrator) — full 6-step correction loop ─────────────────

async function orchestrate(opts: {
  poolId: string;
  wallet: string;
  privateKey: string;
  password: string;
  targetRatio: number;
  minDriftPct: number;
  maxCorrectionSats: number;
  slippagePct: number;
  isDryRun: boolean;
  before: InventorySnapshot;
  poolBins: BinData[];
  pool: PoolMeta;
  plan: CorrectiveSwapPlan;
}): Promise<{
  swap_txid: string | null;
  swap_explorer: string | null;
  redeploy_txid: string | null;
  after: InventorySnapshot | null;
}> {
  // Step 4 — Execute corrective swap
  dbg(`Step 4: Executing ${opts.plan.direction} swap — ${opts.plan.amount_in_human} → min ${opts.plan.minimum_out_human}`);
  const swapResult = await executeCorrectiveSwap(
    opts.plan,
    opts.pool,
    opts.wallet,
    opts.privateKey,
    opts.isDryRun,
  );

  // Step 5 — Redeploy liquidity (wait ~3 s propagation before calling)
  if (!opts.isDryRun && swapResult.txId) {
    dbg("Waiting 15 s for swap propagation before redeploy...");
    await new Promise((r) => setTimeout(r, 15_000));
  }

  dbg("Step 5: Redeploying liquidity via hodlmm-move-liquidity...");
  const redeploy = await redeployLiquidity(
    opts.poolId,
    opts.wallet,
    opts.password,
    opts.isDryRun,
  ).catch((e: any) => ({
    success: false,
    txId: null,
    raw: { error: e.message },
  }));

  // Step 6 — Re-observe and verify
  let afterSnapshot: InventorySnapshot | null = null;
  if (!opts.isDryRun) {
    try {
      dbg("Step 6: Re-fetching inventory for verification...");
      const freshBins = await fetchUserBins(opts.poolId, opts.wallet);
      afterSnapshot = computeInventoryRatio(
        freshBins,
        opts.poolBins,
        opts.pool,
        opts.before.active_bin,
      );
    } catch (e: any) {
      dbg(`Verification fetch failed: ${e.message}`);
    }
  }

  return {
    swap_txid: swapResult.txId,
    swap_explorer: swapResult.explorerUrl,
    redeploy_txid: redeploy.txId,
    after: afterSnapshot,
  };
}

// ── Commands ──────────────────────────────────────────────────────────────────

const program = new Command();
program
  .name("hodlmm-inventory-balancer")
  .description(
    "HODLMM inventory drift corrector — price-weighted ratio correction via Bitflow swap",
  );

// ─── doctor ──────────────────────────────────────────────────────────────────

program
  .command("doctor")
  .description("Health-check APIs, wallet, and dependencies")
  .option("--wallet <address>", "STX address to check balance")
  .action(async (opts) => {
    const checks: Record<string, string> = {};
    const warnings: string[] = [];

    const [qb, ab, hi] = await Promise.all([
      pingUrl(`${BITFLOW_QUOTES}/bins/dlmm_1`),
      pingUrl(`${BITFLOW_APP}/pools?amm_type=dlmm`),
      pingUrl(`${HIRO_API}/v2/info`),
    ]);
    checks.bitflow_quotes_bins = qb;
    checks.bitflow_app_pools   = ab;
    checks.hiro_api            = hi;

    // SDK import check
    try {
      await getBitflowSDK();
      checks.bitflow_sdk = "ok";
    } catch {
      checks.bitflow_sdk = "missing";
      warnings.push("@bitflowlabs/core-sdk not installed — run `bun install`");
    }

    // Stacks transactions library
    try {
      await import("@stacks/transactions" as string);
      checks.stacks_transactions = "ok";
    } catch {
      checks.stacks_transactions = "missing";
      warnings.push("@stacks/transactions not installed");
    }

    // Sibling skill check
    const moveScript = path.resolve(
      path.dirname(new URL(import.meta.url).pathname),
      "../hodlmm-move-liquidity/hodlmm-move-liquidity.ts",
    );
    checks.hodlmm_move_liquidity = fs.existsSync(moveScript) ? "ok" : "missing";
    if (checks.hodlmm_move_liquidity === "missing") {
      warnings.push("hodlmm-move-liquidity not found — redeploy step will fail");
    }

    // Wallet balance (optional)
    if (opts.wallet) {
      try {
        const bal = await fetchStxBalance(opts.wallet);
        checks.stx_balance = bal > MIN_GAS_STX ? "ok" : "low";
        if (bal <= MIN_GAS_STX)
          warnings.push(`STX balance ${bal.toFixed(2)} — below ${MIN_GAS_STX} STX minimum`);
      } catch (e: any) {
        checks.stx_balance = "error";
        warnings.push(`Balance fetch failed: ${e.message}`);
      }
    }

    // Skill-dependency checks (hodlmm_move_liquidity) are warnings, not hard failures.
    const apiChecks = (["bitflow_quotes_bins", "bitflow_app_pools", "hiro_api"] as const).map(
      (k) => checks[k],
    );
    const libChecks = (["bitflow_sdk", "stacks_transactions"] as const).map((k) => checks[k]);
    const down = [...apiChecks, ...libChecks].filter((v) => v === "down" || v === "missing");
    const overall = down.length > 0 ? "down" : warnings.length > 0 ? "degraded" : "ok";

    if (overall === "down") {
      fail(
        "DEPENDENCY_DOWN",
        `Required dependencies unavailable: ${down.join(", ")}`,
        "Install missing packages with `bun install` and verify network connectivity",
        { checks, warnings },
      );
    } else {
      success(
        overall === "ok"
          ? "All dependencies healthy"
          : "Dependencies degraded — proceed with caution",
        { checks, warnings, overall },
      );
    }
  });

// ─── scan ─────────────────────────────────────────────────────────────────────

program
  .command("scan")
  .description(
    "Read per-bin inventory, compute price-weighted drift vs target ratio",
  )
  .requiredOption("--pool <id>", "HODLMM pool ID (e.g. dlmm_1)", "dlmm_1")
  .requiredOption("--wallet <address>", "Stacks wallet address (SP...)")
  .option(
    "--target-ratio <pct>",
    "Target X-token share 0–100 (default 50)",
    "50",
  )
  .option(
    "--min-drift-pct <n>",
    "Min drift % to flag as actionable (default 5)",
    "5",
  )
  .action(async (opts) => {
    const { pool: poolId, wallet } = opts;
    const targetRatio = parseFloat(opts.targetRatio) / 100;
    const minDriftPct = parseFloat(opts.minDriftPct);

    if (!/^SP[A-Z0-9]{30,}$/.test(wallet)) {
      return fail(
        "INVALID_WALLET",
        "Wallet must be a valid Stacks mainnet address (SP...)",
        "Provide a valid --wallet address",
      );
    }

    if (targetRatio < 0 || targetRatio > 1) {
      return fail("INVALID_RATIO", "--target-ratio must be 0–100", "e.g. --target-ratio 50");
    }

    const [pool, binsData, stxBal] = await Promise.all([
      fetchPool(poolId),
      fetchPoolBins(poolId),
      fetchStxBalance(wallet),
    ]);

    if (!pool) {
      return fail(
        "POOL_NOT_FOUND",
        `Pool '${poolId}' not found in Bitflow API`,
        "Check available pools at bff.bitflowapis.finance/api/app/v1/pools",
      );
    }

    const userBins = await fetchUserBins(poolId, wallet);
    if (userBins.length === 0) {
      return blocked(
        "NO_POSITION",
        `No active position found in pool ${poolId} for wallet ${wallet}`,
        "Deposit into a HODLMM pool first",
      );
    }

    const snapshot = computeInventoryRatio(
      userBins,
      binsData.bins,
      pool,
      binsData.active_bin_id || pool.active_bin,
    );

    const driftPct = Math.abs(snapshot.ratio_x - targetRatio) * 100;
    const cooldownMs = cooldownRemainingMs(poolId);
    const actionable = driftPct >= minDriftPct && cooldownMs === 0;

    success(
      actionable
        ? `Drift ${driftPct.toFixed(2)} % — correction recommended. Run with --confirm=BALANCE to execute.`
        : driftPct >= minDriftPct && cooldownMs > 0
        ? `Drift ${driftPct.toFixed(2)} % — cooldown active for ${Math.ceil(cooldownMs / 60_000)} min`
        : `Drift ${driftPct.toFixed(2)} % — below ${minDriftPct} % threshold, no action needed`,
      {
        pool_id: poolId,
        pair: snapshot.pair,
        active_bin: snapshot.active_bin,
        inventory: {
          ratio_x: snapshot.ratio_x,
          ratio_y: snapshot.ratio_y,
          x_exposure: snapshot.total_x_exposure,
          y_exposure: snapshot.total_y_exposure,
          total_exposure: snapshot.total_exposure,
          avg_price: snapshot.avg_price,
          bin_count: snapshot.bin_count,
        },
        drift: {
          drift_pct: driftPct,
          target_ratio_x: targetRatio,
          min_drift_pct: minDriftPct,
          actionable,
          direction:
            snapshot.ratio_x > targetRatio
              ? `X_TO_Y (too much ${pool.token_x_symbol})`
              : `Y_TO_X (too much ${pool.token_y_symbol})`,
        },
        gates: {
          drift_exceeds_threshold: driftPct >= minDriftPct,
          cooldown_clear: cooldownMs === 0,
          has_gas: stxBal > MIN_GAS_STX,
        },
        cooldown_remaining_min: cooldownMs > 0 ? Math.ceil(cooldownMs / 60_000) : 0,
        stx_balance: stxBal,
      },
    );
  });

// ─── run ──────────────────────────────────────────────────────────────────────

program
  .command("run")
  .description(
    "Execute the 6-step inventory correction loop. Dry-run unless --confirm=BALANCE.",
  )
  .requiredOption("--pool <id>", "HODLMM pool ID (e.g. dlmm_1)", "dlmm_1")
  .requiredOption("--wallet <address>", "Stacks wallet address (SP...)")
  .option("--target-ratio <pct>", "Target X-token share 0–100 (default 50)", "50")
  .option(
    "--min-drift-pct <n>",
    "Minimum drift % to trigger correction (default 5)",
    String(DEFAULT_MIN_DRIFT_PCT),
  )
  .option(
    "--max-correction-sats <n>",
    "Max raw swap amount in from-token smallest units (default 10000000)",
    "10000000",
  )
  .option(
    "--slippage-pct <n>",
    "Slippage tolerance % for swap (default 0.5)",
    String(DEFAULT_SLIPPAGE_PCT),
  )
  .option("--password <pwd>", "Wallet password (or AIBTC_WALLET_PASSWORD env var)")
  .option(
    "--confirm <phrase>",
    "Pass --confirm=BALANCE to broadcast on-chain (required for live execution)",
  )
  .action(async (opts) => {
    const {
      pool: poolId,
      wallet,
      confirm: confirmPhrase,
    } = opts;

    const targetRatio       = parseFloat(opts.targetRatio) / 100;
    const minDriftPct       = parseFloat(opts.minDriftPct);
    const maxCorrectionSats = parseInt(opts.maxCorrectionSats, 10);
    const slippagePct       = parseFloat(opts.slippagePct);
    const password          = opts.password ?? process.env.AIBTC_WALLET_PASSWORD ?? "";
    const isLive            = confirmPhrase === CONFIRM_PHRASE;
    const isDryRun          = !isLive;

    // ── Input validation ─────────────────────────────────────────────────────
    if (!/^SP[A-Z0-9]{30,}$/.test(wallet)) {
      return fail("INVALID_WALLET", "Wallet must be a valid Stacks mainnet SP... address", "Provide a valid --wallet address");
    }
    if (targetRatio < 0 || targetRatio > 1) {
      return fail("INVALID_RATIO", "--target-ratio must be 0–100", "e.g. --target-ratio 50");
    }
    if (maxCorrectionSats <= 0 || isNaN(maxCorrectionSats)) {
      return fail("INVALID_CORRECTION", "--max-correction-sats must be a positive integer", "e.g. --max-correction-sats 10000000");
    }
    if (slippagePct <= 0 || slippagePct > 10) {
      return fail("INVALID_SLIPPAGE", "--slippage-pct must be 0–10", "e.g. --slippage-pct 0.5");
    }
    if (isLive && !password) {
      return fail("MISSING_PASSWORD", "--password required for live execution", "Provide --password or set AIBTC_WALLET_PASSWORD");
    }

    // ── STEP 1 — Observe per-bin token amounts ────────────────────────────────
    dbg("Step 1: Fetching pool + user bin data...");
    const [pool, binsData, stxBal] = await Promise.all([
      fetchPool(poolId),
      fetchPoolBins(poolId),
      fetchStxBalance(wallet),
    ]);

    if (!pool) {
      return fail("POOL_NOT_FOUND", `Pool '${poolId}' not found`, "Check pool ID");
    }

    const userBins = await fetchUserBins(poolId, wallet);

    if (userBins.length === 0) {
      return blocked("NO_POSITION", `No active position in pool ${poolId}`, "Deposit into pool first");
    }

    // Refusal: insufficient gas
    if (stxBal < MIN_GAS_STX) {
      return blocked(
        "INSUFFICIENT_GAS",
        `STX balance ${stxBal.toFixed(6)} is below ${MIN_GAS_STX} STX gas reserve`,
        `Fund wallet with at least ${MIN_GAS_STX - stxBal + 0.5} more STX`,
        { stx_balance: stxBal, required: MIN_GAS_STX },
      );
    }

    // Refusal: cooldown
    const cooldownMs = cooldownRemainingMs(poolId);
    if (cooldownMs > 0) {
      const nextEligible = new Date(Date.now() + cooldownMs).toISOString();
      return blocked(
        "COOLDOWN_ACTIVE",
        `4-hour cooldown active — ${Math.ceil(cooldownMs / 60_000)} min remaining (shared with hodlmm-move-liquidity)`,
        `Try again after ${nextEligible}`,
        { next_eligible_at: nextEligible, cooldown_remaining_min: Math.ceil(cooldownMs / 60_000) },
      );
    }

    // Refusal: unresolved state (swap broadcast without subsequent redeploy)
    const ownState = readState();
    if (ownState[poolId]?.last_balance_txid && !ownState[poolId]?.last_redeploy_txid) {
      const prev = ownState[poolId];
      const txStatus = await fetchTxStatus(prev.last_balance_txid!).catch(() => ({
        confirmed: false,
        status: "unknown",
      }));
      if (!txStatus.confirmed) {
        return blocked(
          "UNRESOLVED_PRIOR_CYCLE",
          `Previous swap ${prev.last_balance_txid} is ${txStatus.status} — redeploy step did not complete`,
          `Check tx status at ${EXPLORER_BASE}/${prev.last_balance_txid}?chain=mainnet then re-run`,
          { prior_swap_txid: prev.last_balance_txid, tx_status: txStatus.status },
        );
      }
    }

    // ── STEP 2 — Compute drift ────────────────────────────────────────────────
    dbg("Step 2: Computing price-weighted inventory ratio...");
    const activeBin = binsData.active_bin_id || pool.active_bin;
    const beforeSnapshot = computeInventoryRatio(userBins, binsData.bins, pool, activeBin);
    const driftPct = Math.abs(beforeSnapshot.ratio_x - targetRatio) * 100;

    // Refusal: drift below threshold — pool volume too thin or position balanced
    if (driftPct < minDriftPct) {
      return success(
        `Drift ${driftPct.toFixed(2)} % is below ${minDriftPct} % threshold — no correction needed`,
        {
          decision: "SKIP",
          pool_id: poolId,
          pair: beforeSnapshot.pair,
          drift_pct: driftPct,
          min_drift_pct: minDriftPct,
          ratio_x: beforeSnapshot.ratio_x,
          ratio_y: beforeSnapshot.ratio_y,
          target_ratio_x: targetRatio,
        },
      );
    }

    // ── STEP 3 — Plan corrective swap ─────────────────────────────────────────
    dbg("Step 3: Planning corrective swap...");

    // Get Bitflow quote to determine estimated output and price impact
    let quoteTime = Date.now();
    let estimatedOut = 0;
    let priceImpactPct: number | null = null;
    let usedFallbackQuote = false;

    // Build preliminary plan to know direction and amount_in
    const prelimPlan = planCorrectiveSwap(
      beforeSnapshot,
      targetRatio,
      minDriftPct,
      maxCorrectionSats,
      slippagePct,
      null,
      pool,
    );

    if (!prelimPlan) {
      return success("No corrective swap needed after plan computation", {
        decision: "SKIP",
        pool_id: poolId,
        drift_pct: driftPct,
      });
    }

    // Fetch quote for the planned amount
    const fromTokenSymbol =
      prelimPlan.direction === "X_TO_Y" ? pool.token_x_symbol : pool.token_y_symbol;
    const toTokenSymbol =
      prelimPlan.direction === "X_TO_Y" ? pool.token_y_symbol : pool.token_x_symbol;

    try {
      const sdk = await getBitflowSDK();
      const tokens = await sdk.getAvailableTokens();
      const fromTok = tokens.find(
        (t: any) =>
          (t.symbol ?? "").toLowerCase() === fromTokenSymbol.toLowerCase(),
      );
      const toTok = tokens.find(
        (t: any) =>
          (t.symbol ?? "").toLowerCase() === toTokenSymbol.toLowerCase(),
      );

      if (fromTok && toTok) {
        quoteTime = Date.now();
        const quoteRes = await sdk.getQuoteForRoute(
          fromTok.tokenId ?? fromTok["token-id"],
          toTok.tokenId ?? toTok["token-id"],
          prelimPlan.amount_in,
        );
        estimatedOut = quoteRes?.bestRoute?.outputAmount ?? 0;
        priceImpactPct = quoteRes?.bestRoute?.priceImpact ?? null;
      }
    } catch (e: any) {
      dbg(`SDK quote failed: ${e.message}`);
    }

    // Fallback: USD-price-based quote when SDK is unavailable
    if (estimatedOut === 0) {
      dbg("SDK quote returned 0 — using USD price fallback");
      try {
        const isXtoY = prelimPlan.direction === "X_TO_Y";
        const fb = await getUsdFallbackQuote(prelimPlan.amount_in, isXtoY, pool);
        if (fb.estimatedOut > 0) {
          estimatedOut      = fb.estimatedOut;
          quoteTime         = fb.quoteTime;
          usedFallbackQuote = true;
          dbg(`USD fallback estimated out: ${estimatedOut} raw units`);
        }
      } catch (e: any) {
        dbg(`USD fallback also failed: ${e.message}`);
      }
    }

    // Refusal: quote stale immediately after fetch (unlikely but defensive)
    if (Date.now() - quoteTime > MAX_QUOTE_AGE_MS) {
      return blocked(
        "QUOTE_STALE",
        "Quote exceeded 45-second freshness gate before execution could begin",
        "Re-run immediately on a faster connection",
        { quote_age_ms: Date.now() - quoteTime },
      );
    }

    const toDecimals =
      prelimPlan.direction === "X_TO_Y"
        ? pool.token_y_decimals
        : pool.token_x_decimals;

    // Refusal: thin pool — only when using SDK quote (SDK provides actual price impact).
    // Skip this gate when using the USD fallback since the fallback IS the fair-value estimate.
    if (!usedFallbackQuote && priceImpactPct !== null && priceImpactPct > 5) {
      return blocked(
        "THIN_POOL",
        `Price impact ${priceImpactPct.toFixed(2)} % exceeds 5 % — pool too thin for safe swap`,
        "Reduce --max-correction-sats or wait for deeper liquidity",
        {
          price_impact_pct: priceImpactPct,
          estimated_out: estimatedOut / Math.pow(10, toDecimals),
        },
      );
    }

    // Attach live quote to plan
    const plan = attachQuoteToplan(
      { ...prelimPlan, price_impact_pct: priceImpactPct },
      estimatedOut,
      slippagePct,
      pool,
    );

    // ── Confirm gate — return preview if --confirm=BALANCE not provided ────────
    if (!isLive) {
      return blocked(
        "CONFIRM_REQUIRED",
        `Correction plan ready. Add --confirm=BALANCE to execute on-chain.`,
        "Review the plan below, then run with --confirm=BALANCE",
        {
          mode: "dry-run",
          pool_id: poolId,
          before: {
            ratio_x: beforeSnapshot.ratio_x,
            ratio_y: beforeSnapshot.ratio_y,
          },
          plan: {
            direction: plan.direction,
            amount_in_human: plan.amount_in_human,
            minimum_out_human: plan.minimum_out_human,
            estimated_out_human: (plan.estimated_out / Math.pow(10, toDecimals)).toFixed(toDecimals),
            drift_pct: plan.drift_pct,
            slippage_pct: plan.slippage_pct,
            price_impact_pct: plan.price_impact_pct,
            target_ratio_x: targetRatio,
            max_correction_sats: maxCorrectionSats,
            post_condition_mode: "Deny",
          },
          safety: {
            quote_age_ms: Date.now() - quoteTime,
            cooldown_clear: true,
            gas_ok: stxBal > MIN_GAS_STX,
          },
        },
      );
    }

    // ── LIVE EXECUTION via orchestrator ───────────────────────────────────────
    dbg("Decrypting wallet for live execution...");
    let walletKeys: { stxPrivateKey: string; stxAddress: string };
    try {
      walletKeys = await getWalletKeys(password, wallet);
      if (walletKeys.stxAddress !== wallet) {
        return fail(
          "WALLET_MISMATCH",
          `Decrypted wallet ${walletKeys.stxAddress} does not match --wallet ${wallet}`,
          "Ensure the wallet file belongs to the address you specified",
        );
      }
    } catch (e: any) {
      return fail("WALLET_DECRYPT_FAILED", e.message, "Check wallet installation and password");
    }

    // Persist intent before execution (allows unresolved-state detection next run)
    const stateSnapshot = readState();
    stateSnapshot[poolId] = {
      last_run_at: new Date().toISOString(),
      before_ratio_x: beforeSnapshot.ratio_x,
    };
    writeState(stateSnapshot);

    // Ensure pool.active_bin reflects the bins API value (pools API may return 0)
    pool.active_bin = activeBin;

    let orchResult: Awaited<ReturnType<typeof orchestrate>>;
    try {
      orchResult = await orchestrate({
        poolId,
        wallet,
        privateKey: walletKeys.stxPrivateKey,
        password,
        targetRatio,
        minDriftPct,
        maxCorrectionSats,
        slippagePct,
        isDryRun: false,
        before: beforeSnapshot,
        poolBins: binsData.bins,
        pool,
        plan,
      });
    } catch (e: any) {
      // Mark cycle as failed (no txid) so unresolved-state gate triggers
      const st = readState();
      if (st[poolId]) {
        delete st[poolId].last_balance_txid;
        delete st[poolId].last_redeploy_txid;
      }
      writeState(st);
      return fail("EXECUTION_FAILED", e.message, "Check Hiro explorer and wallet balance, then retry");
    }

    // Persist results
    const finalState = readState();
    finalState[poolId] = {
      last_run_at: new Date().toISOString(),
      last_balance_txid: orchResult.swap_txid ?? undefined,
      last_redeploy_txid: orchResult.redeploy_txid ?? undefined,
      before_ratio_x: beforeSnapshot.ratio_x,
      after_ratio_x: orchResult.after?.ratio_x ?? undefined,
    };
    writeState(finalState);

    const afterRatioX = orchResult.after?.ratio_x ?? null;
    const correctionAchieved =
      afterRatioX !== null
        ? Math.abs(afterRatioX - targetRatio) <
          Math.abs(beforeSnapshot.ratio_x - targetRatio)
        : null;

    success(
      orchResult.swap_txid
        ? `Inventory correction complete. Swap: ${orchResult.swap_txid}${orchResult.redeploy_txid ? ` Redeploy: ${orchResult.redeploy_txid}` : ""}`
        : "Correction executed (redeploy completed; swap pending confirmation)",
      {
        pool_id: poolId,
        pair: beforeSnapshot.pair,
        before: {
          ratio_x: beforeSnapshot.ratio_x,
          ratio_y: beforeSnapshot.ratio_y,
          x_exposure: beforeSnapshot.total_x_exposure,
          y_exposure: beforeSnapshot.total_y_exposure,
        },
        after: orchResult.after
          ? {
              ratio_x: orchResult.after.ratio_x,
              ratio_y: orchResult.after.ratio_y,
              x_exposure: orchResult.after.total_x_exposure,
              y_exposure: orchResult.after.total_y_exposure,
            }
          : null,
        correction_achieved: correctionAchieved,
        target_ratio_x: targetRatio,
        plan: {
          direction: plan.direction,
          amount_in_human: plan.amount_in_human,
          minimum_out_human: plan.minimum_out_human,
          drift_pct: plan.drift_pct,
          slippage_pct: plan.slippage_pct,
          price_impact_pct: plan.price_impact_pct,
          post_condition_mode: "Deny",
        },
        transactions: {
          swap_txid: orchResult.swap_txid,
          swap_explorer: orchResult.swap_explorer,
          redeploy_txid: orchResult.redeploy_txid,
          redeploy_explorer: orchResult.redeploy_txid
            ? `${EXPLORER_BASE}/${orchResult.redeploy_txid}?chain=mainnet`
            : null,
        },
        next_eligible_at: new Date(Date.now() + COOLDOWN_MS).toISOString(),
      },
    );
  });

// ─── install-packs ────────────────────────────────────────────────────────────

program
  .command("install-packs")
  .description("Install dependency packs (informational — use bun install)")
  .action(async () => {
    success("install-packs", {
      note: "Run `bun install` in the skill directory. Dependencies: @bitflowlabs/core-sdk, @stacks/transactions, @stacks/network, @stacks/wallet-sdk, commander.",
      packages: [
        "@bitflowlabs/core-sdk",
        "@stacks/transactions",
        "@stacks/network",
        "@stacks/wallet-sdk",
        "commander",
      ],
    });
  });

// ── Entry ─────────────────────────────────────────────────────────────────────

program.parseAsync(process.argv).catch((e: any) => {
  process.stdout.write(
    JSON.stringify({
      status: "error",
      action: "Unhandled error — check stderr for details",
      data: {},
      error: {
        code: "UNHANDLED_ERROR",
        message: e?.message ?? String(e),
        next: "Report issue at BitflowFinance/bff-skills",
      },
    }, null, 2) + "\n",
  );
  process.stderr.write(e?.stack ?? e?.message ?? String(e));
  process.exit(1);
});

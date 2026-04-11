#!/usr/bin/env bun
/**
 * LP Position Autopsy + Exit Engine
 * Diagnoses Bitflow HODLMM LP positions and autonomously executes exits
 * when the composite risk score (drift + volatility) crosses a threshold.
 *
 * Commands:
 *   doctor  — Validate environment: API connectivity and wallet setup
 *   status  — Read-only autopsy: IL estimate, drift, risk score, verdict
 *   run     — Execute exit if risk >= threshold; dry run without --confirm
 *
 * Features:
 *   - Chunked batch withdrawal: splits large positions into batches of
 *     BATCH_SIZE bins, each submitted as a separate tx with sequential nonces
 *   - Dynamic fee estimation: scales fee with batch size so large positions
 *     always have enough gas
 *   - Per-bin reserve direction: correctly sets min-x / min-y per bin based
 *     on live pool state (no blanket zero minimums)
 *
 * HODLMM bonus eligible: Yes — directly interacts with HODLMM pools.
 */

import { Command } from "commander";
import {
  makeContractCall,
  broadcastTransaction,
  PostConditionMode,
  uintCV,
  intCV,
  listCV,
  tupleCV,
  contractPrincipalCV,
  TransactionVersion,
  getAddressFromPrivateKey,
} from "@stacks/transactions";
import { StacksMainnet } from "@stacks/network";
import { generateWallet } from "@stacks/wallet-sdk";
import { readFileSync, existsSync } from "fs";
import { join } from "path";

const STACKS_MAINNET = new StacksMainnet();

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------
const BITFLOW_QUOTES = "https://bff.bitflowapis.finance/api/quotes/v1";
const BITFLOW_APP = "https://bff.bitflowapis.finance/api/app/v1";
const HIRO_API = "https://api.mainnet.hiro.so";
const ROUTER_ADDR = "SM1FKXGNZJWSTWDWXQZJNF7B5TV5ZB235JTCXYXKD";
const ROUTER_CONTRACT = "dlmm-liquidity-router-v-1-1";
const FETCH_TIMEOUT_MS = 30_000;
const DEFAULT_THRESHOLD = 60;

// Chunking: max bins per tx (well under the contract's 326 limit)
const BATCH_SIZE = 100;

// Fee scaling: base fee + per-bin increment (microSTX)
// Base 200k covers overhead; 2k per bin covers extra computation/storage
const FEE_BASE = 200_000n;
const FEE_PER_BIN = 2_000n;

// Minimum STX buffer kept in wallet after fees
const FEE_BUFFER = 50_000n;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------
interface TokenInfo {
  contract: string;
  symbol?: string;
  displayName?: string;
  decimals?: number;
}

interface PoolInfo {
  poolId: string;
  poolContract: string;
  tokens: {
    tokenX: TokenInfo;
    tokenY: TokenInfo;
  };
}

interface BinData {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
  user_liquidity?: string;
  userLiquidity?: string | number;
  liquidity?: string | number;
}

interface BinsResponse {
  active_bin_id?: number;
  bins: BinData[];
}

interface RiskMetrics {
  driftScore: number;
  volatilityScore: number;
  riskScore: number;
  ilEstimatePct: number;
  avgOffset: number;
  verdict: "hold" | "rebalance" | "exit";
}

interface BatchResult {
  batchIndex: number;
  binsInBatch: number;
  txid: string;
  txUrl: string;
  fee: string;
}

// ---------------------------------------------------------------------------
// Fee estimation
// ---------------------------------------------------------------------------
function estimateFee(binCount: number): bigint {
  return FEE_BASE + FEE_PER_BIN * BigInt(binCount);
}

function estimateTotalFees(totalBins: number): bigint {
  const batches = Math.ceil(totalBins / BATCH_SIZE);
  // Each batch of BATCH_SIZE (or fewer) bins gets its own fee
  let total = 0n;
  let remaining = totalBins;
  for (let i = 0; i < batches; i++) {
    const batchBins = Math.min(remaining, BATCH_SIZE);
    total += estimateFee(batchBins);
    remaining -= batchBins;
  }
  return total;
}

// ---------------------------------------------------------------------------
// API helpers
// ---------------------------------------------------------------------------
async function fetchJson<T>(url: string, method = "GET", body?: unknown): Promise<T> {
  const opts: RequestInit = { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS), method };
  if (body) {
    opts.body = JSON.stringify(body);
    opts.headers = { "Content-Type": "application/json" };
  }
  const res = await fetch(url, opts);
  if (!res.ok) throw new Error(`API ${res.status}: ${res.statusText} — ${url}`);
  return res.json() as Promise<T>;
}

async function getPool(poolId: string): Promise<PoolInfo> {
  const res = await fetchJson<{ data: PoolInfo[] }>(
    `${BITFLOW_APP}/pools?amm_type=dlmm`
  );
  const pool = res.data.find((p) => p.poolId === poolId);
  if (!pool) throw new Error(`Pool not found: ${poolId}`);
  return pool;
}

async function getPoolBins(poolId: string): Promise<BinsResponse> {
  return fetchJson<BinsResponse>(`${BITFLOW_QUOTES}/bins/${poolId}`);
}

async function getUserPositionBins(
  address: string,
  poolId: string
): Promise<BinData[]> {
  let res: unknown;
  try {
    res = await fetchJson<unknown>(
      `${BITFLOW_APP}/users/${address}/positions/${poolId}/bins`
    );
  } catch (e) {
    const msg = e instanceof Error ? e.message : String(e);
    if (msg.includes("404")) {
      throw new Error(`No position found for ${address} in pool ${poolId}`);
    }
    throw e;
  }
  if (Array.isArray(res)) return res as BinData[];
  const obj = res as Record<string, unknown>;
  if (Array.isArray(obj["bins"])) return obj["bins"] as BinData[];
  if (Array.isArray(obj["data"])) return obj["data"] as BinData[];
  throw new Error(`Unexpected position response shape: ${JSON.stringify(res)}`);
}

async function getStxBalance(address: string): Promise<bigint> {
  const res = await fetchJson<{ balance: string }>(
    `${HIRO_API}/extended/v1/address/${address}/stx`
  );
  return BigInt(res.balance);
}

async function getNonce(address: string): Promise<bigint> {
  const res = await fetchJson<{ possible_next_nonce: number }>(
    `${HIRO_API}/extended/v1/address/${address}/nonces`
  );
  return BigInt(res.possible_next_nonce);
}

// ---------------------------------------------------------------------------
// Wallet
// ---------------------------------------------------------------------------
async function deriveFromMnemonic(mnemonic: string): Promise<{ privateKey: string; address: string }> {
  const clean = mnemonic.replace(/\s+/g, " ").trim();
  const wallet = await generateWallet({ secretKey: clean, password: "" });
  const account = wallet.accounts[0];
  const privateKey = account.stxPrivateKey;
  const address = getAddressFromPrivateKey(privateKey, TransactionVersion.Mainnet);
  return { privateKey, address };
}

async function loadWallet(): Promise<{ privateKey: string; address: string }> {
  const rawKey = process.env.STACKS_PRIVATE_KEY;
  if (rawKey) {
    const cleanKey = rawKey.startsWith("0x") ? rawKey.slice(2) : rawKey;
    const address = getAddressFromPrivateKey(cleanKey, TransactionVersion.Mainnet);
    return { privateKey: cleanKey, address };
  }

  const envMnemonic = process.env.STACKS_MNEMONIC;
  if (envMnemonic) {
    return deriveFromMnemonic(envMnemonic.trim());
  }

  const walletFile = join(process.cwd(), ".wallet");
  if (existsSync(walletFile)) {
    const fileMnemonic = readFileSync(walletFile, "utf8").trim();
    return deriveFromMnemonic(fileMnemonic);
  }

  throw new Error(
    "No wallet found. Set STACKS_MNEMONIC, STACKS_PRIVATE_KEY, or create a .wallet file."
  );
}

// ---------------------------------------------------------------------------
// Risk scoring
// ---------------------------------------------------------------------------
function computeRiskMetrics(
  activeBinId: number,
  poolBins: BinData[],
  positionBins: BinData[],
  threshold: number
): RiskMetrics {
  const offsets = positionBins.map((b) => Math.abs(b.bin_id - activeBinId));
  const avgOffset =
    offsets.length > 0
      ? offsets.reduce((s, o) => s + o, 0) / offsets.length
      : 0;
  const driftScore = Math.round(Math.min(avgOffset * 5, 100));

  let volatilityScore = 0;
  const nonEmpty = poolBins.filter(
    (b) => Number(b.reserve_x) > 0 || Number(b.reserve_y) > 0
  );
  if (nonEmpty.length > 0) {
    const ids = nonEmpty.map((b) => b.bin_id);
    const binSpread =
      (Math.max(...ids) - Math.min(...ids)) / Math.max(poolBins.length, 1);
    let totalX = 0, totalY = 0;
    for (const b of poolBins) {
      totalX += Number(b.reserve_x);
      totalY += Number(b.reserve_y);
    }
    const total = totalX + totalY;
    const imbalance = total > 0 ? Math.abs(totalX - totalY) / total : 0;
    const activeBin = poolBins.find((b) => b.bin_id === activeBinId);
    const activeLiq = activeBin
      ? Number(activeBin.reserve_x) + Number(activeBin.reserve_y)
      : 0;
    const concentration = total > 0 ? activeLiq / total : 0;
    volatilityScore = Math.round(
      Math.min(
        Math.min(binSpread * 100, 40) + imbalance * 30 + (1 - concentration) * 30,
        100
      )
    );
  }

  const riskScore = Math.round(driftScore * 0.6 + volatilityScore * 0.4);
  const ilEstimatePct = Number((driftScore * 0.08).toFixed(2));
  const verdict: RiskMetrics["verdict"] =
    riskScore >= threshold ? "exit" : riskScore >= 30 ? "rebalance" : "hold";

  return { driftScore, volatilityScore, riskScore, ilEstimatePct, avgOffset, verdict };
}

// ---------------------------------------------------------------------------
// Exit transaction — single batch
// ---------------------------------------------------------------------------
async function executeBatch(
  pool: PoolInfo,
  bins: BinData[],
  poolBinMap: Map<number, { rx: bigint; ry: bigint }>,
  privateKey: string,
  nonce: bigint
): Promise<string> {
  const [poolAddr, poolName] = pool.poolContract.split(".");
  const [xAddr, xName] = pool.tokens.tokenX.contract.split(".");
  const [yAddr, yName] = pool.tokens.tokenY.contract.split(".");

  const CENTER = 500n;
  const fee = estimateFee(bins.length);

  const positionList = bins.flatMap((bin) => {
    const dlp = BigInt(String(bin.userLiquidity ?? bin.user_liquidity ?? bin.liquidity ?? "0"));
    if (dlp === 0n) return [];

    const signedBinId = BigInt(bin.bin_id) - CENTER;

    // Set min amounts based on which side of the active bin this bin is on.
    // The contract requires min-x-amount + min-y-amount > 0.
    const pr = poolBinMap.get(bin.bin_id);
    const hasX = pr ? pr.rx > 0n : true;
    const hasY = pr ? pr.ry > 0n : false;
    const minX = hasX ? 1n : 0n;
    const minY = !hasX && hasY ? 1n : 0n;

    return [tupleCV({
      amount: uintCV(dlp),
      "bin-id": intCV(Number(signedBinId)),
      "min-x-amount": uintCV(minX),
      "min-y-amount": uintCV(minY),
      "pool-trait": contractPrincipalCV(poolAddr, poolName),
      "x-token-trait": contractPrincipalCV(xAddr, xName),
      "y-token-trait": contractPrincipalCV(yAddr, yName),
    })];
  });

  if (positionList.length === 0) throw new Error("Batch has no withdrawable bins");

  const tx = await makeContractCall({
    contractAddress: ROUTER_ADDR,
    contractName: ROUTER_CONTRACT,
    functionName: "withdraw-liquidity-multi",
    functionArgs: [listCV(positionList)],
    senderKey: privateKey,
    network: STACKS_MAINNET,
    postConditionMode: PostConditionMode.Allow,
    nonce,
    fee,
  });

  const result = await broadcastTransaction(tx, STACKS_MAINNET);
  if ("error" in result) throw new Error(`Broadcast failed: ${result.error}`);
  return result.txid;
}

// ---------------------------------------------------------------------------
// Chunked exit — splits bins into batches, submits with sequential nonces
// ---------------------------------------------------------------------------
async function executeExit(
  pool: PoolInfo,
  bins: BinData[],
  poolBins: BinData[],
  privateKey: string,
  nonce: bigint
): Promise<BatchResult[]> {
  // Build reserve direction map once
  const poolBinMap = new Map<number, { rx: bigint; ry: bigint }>();
  for (const pb of poolBins) {
    poolBinMap.set(pb.bin_id, {
      rx: BigInt(String(pb.reserve_x ?? "0")),
      ry: BigInt(String(pb.reserve_y ?? "0")),
    });
  }

  // Split into chunks
  const batches: BinData[][] = [];
  for (let i = 0; i < bins.length; i += BATCH_SIZE) {
    batches.push(bins.slice(i, i + BATCH_SIZE));
  }

  const results: BatchResult[] = [];

  for (let i = 0; i < batches.length; i++) {
    const batch = batches[i];
    const batchNonce = nonce + BigInt(i);
    const fee = estimateFee(batch.length);

    const txid = await executeBatch(pool, batch, poolBinMap, privateKey, batchNonce);

    results.push({
      batchIndex: i,
      binsInBatch: batch.length,
      txid,
      txUrl: `https://explorer.hiro.so/txid/${txid}?chain=mainnet`,
      fee: `${Number(fee) / 1_000_000} STX`,
    });
  }

  return results;
}

// ---------------------------------------------------------------------------
// Output helpers
// ---------------------------------------------------------------------------
function printJson(data: Record<string, unknown>): void {
  console.log(JSON.stringify(data, null, 2));
}

function handleError(error: unknown): never {
  const message = error instanceof Error ? error.message : String(error);
  console.log(JSON.stringify({ error: message }));
  process.exit(1);
}

// ---------------------------------------------------------------------------
// CLI
// ---------------------------------------------------------------------------
const program = new Command();

program
  .name("lp-exit-engine")
  .description(
    "Bitflow HODLMM LP Position Autopsy + Exit Engine — " +
      "diagnose positions for IL/drift risk and autonomously execute exits " +
      "with chunked batching and dynamic fee estimation"
  )
  .version("2.0.0");

// ---------------------------------------------------------------------------
// doctor
// ---------------------------------------------------------------------------
program
  .command("doctor")
  .description("Validate environment: Bitflow API, Hiro API, and wallet setup")
  .action(async () => {
    const checks: Record<string, boolean | string> = {};

    try {
      const res = await fetchJson<{ data: unknown[] }>(
        `${BITFLOW_APP}/pools?amm_type=dlmm`
      );
      checks["bitflow_api"] = `ok (${res.data.length} HODLMM pools found)`;
    } catch {
      checks["bitflow_api"] = false;
    }

    try {
      await fetchJson(`${HIRO_API}/v2/info`);
      checks["hiro_api"] = true;
    } catch {
      checks["hiro_api"] = false;
    }

    try {
      const { address } = await loadWallet();
      checks["wallet"] = `loaded (${address})`;
    } catch {
      checks["wallet"] = "missing — set STACKS_MNEMONIC or STACKS_PRIVATE_KEY";
    }

    const ready =
      typeof checks["bitflow_api"] === "string" && checks["hiro_api"] === true;
    printJson({ checks, ready });
  });

// ---------------------------------------------------------------------------
// status
// ---------------------------------------------------------------------------
program
  .command("status")
  .description("Read-only position autopsy: drift, IL estimate, volatility, risk score, verdict")
  .requiredOption("--pool-id <id>", "HODLMM pool ID (e.g. dlmm_1)")
  .requiredOption("--address <addr>", "Stacks wallet address to inspect")
  .option("--threshold <score>", "Exit threshold override (0–100)", String(DEFAULT_THRESHOLD))
  .action(async (opts: { poolId: string; address: string; threshold: string }) => {
    try {
      const threshold = parseInt(opts.threshold, 10);
      if (isNaN(threshold) || threshold < 0 || threshold > 100) {
        throw new Error("--threshold must be an integer 0–100");
      }

      const [pool, binsRes, positionBins] = await Promise.all([
        getPool(opts.poolId),
        getPoolBins(opts.poolId),
        getUserPositionBins(opts.address, opts.poolId),
      ]);

      if (!positionBins.length) throw new Error("Position returned no bins");

      const activeBinId = binsRes.active_bin_id;
      if (activeBinId == null) throw new Error("Cannot determine active bin ID");

      const exitBins = positionBins.filter(
        (b) => BigInt(String(b.userLiquidity ?? b.user_liquidity ?? b.liquidity ?? "0")) > 0n
      );

      const totalDlp = exitBins.reduce(
        (sum, b) => sum + BigInt(String(b.userLiquidity ?? b.user_liquidity ?? b.liquidity ?? "0")),
        0n
      );

      const m = computeRiskMetrics(activeBinId, binsRes.bins, positionBins, threshold);

      // Fee plan
      const batches = Math.ceil(exitBins.length / BATCH_SIZE);
      const totalFee = estimateTotalFees(exitBins.length);

      printJson({
        network: "mainnet",
        poolId: opts.poolId,
        address: opts.address,
        tokenX: pool.tokens.tokenX.symbol ?? pool.tokens.tokenX.contract,
        tokenY: pool.tokens.tokenY.symbol ?? pool.tokens.tokenY.contract,
        activeBinId,
        positionBinCount: positionBins.length,
        totalDlp: String(totalDlp),
        avgBinOffset: Number(m.avgOffset.toFixed(2)),
        driftScore: m.driftScore,
        volatilityScore: m.volatilityScore,
        riskScore: m.riskScore,
        ilEstimatePct: m.ilEstimatePct,
        verdict: m.verdict,
        exitThreshold: threshold,
        wouldExitOnRun: m.riskScore >= threshold,
        exitPlan: {
          batchSize: BATCH_SIZE,
          totalBatches: batches,
          estimatedTotalFee: `${Number(totalFee) / 1_000_000} STX`,
        },
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      handleError(error);
    }
  });

// ---------------------------------------------------------------------------
// run
// ---------------------------------------------------------------------------
program
  .command("run")
  .description("Execute exit if risk score >= threshold. Dry run by default — add --confirm to write on-chain")
  .requiredOption("--pool-id <id>", "HODLMM pool ID")
  .requiredOption("--address <addr>", "Stacks wallet address (must match loaded wallet)")
  .option("--threshold <score>", `Exit score threshold 0–100 (default ${DEFAULT_THRESHOLD})`, String(DEFAULT_THRESHOLD))
  .option("--confirm", "Execute the on-chain withdrawal (omit for dry run)")
  .action(async (opts: {
    poolId: string;
    address: string;
    threshold: string;
    confirm?: boolean;
  }) => {
    try {
      const threshold = parseInt(opts.threshold, 10);
      if (isNaN(threshold) || threshold < 0 || threshold > 100) {
        throw new Error("--threshold must be an integer 0–100");
      }

      const [pool, binsRes, positionBins] = await Promise.all([
        getPool(opts.poolId),
        getPoolBins(opts.poolId),
        getUserPositionBins(opts.address, opts.poolId),
      ]);

      if (!positionBins.length) throw new Error("Position returned no bins");

      const activeBinId = binsRes.active_bin_id;
      if (activeBinId == null) throw new Error("Cannot determine active bin ID");

      const m = computeRiskMetrics(activeBinId, binsRes.bins, positionBins, threshold);

      // No exit needed
      if (m.riskScore < threshold) {
        printJson({
          action: "no_exit",
          reason: `riskScore ${m.riskScore} is below threshold ${threshold}`,
          verdict: m.verdict,
          riskScore: m.riskScore,
          driftScore: m.driftScore,
          volatilityScore: m.volatilityScore,
          ilEstimatePct: m.ilEstimatePct,
          timestamp: new Date().toISOString(),
        });
        return;
      }

      const exitBins = positionBins.filter(
        (b) => BigInt(String(b.userLiquidity ?? b.user_liquidity ?? b.liquidity ?? "0")) > 0n
      );
      if (!exitBins.length) {
        throw new Error("All position bins have zero DLP — position may already be closed");
      }

      const totalDlp = exitBins.reduce(
        (sum, b) => sum + BigInt(String(b.userLiquidity ?? b.user_liquidity ?? b.liquidity ?? "0")),
        0n
      );

      const batches = Math.ceil(exitBins.length / BATCH_SIZE);
      const totalFee = estimateTotalFees(exitBins.length);

      // Dry run
      if (!opts.confirm) {
        printJson({
          action: "dry_run",
          verdict: m.verdict,
          riskScore: m.riskScore,
          driftScore: m.driftScore,
          volatilityScore: m.volatilityScore,
          ilEstimatePct: m.ilEstimatePct,
          poolId: opts.poolId,
          address: opts.address,
          totalBins: exitBins.length,
          totalDlp: String(totalDlp),
          exitPlan: {
            batchSize: BATCH_SIZE,
            totalBatches: batches,
            estimatedTotalFee: `${Number(totalFee) / 1_000_000} STX`,
            batches: Array.from({ length: batches }, (_, i) => ({
              batchIndex: i,
              bins: exitBins.slice(i * BATCH_SIZE, (i + 1) * BATCH_SIZE).map((b) => ({
                binId: b.bin_id,
                dlp: String(b.userLiquidity ?? b.user_liquidity ?? b.liquidity ?? "0"),
              })),
              estimatedFee: `${Number(estimateFee(Math.min(BATCH_SIZE, exitBins.length - i * BATCH_SIZE))) / 1_000_000} STX`,
            })),
          },
          note: "Re-run with --confirm to execute the on-chain withdrawal",
          timestamp: new Date().toISOString(),
        });
        return;
      }

      // Live execution
      const { privateKey, address } = await loadWallet();
      if (address.toLowerCase() !== opts.address.toLowerCase()) {
        throw new Error(
          `Wallet mismatch: loaded wallet is ${address}, but --address is ${opts.address}`
        );
      }

      // Fee check against total estimated fees across all batches
      const balance = await getStxBalance(address);
      const requiredBalance = totalFee + FEE_BUFFER;
      if (balance < requiredBalance) {
        throw new Error(
          `Insufficient STX for ${batches} batch(es): have ${Number(balance) / 1_000_000} STX, ` +
          `need ~${Number(requiredBalance) / 1_000_000} STX ` +
          `(${Number(totalFee) / 1_000_000} STX fees + buffer)`
        );
      }

      const nonce = await getNonce(address);
      const batchResults = await executeExit(pool, exitBins, binsRes.bins, privateKey, nonce);

      printJson({
        action: "exit_executed",
        poolId: opts.poolId,
        address,
        totalBinsExited: exitBins.length,
        totalDlp: String(totalDlp),
        riskScore: m.riskScore,
        driftScore: m.driftScore,
        volatilityScore: m.volatilityScore,
        ilEstimatePct: m.ilEstimatePct,
        verdict: m.verdict,
        batches: batchResults,
        // Convenience: first txid for single-batch exits
        txid: batchResults[0]?.txid,
        txUrl: batchResults[0]?.txUrl,
        timestamp: new Date().toISOString(),
      });
    } catch (error) {
      handleError(error);
    }
  });

program.parse(process.argv);

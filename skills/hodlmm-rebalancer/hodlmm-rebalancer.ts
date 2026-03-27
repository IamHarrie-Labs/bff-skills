#!/usr/bin/env bun
/**
 * HODLMM Auto-Rebalancer CLI
 * Detects out-of-range concentrated liquidity positions on Bitflow HODLMM
 * and computes optimal bin placement for rebalancing.
 *
 * Commands: doctor | run | install-packs
 * Actions (run): assess | plan | execute
 *
 * HODLMM bonus eligible: Yes — directly manages HODLMM positions.
 *
 * Usage: bun run skills/hodlmm-rebalancer/hodlmm-rebalancer.ts <subcommand> [options]
 */

// -- Constants
const BITFLOW_API = "https://api.bitflow.finance/api/v1";
const HIRO_API = "https://api.hiro.so";
const NETWORK = "mainnet";
const FETCH_TIMEOUT_MS = 30_000;

// Safety defaults
const DEFAULT_MAX_SBTC_SATS = 500_000;
const DEFAULT_MAX_STX = 100;
const MIN_POSITION_SATS = 10_000;
const MIN_GAS_USTX = 50_000;
const COOLDOWN_MS = 30 * 60 * 1000; // 30 minutes
const DEFAULT_SLIPPAGE_PCT = 2;
const DEFAULT_BIN_WIDTH = 5;

// -- Types
interface SkillOutput {
  status: "success" | "error" | "blocked";
  action: string;
  data: Record<string, unknown>;
  error: { code: string; message: string; next: string } | null;
}

interface HodlmmBinData {
  bin_id: number;
  reserve_x: string;
  reserve_y: string;
}

interface HodlmmPoolInfo {
  active_bin: number;
  token_x: string;
  token_y: string;
  token_x_symbol?: string;
  token_y_symbol?: string;
}

interface HodlmmBinListResponse {
  active_bin_id?: number;
  bins: HodlmmBinData[];
}

interface RebalancePlan {
  staleBins: { bin_id: number; reserve_x: number; reserve_y: number }[];
  targetBins: { bin_id: number; amount_x: number; amount_y: number }[];
  totalWithdrawX: number;
  totalWithdrawY: number;
  estimatedGasUstx: number;
  projectedDailyFeeBps: number;
}

// -- Helpers
function output(result: SkillOutput): void {
  console.log(JSON.stringify(result, null, 2));
}

function blocked(code: string, message: string, next: string): void {
  output({ status: "blocked", action: next, data: {}, error: { code, message, next } });
}

function error(code: string, message: string, next: string): void {
  output({ status: "error", action: next, data: {}, error: { code, message, next } });
}

function parseArgs(args: string[]): Record<string, string> {
  const parsed: Record<string, string> = {};
  for (const arg of args) {
    if (arg.startsWith("--")) {
      const [key, ...rest] = arg.slice(2).split("=");
      parsed[key] = rest.join("=") || "true";
    }
  }
  return parsed;
}

function getWalletAddress(): string {
  const addr = process.env.STACKS_ADDRESS || process.env.STX_ADDRESS;
  if (!addr) {
    error("no_wallet", "No wallet address found. Set STACKS_ADDRESS env var.", "Configure wallet");
    process.exit(1);
  }
  return addr;
}

// -- API helpers
async function fetchJson<T>(url: string): Promise<T> {
  const res = await fetch(url, { signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  if (!res.ok) throw new Error(`API error ${res.status}: ${res.statusText}`);
  return res.json() as Promise<T>;
}

async function getHodlmmPool(poolId: string): Promise<HodlmmPoolInfo> {
  return fetchJson(`${BITFLOW_API}/hodlmm/pools/${poolId}`);
}

async function getHodlmmPoolBins(poolId: string): Promise<HodlmmBinListResponse> {
  return fetchJson(`${BITFLOW_API}/hodlmm/pools/${poolId}/bins`);
}

async function getHodlmmUserPositionBins(address: string, poolId: string): Promise<HodlmmBinListResponse> {
  return fetchJson(`${BITFLOW_API}/hodlmm/pools/${poolId}/positions/${address}`);
}

async function getStxBalance(address: string): Promise<number> {
  const res = await fetch(`${HIRO_API}/extended/v1/address/${address}/stx`);
  if (!res.ok) throw new Error(`Failed to fetch STX balance: ${res.status}`);
  const data = await res.json() as any;
  return parseInt(data.balance, 10) - parseInt(data.locked, 10);
}

async function getSbtcBalance(address: string): Promise<number> {
  const res = await fetch(`${HIRO_API}/extended/v1/address/${address}/balances`);
  if (!res.ok) throw new Error(`Failed to fetch balances: ${res.status}`);
  const data = await res.json() as any;
  const ftKey = "SM3VDXK3WZZSA84XXFKAFAF15NNZX32CTSG82JFQ4.sbtc-token::sbtc-token";
  return data.fungible_tokens?.[ftKey]?.balance ? parseInt(data.fungible_tokens[ftKey].balance, 10) : 0;
}

// -- Risk computation (reuses hodlmm-risk logic)
function classifyRegime(score: number): "calm" | "elevated" | "crisis" {
  if (score <= 30) return "calm";
  if (score <= 60) return "elevated";
  return "crisis";
}

function computeVolatilityScore(
  pool: HodlmmPoolInfo,
  binsResponse: HodlmmBinListResponse
): { score: number; regime: "calm" | "elevated" | "crisis" } {
  const bins = binsResponse.bins;
  const activeBinId = binsResponse.active_bin_id ?? pool.active_bin;
  const nonEmpty = bins.filter(b => Number(b.reserve_x) > 0 || Number(b.reserve_y) > 0);
  if (nonEmpty.length === 0) throw new Error("No active liquidity in pool");
  const ids = nonEmpty.map(b => b.bin_id);
  const spread = (Math.max(...ids) - Math.min(...ids)) / Math.max(bins.length, 1);
  let totalX = 0, totalY = 0;
  for (const b of bins) { totalX += Number(b.reserve_x); totalY += Number(b.reserve_y); }
  const total = totalX + totalY;
  const imbalance = total > 0 ? Math.abs(totalX - totalY) / total : 0;
  const active = bins.find(b => b.bin_id === activeBinId);
  const activeLiq = active ? Number(active.reserve_x) + Number(active.reserve_y) : 0;
  const concentration = total > 0 ? activeLiq / total : 0;
  const score = Math.round(Math.min(
    Math.min(spread * 100, 40) + imbalance * 30 + (1 - concentration) * 30, 100
  ));
  return { score, regime: classifyRegime(score) };
}

// -- Drift & rebalance computation
function computeDrift(
  positionBins: HodlmmBinData[],
  activeBinId: number
): { driftScore: number; outOfRangePct: number; staleCount: number; inRangeCount: number } {
  const offsets = positionBins.map(b => Math.abs(b.bin_id - activeBinId));
  const avgOffset = offsets.reduce((s, o) => s + o, 0) / offsets.length;
  const driftScore = Math.round(Math.min(avgOffset * 5, 100));
  const outOfRange = positionBins.filter(b => Math.abs(b.bin_id - activeBinId) > DEFAULT_BIN_WIDTH);
  const outOfRangePct = positionBins.length > 0 ? (outOfRange.length / positionBins.length) * 100 : 0;
  return {
    driftScore,
    outOfRangePct: Number(outOfRangePct.toFixed(1)),
    staleCount: outOfRange.length,
    inRangeCount: positionBins.length - outOfRange.length,
  };
}

function buildRebalancePlan(
  positionBins: HodlmmBinData[],
  activeBinId: number,
  binWidth: number
): RebalancePlan {
  const staleBins = positionBins
    .filter(b => Math.abs(b.bin_id - activeBinId) > binWidth)
    .map(b => ({ bin_id: b.bin_id, reserve_x: Number(b.reserve_x), reserve_y: Number(b.reserve_y) }));
  let totalWithdrawX = 0, totalWithdrawY = 0;
  for (const b of staleBins) { totalWithdrawX += b.reserve_x; totalWithdrawY += b.reserve_y; }
  const targetBins: { bin_id: number; amount_x: number; amount_y: number }[] = [];
  const numTargetBins = binWidth * 2 + 1;
  const perBinX = totalWithdrawX / numTargetBins;
  const perBinY = totalWithdrawY / numTargetBins;
  for (let offset = -binWidth; offset <= binWidth; offset++) {
    targetBins.push({
      bin_id: activeBinId + offset,
      amount_x: Number(perBinX.toFixed(0)),
      amount_y: Number(perBinY.toFixed(0)),
    });
  }
  // Estimate gas: ~0.01 STX per bin operation (withdraw + deposit)
  const estimatedGasUstx = (staleBins.length + targetBins.length) * 10_000;
  // Rough fee projection: 5 bps/day for in-range liquidity
  const projectedDailyFeeBps = 5;
  return { staleBins, targetBins, totalWithdrawX, totalWithdrawY, estimatedGasUstx, projectedDailyFeeBps };
}

// -- Cooldown tracking (in-memory for single session)
let lastRebalanceTimestamp: Record<string, number> = {};

// -- Commands
async function doctor(): Promise<void> {
  const address = getWalletAddress();
  const checks: Record<string, { ok: boolean; detail: string }> = {};
  try {
    const stx = await getStxBalance(address);
    checks["stx_balance"] = { ok: stx > MIN_GAS_USTX, detail: `${stx} uSTX` };
  } catch (e: any) { checks["stx_balance"] = { ok: false, detail: e.message }; }
  try {
    const sbtc = await getSbtcBalance(address);
    checks["sbtc_balance"] = { ok: true, detail: `${sbtc} sats` };
  } catch (e: any) { checks["sbtc_balance"] = { ok: false, detail: e.message }; }
  try {
    const res = await fetch(`${BITFLOW_API}/hodlmm/pools`, { signal: AbortSignal.timeout(10_000) });
    checks["bitflow_hodlmm_api"] = { ok: res.ok, detail: res.ok ? "HODLMM API reachable" : `HTTP ${res.status}` };
  } catch (e: any) { checks["bitflow_hodlmm_api"] = { ok: false, detail: e.message }; }
  checks["mcp_tools"] = { ok: true, detail: "Requires MCP: bitflow_hodlmm_add_liquidity, bitflow_hodlmm_remove_liquidity" };
  const allOk = Object.values(checks).every(c => c.ok);
  const blockers = Object.entries(checks).filter(([, c]) => !c.ok).map(([k, c]) => `${k}: ${c.detail}`);
  output({
    status: allOk ? "success" : "blocked",
    action: allOk ? "Environment ready. Run --action=assess to check position drift." : "Fix blockers before proceeding",
    data: { checks, address, network: NETWORK, ...(blockers.length ? { blockers } : {}) },
    error: allOk ? null : { code: "doctor_failed", message: blockers.join("; "), next: "Resolve issues" },
  });
}

async function runAssess(poolId: string, address: string): Promise<void> {
  const [pool, binsResponse, posResponse] = await Promise.all([
    getHodlmmPool(poolId),
    getHodlmmPoolBins(poolId),
    getHodlmmUserPositionBins(address, poolId),
  ]);
  const positionBins = posResponse.bins;
  if (!positionBins || positionBins.length === 0) {
    throw new Error("Address has no position in this pool");
  }
  const activeBinId = binsResponse.active_bin_id ?? pool.active_bin;
  if (activeBinId == null) throw new Error("Cannot determine active bin");
  const drift = computeDrift(positionBins, activeBinId);
  const vol = computeVolatilityScore(pool, binsResponse);
  const shouldRebalance = drift.driftScore >= 15 && drift.outOfRangePct > 20;
  output({
    status: "success",
    action: shouldRebalance
      ? "Position has drifted. Run --action=plan to compute rebalance."
      : "Position is in range. No rebalance needed.",
    data: {
      network: NETWORK, poolId, address, activeBinId,
      positionBinCount: positionBins.length,
      driftScore: drift.driftScore,
      outOfRangePct: drift.outOfRangePct,
      staleBinCount: drift.staleCount,
      inRangeBinCount: drift.inRangeCount,
      volatilityScore: vol.score,
      regime: vol.regime,
      shouldRebalance,
      timestamp: new Date().toISOString(),
    },
    error: null,
  });
}

async function runPlan(poolId: string, address: string, binWidth: number, force: boolean): Promise<void> {
  const [pool, binsResponse, posResponse] = await Promise.all([
    getHodlmmPool(poolId),
    getHodlmmPoolBins(poolId),
    getHodlmmUserPositionBins(address, poolId),
  ]);
  const positionBins = posResponse.bins;
  if (!positionBins || positionBins.length === 0) throw new Error("No position found");
  const activeBinId = binsResponse.active_bin_id ?? pool.active_bin;
  if (activeBinId == null) throw new Error("Cannot determine active bin");
  const vol = computeVolatilityScore(pool, binsResponse);
  if (vol.regime === "crisis" && !force) {
    blocked("crisis_regime", `Volatility score ${vol.score} (crisis). Rebalance blocked.`, "Wait for calmer conditions or use --force");
    return;
  }
  const plan = buildRebalancePlan(positionBins, activeBinId, binWidth);
  if (plan.staleBins.length === 0) {
    output({ status: "success", action: "All bins are in range. No rebalance needed.", data: { activeBinId, binWidth, staleBins: 0 }, error: null });
    return;
  }
  const totalValue = plan.totalWithdrawX + plan.totalWithdrawY;
  if (totalValue < MIN_POSITION_SATS) {
    blocked("position_too_small", `Position value ${totalValue} < minimum ${MIN_POSITION_SATS} sats`, "Position too small to justify gas");
    return;
  }
  const dailyFeeEstimate = totalValue * plan.projectedDailyFeeBps / 10_000;
  const gasCostStx = plan.estimatedGasUstx / 1_000_000;
  const profitable = dailyFeeEstimate * 1 > gasCostStx * 300; // rough: 1 day fees vs gas in sats
  output({
    status: "success",
    action: profitable
      ? "Plan is profitable. Run --action=execute --confirm to rebalance."
      : "Rebalance may not be profitable. Consider waiting for more drift.",
    data: {
      network: NETWORK, poolId, address, activeBinId, binWidth,
      volatilityScore: vol.score, regime: vol.regime,
      staleBinCount: plan.staleBins.length,
      staleBins: plan.staleBins.map(b => b.bin_id),
      targetBinCount: plan.targetBins.length,
      targetBins: plan.targetBins,
      totalWithdrawX: plan.totalWithdrawX,
      totalWithdrawY: plan.totalWithdrawY,
      estimatedGasUstx: plan.estimatedGasUstx,
      estimatedGasStx: gasCostStx,
      projectedDailyFeeBps: plan.projectedDailyFeeBps,
      profitable,
      warning: vol.regime === "elevated" ? "Elevated volatility — wider bins recommended" : undefined,
      timestamp: new Date().toISOString(),
    },
    error: null,
  });
}

async function runExecute(
  poolId: string, address: string, binWidth: number,
  confirm: boolean, force: boolean, maxSbtc: number, maxStx: number
): Promise<void> {
  if (!confirm) {
    blocked("no_confirmation", "Rebalance requires --confirm flag and explicit operator approval.", "Add --confirm after reviewing the plan");
    return;
  }
  // Cooldown check
  const cooldownKey = `${poolId}:${address}`;
  const lastRun = lastRebalanceTimestamp[cooldownKey] || 0;
  if (Date.now() - lastRun < COOLDOWN_MS) {
    const waitMin = Math.ceil((COOLDOWN_MS - (Date.now() - lastRun)) / 60_000);
    blocked("cooldown", `Rebalance cooldown active. Wait ${waitMin} more minutes.`, "Wait for cooldown to expire");
    return;
  }
  // Check gas
  const stxBal = await getStxBalance(address);
  if (stxBal < MIN_GAS_USTX) {
    blocked("insufficient_gas", `STX balance ${stxBal} uSTX < minimum ${MIN_GAS_USTX} uSTX`, "Acquire more STX for gas");
    return;
  }
  // Build plan
  const [pool, binsResponse, posResponse] = await Promise.all([
    getHodlmmPool(poolId),
    getHodlmmPoolBins(poolId),
    getHodlmmUserPositionBins(address, poolId),
  ]);
  const positionBins = posResponse.bins;
  if (!positionBins || positionBins.length === 0) throw new Error("No position found");
  const activeBinId = binsResponse.active_bin_id ?? pool.active_bin;
  if (activeBinId == null) throw new Error("Cannot determine active bin");
  const vol = computeVolatilityScore(pool, binsResponse);
  if (vol.regime === "crisis" && !force) {
    blocked("crisis_regime", `Crisis regime (score ${vol.score}). Use --force to override.`, "Wait or use --force");
    return;
  }
  const plan = buildRebalancePlan(positionBins, activeBinId, binWidth);
  if (plan.staleBins.length === 0) {
    output({ status: "success", action: "Nothing to rebalance.", data: { activeBinId }, error: null });
    return;
  }
  // Spending limit checks
  if (plan.totalWithdrawX > maxSbtc) {
    blocked("exceeds_sbtc_limit", `Withdraw ${plan.totalWithdrawX} sats > max ${maxSbtc}`, "Reduce position or increase --max-sbtc");
    return;
  }
  // Output MCP commands for agent framework
  lastRebalanceTimestamp[cooldownKey] = Date.now();
  output({
    status: "success",
    action: "Execute rebalance via MCP tools: withdraw from stale bins, deposit into target bins.",
    data: {
      operation: "rebalance",
      network: NETWORK, poolId, address, activeBinId, binWidth,
      volatilityScore: vol.score, regime: vol.regime,
      mcp_commands: [
        {
          step: 1,
          description: "Withdraw liquidity from stale bins",
          tool: "bitflow_hodlmm_remove_liquidity",
          params: {
            poolId,
            binIds: plan.staleBins.map(b => b.bin_id),
            slippagePct: DEFAULT_SLIPPAGE_PCT,
          },
        },
        {
          step: 2,
          description: "Deposit liquidity into optimal target bins",
          tool: "bitflow_hodlmm_add_liquidity",
          params: {
            poolId,
            bins: plan.targetBins,
            slippagePct: DEFAULT_SLIPPAGE_PCT,
          },
        },
      ],
      plan: {
        staleBins: plan.staleBins,
        targetBins: plan.targetBins,
        totalWithdrawX: plan.totalWithdrawX,
        totalWithdrawY: plan.totalWithdrawY,
        estimatedGasUstx: plan.estimatedGasUstx,
      },
      safety: {
        maxSbtcSats: maxSbtc,
        maxStx: maxStx,
        slippagePct: DEFAULT_SLIPPAGE_PCT,
        cooldownMs: COOLDOWN_MS,
        forceOverride: force,
      },
      timestamp: new Date().toISOString(),
    },
    error: null,
  });
}

// -- Main
async function main(): Promise<void> {
  const command = process.argv[2];
  const args = parseArgs(process.argv.slice(3));

  switch (command) {
    case "doctor":
      await doctor();
      break;

    case "install-packs":
      output({
        status: "success",
        action: "No additional packages required — uses native fetch API",
        data: {
          required: ["fetch (built-in)"],
          optional: ["@stacks/transactions", "@stacks/network"],
          note: "Stacks packages only needed for direct contract calls. MCP tools handle this.",
        },
        error: null,
      });
      break;

    case "run": {
      const address = getWalletAddress();
      const action = args["action"] || "assess";
      const poolId = args["pool-id"];
      const binWidth = parseInt(args["bin-width"] || String(DEFAULT_BIN_WIDTH), 10);
      const confirm = args["confirm"] === "true";
      const force = args["force"] === "true";
      const maxSbtc = parseInt(args["max-sbtc"] || String(DEFAULT_MAX_SBTC_SATS), 10);
      const maxStx = parseInt(args["max-stx"] || String(DEFAULT_MAX_STX), 10);

      if (!poolId) {
        error("missing_pool_id", "Specify --pool-id", "Use --pool-id=dlmm_3");
        break;
      }

      switch (action) {
        case "assess":
          await runAssess(poolId, args["address"] || address);
          break;
        case "plan":
          await runPlan(poolId, args["address"] || address, binWidth, force);
          break;
        case "execute":
          await runExecute(poolId, args["address"] || address, binWidth, confirm, force, maxSbtc, maxStx);
          break;
        default:
          error("unknown_action", `Unknown action: ${action}`, "Use --action=assess|plan|execute");
      }
      break;
    }

    default:
      error("unknown_command", `Unknown command: ${command || "(none)"}`, "Use: doctor | run | install-packs");
  }
}

main().catch((e) => {
  error("unhandled", e.message, "Check stack trace and retry");
  process.exit(1);
});

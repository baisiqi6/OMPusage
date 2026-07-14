/**
 * OMPusage — 在编辑器下方显示多供应商 AI 用量。
 *
 * - Kimi / MiniMax: 优先复用 OMP AuthStorage 的官方 usage provider。
 * - DeepSeek / GLM: 当前 OMP 尚无对应 usage provider，保留小型自定义查询。
 */

import { readFile } from "node:fs/promises";
import { homedir } from "node:os";
import { join } from "node:path";
import type { ExtensionAPI, ExtensionContext, ExtensionWidgetContent } from "@oh-my-pi/pi-coding-agent";

interface UsageSnapshot {
  key: string;
  label: string;
  lines: string[];
  error?: string;
}

interface ProviderDef {
  key: string;
  label: string;
  ompProviderId: string;
  envTokenKey: string;
  legacyEnvTokenKey?: string;
  endpoint: string;
  headers: Record<string, string>;
  extract: (data: unknown) => string[];
  extra?: {
    endpoint: () => string;
    extract: (data: unknown) => string;
    unavailableText: string;
  };
}

interface OfficialUsageAmount {
  used?: number;
  limit?: number;
  remainingFraction?: number;
  usedFraction?: number;
  unit?: string;
}

interface OfficialUsageLimit {
  label?: string;
  window?: {
    label?: string;
    resetsAt?: number;
  };
  amount: OfficialUsageAmount;
}

interface OfficialUsageReport {
  provider: string;
  limits: OfficialUsageLimit[];
}

export interface SessionModelUsage {
  model: string;
  tokens: number;
  subagentTokens: number;
}

export interface SessionUsageSummary {
  totalTokens: number;
  subagentTokens: number;
  models: SessionModelUsage[];
}

export interface ProviderProcessedUsage {
  deepseek: number;
  minimax: number;
}

export interface DailyUsageItem {
  key: string;
  provider: keyof ProviderProcessedUsage;
  tokens: number;
}

interface DailyFileCache {
  modifiedAt: number;
  size: number;
  items: DailyUsageItem[];
}

interface DailyUsageCache {
  dayStart: number;
  files: Map<string, DailyFileCache>;
}

const BAR_WIDTH = 10;
const REFRESH_MS = 5 * 60 * 1000;
const DAILY_REFRESH_MS = 30_000;
const REQUEST_TIMEOUT_MS = 10_000;
const WIDGET_KEY = "ai-usage";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null;
}

function finiteNumber(value: unknown): number | undefined {
  const parsed = typeof value === "number" ? value : Number(value);
  return Number.isFinite(parsed) ? parsed : undefined;
}

function usageTokenCount(value: unknown): number {
  if (!isRecord(value)) return 0;
  const input = finiteNumber(value.input) ?? 0;
  const output = finiteNumber(value.output) ?? 0;
  const cacheWrite = finiteNumber(value.cacheWrite) ?? 0;
  const computed = input + output + cacheWrite;
  return computed > 0 ? computed : (finiteNumber(value.totalTokens) ?? 0);
}

function processedTokenCount(value: unknown): number {
  if (!isRecord(value)) return 0;
  const input = finiteNumber(value.input) ?? 0;
  const output = finiteNumber(value.output) ?? 0;
  const cacheRead = finiteNumber(value.cacheRead) ?? 0;
  const cacheWrite = finiteNumber(value.cacheWrite) ?? 0;
  const computed = input + output + cacheRead + cacheWrite;
  return computed > 0 ? computed : (finiteNumber(value.totalTokens) ?? 0);
}

function usageProvider(providerValue: unknown, modelValue: unknown): keyof ProviderProcessedUsage | undefined {
  const provider = typeof providerValue === "string" ? providerValue.toLowerCase() : "";
  const model = typeof modelValue === "string" ? modelValue.toLowerCase() : "";
  const resolvedProvider = model.includes("/") ? model.slice(0, model.indexOf("/")) : "";
  const identity = `${provider} ${resolvedProvider} ${model}`;
  if (/\bdeepseek\b/.test(identity)) return "deepseek";
  if (/\bminimax(?:-code(?:-cn)?)?\b/.test(identity)) return "minimax";
  return undefined;
}

export function localDayRange(now = Date.now()): { start: number; end: number } {
  const start = new Date(now);
  start.setHours(0, 0, 0, 0);
  const end = new Date(start);
  end.setDate(end.getDate() + 1);
  return { start: start.getTime(), end: end.getTime() };
}

export function collectDailyUsageItems(
  entries: unknown[],
  start: number,
  end: number,
  source = "entries",
): DailyUsageItem[] {
  const items: DailyUsageItem[] = [];
  for (const [index, rawEntry] of entries.entries()) {
    if (!isRecord(rawEntry) || rawEntry.type !== "message" || !isRecord(rawEntry.message)) continue;
    const message = rawEntry.message;
    if (message.role !== "assistant") continue;
    const timestamp =
      typeof rawEntry.timestamp === "number" ? rawEntry.timestamp : Date.parse(String(rawEntry.timestamp ?? ""));
    if (!Number.isFinite(timestamp) || timestamp < start || timestamp >= end) continue;
    const provider = usageProvider(message.provider, message.model);
    if (!provider) continue;
    const tokens = processedTokenCount(message.usage);
    if (tokens <= 0) continue;
    const id = typeof rawEntry.id === "string" && rawEntry.id ? rawEntry.id : `${source}:${index}`;
    const key = `${id}\u0000${timestamp}\u0000${String(message.provider ?? "")}\u0000${String(message.model ?? "")}`;
    items.push({ key, provider, tokens });
  }
  return items;
}

export function aggregateDailyUsageItems(items: DailyUsageItem[]): ProviderProcessedUsage {
  const summary: ProviderProcessedUsage = { deepseek: 0, minimax: 0 };
  const unique = new Map<string, DailyUsageItem>();
  for (const item of items) {
    const current = unique.get(item.key);
    if (!current || item.tokens > current.tokens) unique.set(item.key, item);
  }
  for (const item of unique.values()) {
    summary[item.provider] += Math.max(0, finiteNumber(item.tokens) ?? 0);
  }
  return summary;
}

export function summarizeDailyProviderUsage(entries: unknown[], start: number, end: number): ProviderProcessedUsage {
  return aggregateDailyUsageItems(collectDailyUsageItems(entries, start, end));
}

export function formatDailyUsageLine(summary: ProviderProcessedUsage, deepSeekBalance?: string): string {
  const total = summary.deepseek + summary.minimax;
  const balance = deepSeekBalance ? `（${deepSeekBalance}）` : "";
  return `本机今日用量  ·  DeepSeek ${Math.round(summary.deepseek).toLocaleString("en-US")}${balance}  ·  MiniMax ${Math.round(summary.minimax).toLocaleString("en-US")}  ·  合计 ${Math.round(total).toLocaleString("en-US")} Token`;
}

function normalizeModelName(value: unknown): string {
  if (typeof value !== "string" || !value.trim()) return "未归属模型";
  return value.trim().replace(/:(?:minimal|low|medium|high|xhigh|max|auto)$/i, "");
}

function addSessionModelUsage(
  models: Map<string, SessionModelUsage>,
  model: string,
  tokens: number,
  subagentTokens: number,
): void {
  if (tokens <= 0) return;
  const current = models.get(model) ?? { model, tokens: 0, subagentTokens: 0 };
  current.tokens += tokens;
  current.subagentTokens += subagentTokens;
  models.set(model, current);
}

export function summarizeSessionUsage(entries: unknown[]): SessionUsageSummary {
  const models = new Map<string, SessionModelUsage>();
  let totalTokens = 0;
  let subagentTokens = 0;

  for (const rawEntry of entries) {
    if (!isRecord(rawEntry) || rawEntry.type !== "message" || !isRecord(rawEntry.message)) continue;
    const message = rawEntry.message;

    if (message.role === "assistant") {
      const tokens = usageTokenCount(message.usage);
      const provider = typeof message.provider === "string" ? message.provider : "";
      const model = typeof message.model === "string" ? message.model : "";
      const modelName = normalizeModelName(provider && model ? `${provider}/${model}` : model || provider);
      totalTokens += tokens;
      addSessionModelUsage(models, modelName, tokens, 0);
      continue;
    }

    if (message.role !== "toolResult" || message.toolName !== "task" || !isRecord(message.details)) continue;
    const details = message.details;
    let attributedTokens = 0;
    const results = Array.isArray(details.results) ? details.results : [];
    for (const rawResult of results) {
      if (!isRecord(rawResult)) continue;
      const tokens = usageTokenCount(rawResult.usage);
      attributedTokens += tokens;
      addSessionModelUsage(models, normalizeModelName(rawResult.resolvedModel), tokens, tokens);
    }

    const taskTokens = Math.max(usageTokenCount(details.usage), attributedTokens);
    const unattributedTokens = Math.max(0, taskTokens - attributedTokens);
    if (unattributedTokens > 0) {
      addSessionModelUsage(models, "Sub-agent 未归属", unattributedTokens, unattributedTokens);
    }
    totalTokens += taskTokens;
    subagentTokens += taskTokens;
  }

  return {
    totalTokens,
    subagentTokens,
    models: [...models.values()].sort((a, b) => b.tokens - a.tokens || a.model.localeCompare(b.model)),
  };
}

function compactTokenCount(value: number): string {
  const format = (amount: number, digits: number) => amount.toFixed(digits).replace(/\.0+$|(?<=\.\d)0+$/g, "");
  if (value >= 1_000_000_000) return `${format(value / 1_000_000_000, value >= 10_000_000_000 ? 1 : 2)}B`;
  if (value >= 1_000_000) return `${format(value / 1_000_000, value >= 10_000_000 ? 1 : 2)}M`;
  if (value >= 1_000) return `${format(value / 1_000, value >= 10_000 ? 1 : 2)}k`;
  return Math.round(value).toLocaleString("en-US");
}

export function formatSessionUsageLines(summary: SessionUsageSummary): string[] {
  return [
    `会话总计  ·  ${compactTokenCount(summary.totalTokens)} Token  ·  Sub-agent ${compactTokenCount(summary.subagentTokens)}`,
  ];
}

function compactError(error: unknown): string {
  if (error instanceof DOMException && error.name === "TimeoutError") return "请求超时";
  const message = error instanceof Error ? error.message : String(error);
  return message.replace(/[\r\n\t]+/g, " ").slice(0, 120);
}

export function renderBar(percent: number): string {
  const clamped = Math.max(0, Math.min(100, Number.isFinite(percent) ? percent : 0));
  const filled = Math.round((clamped / 100) * BAR_WIDTH);
  return "●".repeat(filled) + "·".repeat(BAR_WIDTH - filled);
}

interface WidgetTheme {
  fg(
    color: "accent" | "dim" | "error" | "muted" | "success" | "text" | "warning",
    text: string,
  ): string;
  bold(text: string): string;
}

const OMP_TITLE_COLORS = [
  { rgb: [255, 92, 200], ansi256: 199 },
  { rgb: [200, 110, 255], ansi256: 171 },
  { rgb: [120, 130, 255], ansi256: 99 },
  { rgb: [60, 200, 255], ansi256: 51 },
] as const;

function supportsTrueColor(): boolean {
  if (process.env.COLORTERM === "truecolor" || process.env.COLORTERM === "24bit" || process.env.WT_SESSION) return true;
  const term = process.env.TERM ?? "";
  return term !== "" && term !== "dumb" && term !== "linux";
}

function ompTitleColor(index: number): string {
  const color = OMP_TITLE_COLORS[index];
  if (supportsTrueColor()) return `\x1b[38;2;${color.rgb.join(";")}m`;
  return `\x1b[38;5;${color.ansi256}m`;
}

function ompBrandTitle(): string {
  return `${ompTitleColor(0)}◆ ${ompTitleColor(1)}AI ${ompTitleColor(2)}用${ompTitleColor(3)}量\x1b[39m`;
}

function usageColor(percent: number): "error" | "success" | "warning" {
  if (percent >= 95) return "error";
  if (percent >= 80) return "warning";
  return "success";
}

function styleDetail(detail: string, theme: WidgetTheme): string {
  if (/拉取失败|无凭证/.test(detail)) return theme.fg("error", detail);
  if (/暂无|无可用|不可用/.test(detail)) return theme.fg("dim", detail);

  const meters = [...detail.matchAll(/([●·]{10})\s+(\d{1,3}%)/g)];
  if (meters.length === 0) return theme.fg("muted", detail);

  const rendered: string[] = [];
  let cursor = 0;
  for (const meter of meters) {
    const start = meter.index ?? cursor;
    if (start > cursor) rendered.push(theme.fg("muted", detail.slice(cursor, start)));
    const percent = Number.parseInt(meter[2], 10);
    rendered.push(theme.fg(usageColor(percent), `${meter[1]} ${meter[2].padStart(4)}`));
    cursor = start + meter[0].length;
  }
  if (cursor < detail.length) rendered.push(theme.fg("dim", detail.slice(cursor)));
  return rendered.join("");
}

function styledDetailWidth(detail: string): number {
  const normalized = detail.replace(/([●·]{10})\s+(\d{1,3}%)/g, (_match, bar, percent) => {
    return `${bar} ${String(percent).padStart(4)}`;
  });
  return Bun.stringWidth(normalized);
}

export function styleWidgetLines(lines: string[], theme: WidgetTheme): string[] {
  const rendered: string[] = [];
  const sevenDaySeparator = "  ·  7d";
  const sevenDayColumn = Math.max(
    0,
    ...lines.map(line => {
      const provider = line.match(/^(?:GLM|Kimi|MiniMax)\s+(.*)$/);
      const separator = provider?.[1]?.indexOf(sevenDaySeparator) ?? -1;
      return separator >= 0 ? styledDetailWidth(provider![1]!.slice(0, separator)) : 0;
    }),
  );
  let previousProvider: string | undefined;
  for (const line of lines) {
    if (line.startsWith("AI 用量")) {
      const meta = line.split("  ·  ").slice(1);
      rendered.push(
        `${theme.bold(ompBrandTitle())}${meta.length ? theme.fg("dim", `  ·  ${meta.join("  ·  ")}`) : ""}`,
      );
      previousProvider = undefined;
      continue;
    }

    if (line.startsWith("会话总计  ·  ")) {
      const detail = line.slice("会话总计  ·  ".length);
      rendered.push(`${theme.bold(theme.fg("accent", "会话总计  "))}${theme.fg("muted", detail)}`);
      previousProvider = undefined;
      continue;
    }

    if (line.startsWith("本机今日用量  ·  ")) {
      const detail = line.slice("本机今日用量  ·  ".length);
      rendered.push(`${theme.bold(theme.fg("accent", "本机今日用量  "))}${theme.fg("muted", detail)}`);
      previousProvider = undefined;
      continue;
    }

    if (line.startsWith("模型 ")) {
      const separator = line.indexOf("  ·  ");
      if (separator > 3) {
        const model = line.slice(3, separator);
        const detail = line.slice(separator + 5);
        rendered.push(`${theme.bold(theme.fg("text", model.padEnd(10)))}${theme.fg("muted", detail)}`);
        previousProvider = undefined;
        continue;
      }
    }

    const provider = line.match(/^(DeepSeek|GLM|Kimi|MiniMax)\s+(.*)$/);
    if (!provider) {
      rendered.push(theme.fg("dim", line));
      previousProvider = undefined;
      continue;
    }
    const label = provider[1] === previousProvider ? " ".repeat(10) : theme.bold(theme.fg("text", provider[1].padEnd(10)));
    let detail = provider[2];
    const sevenDaySeparatorIndex = detail.indexOf(sevenDaySeparator);
    if (sevenDaySeparatorIndex >= 0) {
      const padding = Math.max(0, sevenDayColumn - styledDetailWidth(detail.slice(0, sevenDaySeparatorIndex)));
      detail = `${detail.slice(0, sevenDaySeparatorIndex)}${" ".repeat(padding)}${detail.slice(sevenDaySeparatorIndex)}`;
    }
    rendered.push(`${label}${styleDetail(detail, theme)}`);
    previousProvider = provider[1];
  }
  return rendered;
}

function widgetContent(lines: string[]): ExtensionWidgetContent {
  return (_tui, theme) => {
    const rendered = styleWidgetLines(lines, theme);
    return { render: () => rendered };
  };
}

function percentText(percent: number): string {
  return `${percent.toFixed(0).padStart(3)}%`;
}

export function formatReset(resetMs: number, now = Date.now()): string {
  const diffMs = resetMs - now;
  if (diffMs <= 0) return "即将重置";
  const mins = Math.floor(diffMs / 60_000);
  const hrs = Math.floor(mins / 60);
  if (hrs >= 24) return `${Math.floor(hrs / 24)}d${hrs % 24}h`;
  if (hrs > 0) return `${hrs}h${mins % 60}m`;
  return `${mins}m`;
}

function money(currency: string, value: unknown): string {
  const amount = String(value ?? "?");
  if (currency === "CNY") return `¥${amount}`;
  if (currency === "USD") return `$${amount}`;
  return `${amount} ${currency}`.trim();
}

export function extractDeepSeek(data: unknown): string[] {
  if (!isRecord(data)) throw new Error("unexpected shape");
  if (data.is_available === false) return ["DeepSeek 余额不可用"];
  const infos = Array.isArray(data.balance_infos) ? data.balance_infos : [];
  if (infos.length === 0) return ["DeepSeek 暂无余额数据"];

  return infos.map(info => {
    if (!isRecord(info)) throw new Error("unexpected balance item");
    const currency = typeof info.currency === "string" ? info.currency : "";
    return `DeepSeek 余额 ${money(currency, info.total_balance)}`;
  });
}

function glmWindowLabel(unit: unknown, countValue: unknown): string {
  const count = finiteNumber(countValue) ?? 1;
  switch (finiteNumber(unit)) {
    case 3:
      return `${count}h`;
    case 4:
      return `${count}d`;
    case 5:
      return count === 1 ? "月度" : `${count}mo`;
    case 6:
      return "7d";
    default:
      return "配额";
  }
}

function glmLimitLabel(limit: Record<string, unknown>): string {
  const window = glmWindowLabel(limit.unit, limit.number);
  if (limit.type === "TOKENS_LIMIT") return window;
  if (limit.type === "TIME_LIMIT") return `请求 (${window})`;
  return `${String(limit.type ?? "未知")} (${window})`;
}

function isGlmToolQuota(limit: Record<string, unknown>): boolean {
  if (limit.type !== "TIME_LIMIT") return false;
  const details = Array.isArray(limit.usageDetails) ? limit.usageDetails : [];
  const codes = details
    .filter(isRecord)
    .map(item => item.modelCode)
    .filter((value): value is string => typeof value === "string");
  return ["search-prime", "web-reader", "zread"].every(code => codes.includes(code));
}

export function extractGlm(data: unknown): string[] {
  if (!isRecord(data)) throw new Error("unexpected shape");
  if (data.success === false) throw new Error(String(data.msg ?? "request failed"));
  if (!isRecord(data.data)) throw new Error("missing data field");
  const limits = Array.isArray(data.data.limits) ? data.data.limits : [];
  if (limits.length === 0) return ["GLM: 无限额数据"];

  const details: string[] = [];
  for (const rawLimit of limits) {
    if (!isRecord(rawLimit)) continue;
    if (isGlmToolQuota(rawLimit)) continue;
    const percent = finiteNumber(rawLimit.percentage);
    if (percent === undefined) continue;
    const resetMs = finiteNumber(rawLimit.nextResetTime);
    const reset = resetMs && resetMs > 0 ? `（${formatReset(resetMs)} 后重置）` : "";
    details.push(`${glmLimitLabel(rawLimit)}  ${renderBar(percent)} ${percentText(percent)}${reset}`);
  }
  return details.length > 0 ? [`GLM ${details.join("  ·  ")}`] : ["GLM 暂无 Token 配额数据"];
}

export function extractGlmModelUsage(data: unknown): string {
  if (!isRecord(data)) throw new Error("unexpected shape");
  if (data.success === false) throw new Error(String(data.msg ?? "request failed"));
  if (!isRecord(data.data) || !isRecord(data.data.totalUsage)) throw new Error("missing total usage");
  const tokens = finiteNumber(data.data.totalUsage.totalTokensUsage);
  const calls = finiteNumber(data.data.totalUsage.totalModelCallCount);
  if (tokens === undefined || calls === undefined) throw new Error("missing token or call total");
  return `近7天 ${Math.round(tokens).toLocaleString("en-US")} Token / ${Math.round(calls).toLocaleString("en-US")} 次调用`;
}

function timestampMs(value: unknown): number | undefined {
  const parsed = finiteNumber(value);
  if (parsed === undefined || parsed <= 0) return undefined;
  return parsed < 10_000_000_000 ? parsed * 1000 : parsed;
}

export function extractMiniMaxUsage(data: unknown, now = Date.now()): string[] {
  if (!isRecord(data)) throw new Error("unexpected shape");
  const models = Array.isArray(data.model_remains) ? data.model_remains.filter(isRecord) : [];
  if (models.length === 0) return ["MiniMax 暂无 5h 配额数据"];
  const quota =
    models.find(model => String(model.model_name ?? "").toLowerCase() === "general") ??
    models.find(model => !/video/i.test(String(model.model_name ?? ""))) ??
    models[0]!;

  const renderWindow = (
    label: string,
    statusValue: unknown,
    percentValue: unknown,
    remainingValue: unknown,
    totalValue: unknown,
    endValue: unknown,
    remainsTimeValue: unknown,
  ): string => {
    if (finiteNumber(statusValue) === 3) return `${label}  无限`;
    const explicitRemaining = finiteNumber(percentValue);
    const total = finiteNumber(totalValue);
    const remaining = finiteNumber(remainingValue);
    const remainingPercent =
      explicitRemaining ?? (total !== undefined && total > 0 && remaining !== undefined ? (remaining / total) * 100 : undefined);
    if (remainingPercent === undefined) return `${label}  ·  暂无百分比数据`;
    const usedPercent = Math.max(0, Math.min(100, 100 - remainingPercent));
    const endTime = timestampMs(endValue);
    const remainsTime = finiteNumber(remainsTimeValue);
    const resetAt = endTime && endTime > now ? endTime : remainsTime && remainsTime > 0 ? now + remainsTime : undefined;
    const reset = resetAt ? `（${formatReset(resetAt, now)} 后重置）` : "";
    return `${label}  ${renderBar(usedPercent)} ${percentText(usedPercent)}${reset}`;
  };

  const windows = [
    renderWindow(
      "5h",
      quota.current_interval_status,
      quota.current_interval_remaining_percent,
      quota.current_interval_usage_count,
      quota.current_interval_total_count,
      quota.end_time,
      quota.remains_time,
    ),
  ];
  const hasWeeklyData = [
    quota.current_weekly_status,
    quota.current_weekly_remaining_percent,
    quota.current_weekly_usage_count,
    quota.current_weekly_total_count,
    quota.weekly_end_time,
    quota.weekly_remains_time,
  ].some(value => finiteNumber(value) !== undefined);
  if (hasWeeklyData) {
    windows.push(
      renderWindow(
        "7d",
        quota.current_weekly_status,
        quota.current_weekly_remaining_percent,
        quota.current_weekly_usage_count,
        quota.current_weekly_total_count,
        quota.weekly_end_time,
        quota.weekly_remains_time,
      ),
    );
  }
  return [`MiniMax ${windows.join("  ·  ")}`];
}

function absoluteTimestampMs(value: unknown): number | undefined {
  if (typeof value === "string" && value.trim()) {
    const parsed = Date.parse(value);
    if (Number.isFinite(parsed)) return parsed;
  }
  return timestampMs(value);
}

export function extractKimiUsage(data: unknown, now = Date.now()): string[] {
  if (!isRecord(data)) throw new Error("unexpected shape");
  const limits: OfficialUsageLimit[] = [];
  const fiveHour = Array.isArray(data.limits)
    ? data.limits.find(item => isRecord(item) && isRecord(item.detail))
    : undefined;
  if (isRecord(fiveHour) && isRecord(fiveHour.detail)) {
    const maximum = finiteNumber(fiveHour.detail.limit);
    const remaining = finiteNumber(fiveHour.detail.remaining);
    if (maximum !== undefined && maximum > 0 && remaining !== undefined) {
      limits.push({
        label: "5h limit",
        amount: { usedFraction: Math.max(0, Math.min(1, (maximum - remaining) / maximum)) },
        window: { label: "5h limit", resetsAt: absoluteTimestampMs(fiveHour.detail.resetTime) },
      });
    }
  }

  if (isRecord(data.usage)) {
    const maximum = finiteNumber(data.usage.limit);
    const remaining = finiteNumber(data.usage.remaining);
    if (maximum !== undefined && maximum > 0 && remaining !== undefined) {
      limits.push({
        label: "Total quota",
        amount: { usedFraction: Math.max(0, Math.min(1, (maximum - remaining) / maximum)) },
        window: { label: "Usage window", resetsAt: absoluteTimestampMs(data.usage.resetTime) },
      });
    }
  }

  return renderOfficialReports(
    [{ provider: "kimi-code", limits }],
    ["kimi-code"],
    "Kimi",
    "Kimi 暂无可用官方用量数据",
    now,
  );
}

function formatGlmUsageTime(date: Date): string {
  const pad = (value: number) => String(value).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}+${pad(date.getHours())}:${pad(
    date.getMinutes(),
  )}:${pad(date.getSeconds())}`;
}

function glmModelUsageEndpoint(now = Date.now()): string {
  const end = new Date(now);
  const start = new Date(now - 7 * 24 * 60 * 60 * 1000);
  return `https://open.bigmodel.cn/api/monitor/usage/model-usage?startTime=${encodeURIComponent(formatGlmUsageTime(start))}&endTime=${encodeURIComponent(formatGlmUsageTime(end))}`;
}

async function fetchCustomProvider(def: ProviderDef, ctx: ExtensionContext): Promise<UsageSnapshot> {
  try {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const ompToken = await ctx.modelRegistry.getApiKeyForProvider(
      def.ompProviderId,
      ctx.sessionManager.getSessionId(),
      { signal },
    );
    const token = ompToken?.trim() || (def.legacyEnvTokenKey ? process.env[def.legacyEnvTokenKey]?.trim() : undefined);
    if (!token) {
      return {
        key: def.key,
        label: def.label,
        lines: [`${def.label} 无凭证  ·  通过 omp 登录或设置 ${def.envTokenKey}`],
        error: "no credential",
      };
    }

    const response = await fetch(def.endpoint, {
      headers: { ...def.headers, Authorization: `Bearer ${token}` },
      signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    const lines = def.extract(await response.json());

    if (def.extra) {
      try {
        const extraResponse = await fetch(def.extra.endpoint(), {
          headers: { ...def.headers, Authorization: `Bearer ${token}` },
          signal,
        });
        if (!extraResponse.ok) throw new Error(`HTTP ${extraResponse.status}`);
        const detail = def.extra.extract(await extraResponse.json());
        if (lines.length > 0) lines[0] = `${lines[0]}  ·  ${detail}`;
      } catch (error) {
        const message = compactError(error);
        if (lines.length > 0) lines[0] = `${lines[0]}  ·  ${def.extra.unavailableText}`;
        return { key: def.key, label: def.label, lines, error: message };
      }
    }

    return { key: def.key, label: def.label, lines };
  } catch (error) {
    const message = compactError(error);
    return {
      key: def.key,
      label: def.label,
      lines: [`${def.label} 拉取失败  ·  ${message}`],
      error: message,
    };
  }
}

function officialUsedFraction(limit: OfficialUsageLimit): number | undefined {
  const explicit = finiteNumber(limit.amount.usedFraction);
  if (explicit !== undefined) return explicit;
  const used = finiteNumber(limit.amount.used);
  const maximum = finiteNumber(limit.amount.limit);
  if (used !== undefined && maximum !== undefined && maximum > 0) return used / maximum;
  const remaining = finiteNumber(limit.amount.remainingFraction);
  return remaining === undefined ? undefined : 1 - remaining;
}

function cleanLabel(value: unknown, fallback: string): string {
  if (typeof value !== "string" || !value.trim()) return fallback;
  return value.replace(/[\u0000-\u001f\u007f]+/g, " ").trim().slice(0, 48);
}

function localizeUsageLabel(value: string): string {
  if (/^total quota$/i.test(value)) return "7d";
  if (/^usage window$/i.test(value)) return "总量";
  const window = value.match(/^(\d+)h limit$/i);
  if (window) return `${window[1]}h`;
  return value.replace(/\s+limit$/i, "");
}

function usageLabelOrder(value: string): number {
  if (value === "5h") return 0;
  if (value === "7d") return 1;
  return 2;
}

export function renderOfficialReports(
  reports: OfficialUsageReport[],
  providerIds: string[],
  label: string,
  noDataLine: string,
  now = Date.now(),
): string[] {
  const limits = reports.filter(report => providerIds.includes(report.provider)).flatMap(report => report.limits);
  if (limits.length === 0) return [noDataLine];

  const rendered = limits
    .map(limit => ({
      limit,
      title: localizeUsageLabel(cleanLabel(limit.label ?? limit.window?.label, "配额")),
    }))
    .sort((a, b) => usageLabelOrder(a.title) - usageLabelOrder(b.title))
    .map(({ limit, title }) => {
      const fraction = officialUsedFraction(limit);
      const percent = fraction === undefined ? undefined : fraction * 100;
      const resetAt = finiteNumber(limit.window?.resetsAt);
      const reset =
        resetAt && resetAt > 0
          ? `（${formatReset(resetAt, now)} 后重置）`
          : title === "5h" && percent === 0
            ? "（未开始计时）"
            : title === "5h"
              ? "（重置时间未知）"
              : "";
      if (percent === undefined) return `${title}  ·  暂无百分比数据${reset}`;
      return `${title}  ${renderBar(percent)} ${percentText(percent)}${reset}`;
    });

  const visible = rendered.slice(0, 3);
  if (rendered.length > visible.length) visible.push(`另有 ${rendered.length - visible.length} 项`);
  return [`${label} ${visible.join("  ·  ")}`];
}

async function fetchKimiSnapshot(ctx: ExtensionContext): Promise<UsageSnapshot> {
  try {
    const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
    const stored = await ctx.modelRegistry.getApiKeyForProvider("kimi-code", ctx.sessionManager.getSessionId(), { signal });
    const token = stored?.trim() || process.env.KIMI_CODE_API_KEY?.trim() || process.env.KIMI_API_KEY?.trim();
    if (!token) {
      return {
        key: "kimi-code",
        label: "Kimi",
        lines: ["Kimi 无凭证  ·  通过 omp 登录或设置 KIMI_API_KEY"],
        error: "no credential",
      };
    }
    const baseUrl = ctx.modelRegistry.getProviderBaseUrl("kimi-code")?.trim() || "https://api.kimi.com/coding/v1";
    const response = await fetch(`${baseUrl.replace(/\/+$/, "")}/usages`, {
      headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
      signal,
    });
    if (!response.ok) throw new Error(`HTTP ${response.status}`);
    return { key: "kimi-code", label: "Kimi", lines: extractKimiUsage(await response.json()) };
  } catch (error) {
    const message = compactError(error);
    return { key: "kimi-code", label: "Kimi", lines: [`Kimi 拉取失败  ·  ${message}`], error: message };
  }
}

async function fetchMiniMaxSnapshot(ctx: ExtensionContext): Promise<UsageSnapshot> {
  const candidates = [
    {
      provider: "minimax-code-cn",
      endpoint: "https://api.minimaxi.com/v1/token_plan/remains",
      envKeys: ["MINIMAX_CODE_CN_API_KEY", "MINIMAX_API_KEY"],
    },
    {
      provider: "minimax-code",
      endpoint: "https://api.minimax.io/v1/token_plan/remains",
      envKeys: ["MINIMAX_CODE_API_KEY", "MINIMAX_API_KEY"],
    },
  ];
  let lastError: unknown;
  let foundCredential = false;

  for (const candidate of candidates) {
    try {
      const signal = AbortSignal.timeout(REQUEST_TIMEOUT_MS);
      const stored = await ctx.modelRegistry.getApiKeyForProvider(candidate.provider, ctx.sessionManager.getSessionId(), {
        signal,
      });
      const fromEnvironment = candidate.envKeys.map(key => process.env[key]?.trim()).find(Boolean);
      const token = stored?.trim() || fromEnvironment;
      if (!token) continue;
      foundCredential = true;
      const response = await fetch(candidate.endpoint, {
        headers: { Accept: "application/json", Authorization: `Bearer ${token}` },
        signal,
      });
      if (!response.ok) throw new Error(`HTTP ${response.status}`);
      return { key: "minimax-code", label: "MiniMax", lines: extractMiniMaxUsage(await response.json()) };
    } catch (error) {
      lastError = error;
    }
  }

  if (!foundCredential) {
    return {
      key: "minimax-code",
      label: "MiniMax",
      lines: ["MiniMax 无凭证  ·  通过 omp 登录或设置 MINIMAX_API_KEY"],
      error: "no credential",
    };
  }
  const message = compactError(lastError);
  return {
    key: "minimax-code",
    label: "MiniMax",
    lines: [`MiniMax 拉取失败  ·  ${message}`],
    error: message,
  };
}

export function materializeSnapshot(snapshot: UsageSnapshot, lastSuccess: Map<string, string[]>): string[] {
  if (!snapshot.error) {
    lastSuccess.set(snapshot.key, snapshot.lines);
    return snapshot.lines;
  }
  const cached = lastSuccess.get(snapshot.key);
  if (!cached) return snapshot.lines;
  return cached.map((line, index) => (index === 0 ? `${line}  ⚠ 旧数据` : line));
}

const DEEPSEEK: ProviderDef = {
  key: "deepseek",
  label: "DeepSeek",
  ompProviderId: "deepseek",
  envTokenKey: "DEEPSEEK_API_KEY",
  endpoint: "https://api.deepseek.com/user/balance",
  headers: { Accept: "application/json" },
  extract: extractDeepSeek,
};

const GLM: ProviderDef = {
  key: "zhipu-coding-plan",
  label: "GLM",
  ompProviderId: "zhipu-coding-plan",
  envTokenKey: "ZHIPU_API_KEY",
  legacyEnvTokenKey: "GLM_TOKEN",
  endpoint: "https://open.bigmodel.cn/api/monitor/usage/quota/limit",
  headers: { Accept: "application/json" },
  extract: extractGlm,
  extra: {
    endpoint: glmModelUsageEndpoint,
    extract: extractGlmModelUsage,
    unavailableText: "近7天统计不可用",
  },
};

const CUSTOM_PROVIDERS = [DEEPSEEK, GLM];

function sessionDirectory(): string {
  const agentDir = process.env.PI_CODING_AGENT_DIR?.trim() || join(homedir(), ".omp", "agent");
  return join(agentDir, "sessions");
}

function parseJsonl(value: string): unknown[] {
  const entries: unknown[] = [];
  for (const line of value.split("\n")) {
    if (!line) continue;
    try {
      entries.push(JSON.parse(line));
    } catch {
      // A running session may be between writes; the next refresh will read the completed line.
    }
  }
  return entries;
}

async function scanDailyProviderUsage(cache: DailyUsageCache, now = Date.now()): Promise<ProviderProcessedUsage> {
  const range = localDayRange(now);
  if (cache.dayStart !== range.start) {
    cache.dayStart = range.start;
    cache.files.clear();
  }

  const directory = sessionDirectory();
  let relativePaths: string[];
  try {
    relativePaths = [...new Bun.Glob("**/*.jsonl").scanSync({ cwd: directory, onlyFiles: true })];
  } catch (error) {
    if (isRecord(error) && error.code === "ENOENT") return { deepseek: 0, minimax: 0 };
    throw error;
  }

  const visiblePaths = new Set<string>();
  await Promise.all(
    relativePaths.map(async relativePath => {
      const path = join(directory, relativePath);
      try {
        const file = Bun.file(path);
        const modifiedAt = file.lastModified;
        const size = file.size;
        if (modifiedAt < range.start) return;
        visiblePaths.add(path);
        const cached = cache.files.get(path);
        if (cached && cached.modifiedAt === modifiedAt && cached.size === size) return;
        const entries = parseJsonl(await readFile(path, "utf8"));
        cache.files.set(path, {
          modifiedAt,
          size,
          items: collectDailyUsageItems(entries, range.start, range.end, relativePath),
        });
      } catch {
        cache.files.delete(path);
      }
    }),
  );

  for (const path of cache.files.keys()) {
    if (!visiblePaths.has(path)) cache.files.delete(path);
  }

  return aggregateDailyUsageItems([...cache.files.values()].flatMap(file => file.items));
}

export default function aiUsageWidget(pi: ExtensionAPI): void {
  pi.setLabel("OMPusage");

  let remoteTimer: ReturnType<typeof setInterval> | undefined;
  let dailyTimer: ReturnType<typeof setInterval> | undefined;
  let lifecycleVersion = 0;
  let renderCurrentSession: (() => void) | undefined;
  let syncCurrentDailyUsage: (() => Promise<void>) | undefined;
  const lastSuccess = new Map<string, string[]>();
  const dailyCache: DailyUsageCache = { dayStart: 0, files: new Map() };

  pi.on("session_start", (_event, ctx) => {
    if (!ctx.hasUI) return;
    const version = ++lifecycleVersion;
    let refreshInFlight: Promise<void> | undefined;
    let dailySyncInFlight: Promise<void> | undefined;
    let dailyUsage: ProviderProcessedUsage | undefined;
    let deepSeekBalance: string | undefined;
    let providerLines: string[] = [];
    if (remoteTimer) clearInterval(remoteTimer);
    if (dailyTimer) clearInterval(dailyTimer);

    const renderWidget = (): void => {
      if (version !== lifecycleVersion) return;
      const sessionLines = formatSessionUsageLines(summarizeSessionUsage(ctx.sessionManager.getBranch()));
      ctx.ui.setWidget(
        WIDGET_KEY,
        widgetContent([
          "AI 用量  ·  5 分钟刷新",
          ...sessionLines,
          ...(dailyUsage ? [formatDailyUsageLine(dailyUsage, deepSeekBalance)] : []),
          ...providerLines,
        ]),
        { placement: "belowEditor" },
      );
    };
    renderCurrentSession = renderWidget;

    const syncDailyUsage = async (): Promise<void> => {
      if (dailySyncInFlight) await dailySyncInFlight;
      if (version !== lifecycleVersion) return;
      const operation = (async () => {
        const usage = await scanDailyProviderUsage(dailyCache);
        if (version !== lifecycleVersion) return;
        dailyUsage = usage;
        renderWidget();
      })()
        .catch(error => {
          pi.logger.warn("AI usage widget daily usage scan failed", { error: compactError(error) });
        })
        .finally(() => {
          if (dailySyncInFlight === operation) dailySyncInFlight = undefined;
        });
      dailySyncInFlight = operation;
      await operation;
    };
    syncCurrentDailyUsage = syncDailyUsage;

    const refresh = (): Promise<void> => {
      if (refreshInFlight) return refreshInFlight;
      refreshInFlight = (async () => {
        const [custom, kimi, minimax] = await Promise.all([
          Promise.all(CUSTOM_PROVIDERS.map(provider => fetchCustomProvider(provider, ctx))),
          fetchKimiSnapshot(ctx),
          fetchMiniMaxSnapshot(ctx),
        ]);
        if (version !== lifecycleVersion) return;

        providerLines = [];
        for (const snapshot of [...custom, kimi, minimax]) {
          if (snapshot.error) {
            pi.logger.warn("AI usage widget refresh failed", {
              provider: snapshot.key,
              error: snapshot.error,
            });
          }
          const lines = materializeSnapshot(snapshot, lastSuccess);
          if (snapshot.key === "deepseek") {
            deepSeekBalance = lines.map(line => line.replace(/^DeepSeek\s+/, "")).join(" / ");
            continue;
          }
          providerLines.push(...lines);
        }
        renderWidget();
      })()
        .catch(error => {
          pi.logger.warn("AI usage widget refresh crashed", { error: compactError(error) });
        })
        .finally(() => {
          refreshInFlight = undefined;
        });
      return refreshInFlight;
    };

    ctx.ui.setWidget(WIDGET_KEY, widgetContent(["AI 用量  ·  正在加载…"]), { placement: "belowEditor" });
    void refresh();
    void syncDailyUsage();
    remoteTimer = setInterval(() => void refresh(), REFRESH_MS);
    dailyTimer = setInterval(() => void syncDailyUsage(), DAILY_REFRESH_MS);
  });

  pi.on("agent_end", (_event, ctx) => {
    if (!ctx.hasUI) return;
    renderCurrentSession?.();
    return syncCurrentDailyUsage?.();
  });

  pi.on("session_shutdown", (_event, ctx) => {
    lifecycleVersion += 1;
    renderCurrentSession = undefined;
    syncCurrentDailyUsage = undefined;
    if (remoteTimer) {
      clearInterval(remoteTimer);
      remoteTimer = undefined;
    }
    if (dailyTimer) {
      clearInterval(dailyTimer);
      dailyTimer = undefined;
    }
    if (ctx.hasUI) ctx.ui.setWidget(WIDGET_KEY, undefined);
  });
}

import { afterEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import aiUsageWidget, {
  aggregateDailyUsageItems,
  collectDailyUsageItems,
  extractDeepSeek,
  extractGlm,
  extractGlmModelUsage,
  extractKimiUsage,
  extractMiniMaxUsage,
  formatDailyUsageLine,
  formatSessionUsageLines,
  formatReset,
  materializeSnapshot,
  renderBar,
  renderOfficialReports,
  styleWidgetLines,
  summarizeDailyProviderUsage,
  summarizeSessionUsage,
} from "./index";

const originalFetch = globalThis.fetch;
const originalAgentDir = process.env.PI_CODING_AGENT_DIR;
let temporaryAgentDir: string | undefined;
const stripAnsi = (value: string) => value.replace(/\x1b\[[0-9;]*m/g, "");

afterEach(async () => {
  globalThis.fetch = originalFetch;
  if (temporaryAgentDir) await rm(temporaryAgentDir, { recursive: true, force: true });
  temporaryAgentDir = undefined;
  if (originalAgentDir === undefined) delete process.env.PI_CODING_AGENT_DIR;
  else process.env.PI_CODING_AGENT_DIR = originalAgentDir;
});

describe("provider parsers", () => {
  test("DeepSeek renders currency-specific symbols", () => {
    expect(
      extractDeepSeek({
        is_available: true,
        balance_infos: [
          { currency: "CNY", total_balance: "12.34", granted_balance: "2.34", topped_up_balance: "10.00" },
          { currency: "USD", total_balance: "5.67", granted_balance: "0.67", topped_up_balance: "5.00" },
        ],
      }),
    ).toEqual([
      "DeepSeek 余额 ¥12.34",
      "DeepSeek 余额 $5.67",
    ]);
  });

  test("GLM hides the monthly tool quota and keeps token windows", () => {
    const lines = extractGlm({
      success: true,
      data: {
        level: "max",
        limits: [
          {
            type: "TIME_LIMIT",
            unit: 5,
            number: 1,
            percentage: 1,
            nextResetTime: Date.now() + 60_000,
            usageDetails: [
              { modelCode: "search-prime" },
              { modelCode: "web-reader" },
              { modelCode: "zread" },
            ],
          },
          { type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 25 },
          { type: "TOKENS_LIMIT", unit: 6, number: 1, percentage: 80 },
        ],
      },
    });
    expect(lines).toHaveLength(1);
    expect(lines.join("\n")).not.toContain("工具请求");
    expect(lines[0]).toContain("GLM 5h");
    expect(lines[0]).not.toContain("max");
    expect(lines[0]).toContain("7d");
    expect(lines[0]).not.toContain("Token (");
  });

  test("long reset durations render in days", () => {
    expect(formatReset(3 * 24 * 60 * 60 * 1000, 0)).toBe("3d0h");
  });

  test("GLM renders the rolling seven-day token and call totals", () => {
    expect(
      extractGlmModelUsage({
        success: true,
        data: { totalUsage: { totalTokensUsage: 123456789, totalModelCallCount: 1234 } },
      }),
    ).toBe("近7天 123,456,789 Token / 1,234 次调用");
  });

  test("MiniMax converts the official remaining quota into used percent and reset time", () => {
    const now = Date.UTC(2026, 6, 13, 0, 0, 0);
    expect(
      extractMiniMaxUsage(
        {
          model_remains: [
            {
              model_name: "general",
              current_interval_remaining_percent: 80,
              current_interval_status: 1,
              end_time: now + 3.5 * 60 * 60 * 1000,
              remains_time: 3.5 * 60 * 60 * 1000,
              current_weekly_remaining_percent: 90,
              current_weekly_status: 1,
              weekly_end_time: now + (6 * 24 + 7) * 60 * 60 * 1000,
              weekly_remains_time: (6 * 24 + 7) * 60 * 60 * 1000,
            },
          ],
        },
        now,
      ),
    ).toEqual([
      `MiniMax 5h  ${renderBar(20)}  20%（3h30m 后重置）  ·  7d  ${renderBar(10)}  10%（6d7h 后重置）`,
    ]);
  });

  test("Kimi reads the five-hour reset from detail.resetTime", () => {
    const now = Date.UTC(2026, 6, 13, 12, 0, 0);
    expect(
      extractKimiUsage(
        {
          limits: [
            {
              detail: { limit: "100", remaining: "75", resetTime: new Date(now + 90 * 60_000).toISOString() },
              window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            },
          ],
          usage: { limit: "100", remaining: "50", resetTime: new Date(now + 6 * 24 * 60 * 60_000).toISOString() },
        },
        now,
      ),
    ).toEqual([
      `Kimi 5h  ${renderBar(25)}  25%（1h30m 后重置）  ·  7d  ${renderBar(50)}  50%（6d0h 后重置）`,
    ]);
  });

  test("Kimi accepts the current seven-day used field", () => {
    const now = Date.UTC(2026, 6, 14, 12, 0, 0);
    expect(
      extractKimiUsage(
        {
          limits: [
            {
              detail: { limit: "100", remaining: "75", resetTime: new Date(now + 90 * 60_000).toISOString() },
              window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            },
          ],
          usage: { limit: "100", used: "50", resetTime: new Date(now + 6 * 24 * 60 * 60_000).toISOString() },
        },
        now,
      ),
    ).toEqual([
      `Kimi 5h  ${renderBar(25)}  25%（1h30m 后重置）  ·  7d  ${renderBar(50)}  50%（6d0h 后重置）`,
    ]);
  });
});

describe("official usage rendering", () => {
  test("renders Kimi normalized usage reports", () => {
    const lines = renderOfficialReports(
      [
        {
          provider: "kimi-code",
          limits: [
            {
              label: "Total quota",
              amount: { unit: "unknown", usedFraction: 0.5 },
              window: { label: "Usage window" },
            },
            {
              label: "5h limit",
              amount: { unit: "unknown", usedFraction: 0 },
              window: { label: "5h limit" },
            },
          ],
        },
      ],
      ["kimi-code"],
      "Kimi",
      "Kimi: 无数据",
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("Kimi 5h");
    expect(lines[0]).toContain("0%");
    expect(lines[0]).toContain("未开始计时");
    expect(lines[0]).toContain("7d");
    expect(lines[0]).toContain("50%");
    expect(lines[0]).not.toContain("总量");
    expect(lines[0].indexOf("5h")).toBeLessThan(lines[0].indexOf("7d"));
  });

  test("uses compact themed meters with warning and error states", () => {
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bold: (text: string) => `<b>${text}</b>`,
    };
    const lines = styleWidgetLines(
      [`Kimi 5h  ${renderBar(89)}  89%  ·  7d  ${renderBar(98)}  98%`],
      theme as any,
    );
    expect(lines).toHaveLength(1);
    expect(lines[0]).toContain("<warning>");
    expect(lines[0]).toContain("<error>");
    expect(lines[0]).toContain("<b><text>Kimi      </text></b>");
  });

  test("aligns the seven-day column across GLM, Kimi, and MiniMax", () => {
    const theme = {
      fg: (_color: string, text: string) => text,
      bold: (text: string) => text,
    };
    const lines = styleWidgetLines(
      [
        `GLM 5h  ${renderBar(5)}   5%（4h4m 后重置）  ·  7d  ${renderBar(90)}  90%`,
        `Kimi 5h  ${renderBar(0)}   0%（未开始计时）  ·  7d  ${renderBar(89)}  89%`,
        `MiniMax 5h  ${renderBar(21)}  21%（3h9m 后重置）  ·  7d  ${renderBar(5)}   5%`,
      ],
      theme as any,
    );
    const resetColumns = lines.map(line => Bun.stringWidth(line.slice(0, line.indexOf("（"))));
    const columns = lines.map(line => Bun.stringWidth(line.slice(0, line.indexOf("7d"))));
    expect(new Set(resetColumns).size).toBe(1);
    expect(new Set(columns).size).toBe(1);
  });

  test("renders the widget title with the OMP brand gradient", () => {
    const theme = {
      fg: (color: string, text: string) => `<${color}>${text}</${color}>`,
      bold: (text: string) => `<b>${text}</b>`,
    };
    const [title] = styleWidgetLines(["AI 用量  ·  5 分钟刷新"], theme as any);
    const plain = stripAnsi(title);
    expect(plain).toBe("<b>◆ AI 用量</b><dim>  ·  5 分钟刷新</dim>");
    expect(title.match(/\x1b\[38;(?:2|5);/g)?.length ?? 0).toBe(4);
  });

  test("keeps the last successful snapshot after a failure", () => {
    const cache = new Map<string, string[]>();
    materializeSnapshot({ key: "kimi", label: "Kimi", lines: ["Kimi 64%"] }, cache);
    expect(
      materializeSnapshot(
        { key: "kimi", label: "Kimi", lines: ["Kimi: 拉取失败"], error: "timeout" },
        cache,
      ),
    ).toEqual(["Kimi 64%  ⚠ 旧数据"]);
  });
});

describe("session usage rendering", () => {
  test("aggregates main and sub-agent usage by model without cache reads", () => {
    const summary = summarizeSessionUsage([
      {
        type: "message",
        message: {
          role: "assistant",
          provider: "zhipu-coding-plan",
          model: "glm-5.2",
          usage: { input: 100, output: 50, cacheWrite: 10, cacheRead: 10_000, totalTokens: 10_160 },
        },
      },
      {
        type: "message",
        message: {
          role: "assistant",
          provider: "kimi-code",
          model: "kimi-k2",
          usage: { input: 200, output: 20, cacheWrite: 0, cacheRead: 20_000, totalTokens: 20_220 },
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "task",
          details: {
            usage: { input: 300, output: 30, cacheWrite: 0, totalTokens: 330 },
            results: [
              {
                resolvedModel: "zhipu-coding-plan/glm-5.2:high",
                usage: { input: 230, output: 20, cacheWrite: 0, totalTokens: 250 },
              },
              {
                resolvedModel: "kimi-code/kimi-k2",
                usage: { input: 70, output: 10, cacheWrite: 0, totalTokens: 80 },
              },
            ],
          },
        },
      },
    ]);

    expect(summary.totalTokens).toBe(710);
    expect(summary.subagentTokens).toBe(330);
    expect(summary.models).toEqual([
      { model: "zhipu-coding-plan/glm-5.2", tokens: 410, subagentTokens: 250 },
      { model: "kimi-code/kimi-k2", tokens: 300, subagentTokens: 80 },
    ]);
    expect(formatSessionUsageLines(summary)).toEqual([
      "会话总计  ·  710 Token  ·  Sub-agent 330",
    ]);
  });

  test("counts only today's DeepSeek and MiniMax assistant calls including cache reads", () => {
    const start = Date.UTC(2026, 6, 13, 0, 0, 0);
    const end = Date.UTC(2026, 6, 14, 0, 0, 0);
    const deepseek = {
      type: "message",
      id: "deepseek-today",
      timestamp: new Date(start + 1000).toISOString(),
      message: {
        role: "assistant",
        provider: "deepseek",
        model: "deepseek-v4-pro",
        usage: { input: 100, output: 50, cacheRead: 1000, cacheWrite: 20, totalTokens: 1170 },
      },
    };
    expect(
      summarizeDailyProviderUsage([
        deepseek,
        deepseek,
        {
          type: "message",
          id: "minimax-today",
          timestamp: new Date(end - 1000).toISOString(),
          message: {
            role: "assistant",
            provider: "minimax-code-cn",
            model: "MiniMax-M3",
            usage: { input: 200, output: 20, cacheRead: 2000, cacheWrite: 0, totalTokens: 2220 },
          },
        },
        {
          type: "message",
          id: "deepseek-yesterday",
          timestamp: new Date(start - 1).toISOString(),
          message: {
            role: "assistant",
            provider: "deepseek",
            model: "deepseek-v4-pro",
            usage: { totalTokens: 99999 },
          },
        },
        {
          type: "message",
          id: "task-aggregate",
          timestamp: new Date(start + 2000).toISOString(),
          message: {
            role: "toolResult",
            toolName: "task",
            details: {
              usage: { totalTokens: 99999 },
              results: [
                {
                  resolvedModel: "deepseek/deepseek-v4-pro",
                  usage: { input: 300, output: 30, cacheRead: 500, cacheWrite: 0, totalTokens: 830 },
                },
              ],
            },
          },
        },
      ], start, end),
    ).toEqual({ deepseek: 1170, minimax: 2220 });
  });

  test("deduplicates copied daily entries and formats zero-valued providers", () => {
    const items = [
      { key: "same", provider: "deepseek" as const, tokens: 120 },
      { key: "same", provider: "deepseek" as const, tokens: 130 },
      { key: "minimax", provider: "minimax" as const, tokens: 40 },
    ];
    const summary = aggregateDailyUsageItems(items);
    expect(summary).toEqual({ deepseek: 130, minimax: 40 });
    expect(formatDailyUsageLine(summary, "余额 ¥22.24")).toBe(
      "本机今日用量  ·  DeepSeek 130（余额 ¥22.24）  ·  MiniMax 40  ·  合计 170 Token",
    );
    expect(collectDailyUsageItems([], 0, 1)).toEqual([]);
  });
});

describe("extension lifecycle", () => {
  test("loads official and custom usage, then clears the widget on shutdown", async () => {
    temporaryAgentDir = await mkdtemp(join(tmpdir(), "ai-usage-widget-"));
    process.env.PI_CODING_AGENT_DIR = temporaryAgentDir;
    const sessionGroup = join(temporaryAgentDir, "sessions", "project");
    const nestedSession = join(sessionGroup, "closed-session");
    await mkdir(nestedSession, { recursive: true });
    const today = Date.now();
    const yesterday = today - 24 * 60 * 60 * 1000;
    await writeFile(
      join(sessionGroup, "closed-session.jsonl"),
      [
        {
          type: "message",
          id: "daily-deepseek",
          timestamp: new Date(today).toISOString(),
          message: {
            role: "assistant",
            provider: "deepseek",
            model: "deepseek-v4-pro",
            usage: { input: 100, output: 20, cacheRead: 1000, cacheWrite: 0, totalTokens: 1120 },
          },
        },
        {
          type: "message",
          id: "old-deepseek",
          timestamp: new Date(yesterday).toISOString(),
          message: {
            role: "assistant",
            provider: "deepseek",
            model: "deepseek-v4-pro",
            usage: { totalTokens: 99999 },
          },
        },
        {
          type: "message",
          id: "ignored-task",
          timestamp: new Date(today).toISOString(),
          message: {
            role: "toolResult",
            toolName: "task",
            details: {
              results: [{ resolvedModel: "minimax-code-cn/MiniMax-M3", usage: { totalTokens: 99999 } }],
            },
          },
        },
      ].map(value => JSON.stringify(value)).join("\n"),
    );
    await writeFile(
      join(nestedSession, "SubAgent.jsonl"),
      `${JSON.stringify({
        type: "message",
        id: "daily-minimax-subagent",
        timestamp: new Date(today).toISOString(),
        message: {
          role: "assistant",
          provider: "minimax-code-cn",
          model: "MiniMax-M3",
          usage: { input: 200, output: 30, cacheRead: 2000, cacheWrite: 0, totalTokens: 2230 },
        },
      })}\n`,
    );
    globalThis.fetch = async input => {
      const url = String(input);
      if (url.includes("deepseek")) {
        return Response.json({
          is_available: true,
          balance_infos: [
            { currency: "CNY", total_balance: "12.34", granted_balance: "2.34", topped_up_balance: "10.00" },
          ],
        });
      }
      if (url.includes("model-usage")) {
        return Response.json({
          success: true,
          data: { totalUsage: { totalTokensUsage: 123456789, totalModelCallCount: 1234 } },
        });
      }
      if (url.includes("token_plan/remains")) {
        return Response.json({
          model_remains: [
            {
              model_name: "general",
              current_interval_remaining_percent: 80,
              current_interval_status: 1,
              end_time: Date.now() + 3.5 * 60 * 60 * 1000,
              remains_time: 3.5 * 60 * 60 * 1000,
              current_weekly_remaining_percent: 90,
              current_weekly_status: 1,
              weekly_end_time: Date.now() + (6 * 24 + 7) * 60 * 60 * 1000,
              weekly_remains_time: (6 * 24 + 7) * 60 * 60 * 1000,
            },
          ],
        });
      }
      if (url.includes("api.kimi.com")) {
        return Response.json({
          limits: [
            {
              detail: { limit: "100", remaining: "75", resetTime: new Date(Date.now() + 4 * 60 * 60_000).toISOString() },
              window: { duration: 300, timeUnit: "TIME_UNIT_MINUTE" },
            },
          ],
          usage: {
            limit: "100",
            remaining: "50",
            resetTime: new Date(Date.now() + 6 * 24 * 60 * 60_000).toISOString(),
          },
        });
      }
      return Response.json({
        success: true,
        data: { level: "max", limits: [{ type: "TOKENS_LIMIT", unit: 3, number: 5, percentage: 12 }] },
      });
    };

    const handlers = new Map<string, Array<(event: unknown, ctx: any) => unknown>>();
    const warnings: unknown[] = [];
    const pi = {
      setLabel() {},
      logger: { warn: (...args: unknown[]) => warnings.push(args) },
      on(name: string, handler: (event: unknown, ctx: any) => unknown) {
        const current = handlers.get(name) ?? [];
        current.push(handler);
        handlers.set(name, current);
      },
    };
    const widgetCalls: unknown[][] = [];
    const branch: unknown[] = [
      {
        type: "message",
        message: {
          role: "assistant",
          provider: "zhipu-coding-plan",
          model: "glm-5.2",
          usage: { input: 1000, output: 200, cacheWrite: 0, totalTokens: 1200 },
        },
      },
      {
        type: "message",
        message: {
          role: "toolResult",
          toolName: "task",
          details: {
            usage: { input: 450, output: 50, cacheWrite: 0, totalTokens: 500 },
            results: [
              {
                resolvedModel: "kimi-code/kimi-k2:medium",
                usage: { input: 450, output: 50, cacheWrite: 0, totalTokens: 500 },
              },
            ],
          },
        },
      },
    ];
    const ctx = {
      hasUI: true,
      ui: { setWidget: (...args: unknown[]) => widgetCalls.push(args) },
      sessionManager: { getSessionId: () => "test-session", getBranch: () => branch, getEntries: () => branch },
      modelRegistry: {
        getProviderBaseUrl: () => undefined,
        getApiKeyForProvider: async () => "test-key",
        authStorage: {
          fetchUsageReports: async () => [
            {
              provider: "kimi-code",
              limits: [{ label: "5h limit", amount: { usedFraction: 0.25, unit: "unknown" } }],
            },
          ],
        },
      },
    };

    aiUsageWidget(pi as any);
    await handlers.get("session_start")![0]!({}, ctx);
    await Bun.sleep(20);

    const plainTheme = { fg: (_color: string, text: string) => text, bold: (text: string) => text };
    const renderCall = (call: unknown[]): string[] => {
      const factory = call[1] as (tui: unknown, theme: unknown) => { render(width: number): readonly string[] };
      return [...factory(undefined, plainTheme).render(80)];
    };
    expect(stripAnsi(renderCall(widgetCalls[0])[0]!)).toBe("◆ AI 用量  ·  正在加载…");
    expect(widgetCalls[0]?.[2]).toEqual({ placement: "belowEditor" });
    const rendered = renderCall(widgetCalls.at(-1)!);
    expect(stripAnsi(rendered[0]!)).toContain("AI 用量");
    expect(rendered.some(line => line.includes("会话总计") && line.includes("1.7k Token"))).toBeTrue();
    expect(rendered.some(line => line.includes("glm-5.2") || line.includes("kimi-k2"))).toBeFalse();
    expect(rendered.some(line => line.startsWith("DeepSeek"))).toBeFalse();
    expect(rendered.some(line => line.includes("5h"))).toBeTrue();
    expect(rendered.some(line => line.includes("近7天 123,456,789 Token / 1,234 次调用"))).toBeTrue();
    expect(rendered.some(line => line.includes("Kimi      5h"))).toBeTrue();
    expect(rendered.some(line => line.includes("Kimi") && line.includes("重置时间未知"))).toBeFalse();
    expect(
      rendered.some(line => line.includes("MiniMax   5h") && line.includes("20%") && line.includes("7d") && line.includes("10%")),
    ).toBeTrue();
    expect(
      rendered.some(
        line =>
          line.includes("本机今日用量") &&
          line.includes("DeepSeek 1,120") &&
          line.includes("余额 ¥12.34") &&
          line.includes("MiniMax 2,230") &&
          line.includes("合计 3,350 Token"),
      ),
    ).toBeTrue();
    expect(warnings).toHaveLength(0);

    branch.push({
      type: "message",
      message: {
        role: "assistant",
        provider: "zhipu-coding-plan",
        model: "glm-5.2",
        usage: { input: 100, output: 100, cacheWrite: 0, totalTokens: 200 },
      },
    });
    await handlers.get("agent_end")![0]!({}, ctx);
    const rerendered = renderCall(widgetCalls.at(-1)!);
    expect(rerendered.some(line => line.includes("会话总计") && line.includes("1.9k Token"))).toBeTrue();

    await handlers.get("session_shutdown")![0]!({}, ctx);
    expect(widgetCalls.at(-1)).toEqual(["ai-usage", undefined]);
  });
});

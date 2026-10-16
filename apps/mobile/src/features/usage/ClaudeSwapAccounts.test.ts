import {
  DEFAULT_SERVER_SETTINGS,
  EnvironmentId,
  ProviderDriverKind,
  ProviderInstanceId,
  UsageLimitSourceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { expect, it, vi } from "vite-plus/test";

vi.mock("@effect/atom-react", () => ({ useAtomValue: () => null }));
vi.mock("expo-haptics", () => ({}));
vi.mock("react-native", () => ({ Alert: {}, Pressable: "button", View: "div" }));
vi.mock("../../components/ui/AppText", () => ({ AppText: "span" }));
vi.mock("../../components/ProviderIcon", () => ({ ProviderIcon: () => null }));
vi.mock("../../components/StatusPill", () => ({ StatusPill: () => null }));
vi.mock("../../state/server", () => ({ serverEnvironment: {} }));
vi.mock("../../state/use-atom-command", () => ({ useAtomCommand: () => null }));
vi.mock("./UsageLimitsSection", () => ({ AccountLimits: () => null }));

import { collectAntigravityFallbacks } from "./ClaudeSwapAccounts";

const now = Date.parse("2026-09-03T11:00:00.000Z");
const antigravity: ServerProvider = {
  instanceId: ProviderInstanceId.make("antigravity"),
  driver: ProviderDriverKind.make("antigravity"),
  enabled: true,
  installed: true,
  version: null,
  status: "ready",
  auth: { status: "authenticated" },
  checkedAt: "2026-09-03T11:00:00.000Z",
  models: [{ slug: "claude-opus", name: "Claude Opus 4.6", isCustom: false, capabilities: null }],
  slashCommands: [],
  skills: [],
};
const claudeSwap = {
  id: UsageLimitSourceId.make("claude-swap"),
  kind: "claudeSwap" as const,
  label: "claude-swap",
  checkedAt: "2026-09-03T11:00:00.000Z",
  accounts: [],
};
const collect = (settings: Partial<typeof DEFAULT_SERVER_SETTINGS>, sources = [claudeSwap]) =>
  collectAntigravityFallbacks(
    new Map([
      [
        EnvironmentId.make("mobile-fallback"),
        {
          entry: { target: { label: "Mac" } },
          serverConfig: {
            providers: [antigravity],
            usageLimitSources: sources,
            settings: { ...DEFAULT_SERVER_SETTINGS, ...settings },
          },
        },
      ],
    ]),
    now,
  );

const allOn = {
  claudeSwapUsageEnabled: true,
  claudeSwapAutoSwitchEnabled: true,
  claudeSwapAntigravityFallbackEnabled: true,
  claudeSwapAutoSwitchAtPercent: 80,
};

it("reports the fallback on only while claude-swap usage, auto-switch and the fallback are on", () => {
  expect(collect(allOn).map((entry) => [entry.enabled, entry.atPercent])).toEqual([[true, 80]]);
  expect(collect({ ...allOn, claudeSwapAutoSwitchEnabled: false })[0]?.enabled).toBe(false);
  expect(collect({ ...allOn, claudeSwapUsageEnabled: false })[0]?.enabled).toBe(false);
  expect(collect({})[0]?.enabled).toBe(false);
});

it("shows Antigravity's Claude only on environments that run claude-swap", () => {
  expect(collect(allOn, [])).toEqual([]);
});

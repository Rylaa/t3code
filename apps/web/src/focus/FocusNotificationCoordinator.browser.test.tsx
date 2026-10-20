import type { ClientSettings } from "@t3tools/contracts/settings";
import * as DateTime from "effect/DateTime";
import * as Option from "effect/Option";
import { act } from "react";
import { createRoot, type Root } from "react-dom/client";
import { afterEach, beforeEach, describe, expect, it, vi } from "vite-plus/test";

const state = vi.hoisted(() => ({
  projectFocused: true,
  active: { environmentId: "env-1", threadId: "other-thread" },
  focused: true,
  input: false,
  completedAt: null as string | null,
  add: vi.fn((_toast: Record<string, unknown>) => "toast-1"),
  close: vi.fn(),
  navigate: vi.fn(),
  sound: vi.fn(),
  attention: vi.fn(),
  notification: vi.fn(function (_title: string, options: NotificationOptions) {
    return Object.assign(new EventTarget(), { tag: options.tag, close: vi.fn() });
  }),
}));

const SHELL_NOW = DateTime.makeUnsafe("2026-09-13T09:00:00.000Z");

function mockThreadShell() {
  return {
    id: "thread-1",
    projectId: "project-1",
    title: "Fix the login form",
    providerInstanceId: "codex",
    modelSelection: { instanceId: "codex", model: "gpt-5.4" },
    runtimeMode: "full-access",
    interactionMode: "default",
    branch: null,
    worktreePath: null,
    activeProviderThreadId: null,
    lineage: { rootThreadId: "thread-1", parentThreadId: null, relationshipToParent: null },
    forkedFrom: null,
    createdBy: "user",
    creationSource: "web",
    latestRunId: "run-1",
    activeRunId: null,
    status: state.completedAt ? "completed" : "running",
    lastErrorClass: null,
    pendingRuntimeRequest: state.input
      ? { id: "request-1", kind: "user_input", createdAt: SHELL_NOW }
      : null,
    latestVisibleMessage: null,
    latestUserMessageAt: null,
    hasActionableProposedPlan: false,
    pendingBackgroundTasks: [],
    itemCount: 0,
    visibleItemCount: 0,
    createdAt: SHELL_NOW,
    updatedAt: SHELL_NOW,
    latestRunRequestedAt: SHELL_NOW,
    latestRunStartedAt: SHELL_NOW,
    latestRunCompletedAt: state.completedAt ? DateTime.makeUnsafe(state.completedAt) : undefined,
    archivedAt: null,
    settledOverride: null,
    settledAt: null,
    lastVisitedAt: null,
    deletedAt: null,
  };
}

vi.mock(import("@effect/atom-react"), async (original) => ({
  ...(await original()),
  useAtomValue: (() => ({
    status: "live",
    snapshot: Option.some({ threads: [mockThreadShell()] }),
  })) as never,
}));
vi.mock(import("@tanstack/react-router"), async (original) => ({
  ...(await original()),
  useNavigate: (() => state.navigate) as never,
  useParams: (() => state.active) as never,
}));
vi.mock(import("../hooks/useSettings"), async (original) => ({
  ...(await original()),
  useClientSettings: ((select: (settings: Pick<ClientSettings, "notificationMode">) => unknown) =>
    select({ notificationMode: "notifications-and-sound" })) as never,
  getClientSettings: (() => ({ notificationMode: "notifications-and-sound" })) as never,
}));
vi.mock(import("../state/entities"), async (original) => ({
  ...(await original()),
  useProjects: (() => [
    {
      environmentId: "env-1",
      id: "project-1",
      focus: state.projectFocused ? { until: "2026-09-14T18:00:00.000Z", note: null } : null,
    },
  ]) as never,
}));
vi.mock(import("../state/environments"), async (original) => ({
  ...(await original()),
  useEnvironmentIds: (() => ["env-1"]) as never,
}));
vi.mock(import("../threadNotifications"), async (original) => ({
  ...(await original()),
  playNotificationSound: state.sound,
}));
vi.mock(import("../components/ui/toast"), async (original) => {
  const actual = await original();
  return {
    ...actual,
    toastManager: { ...actual.toastManager, add: state.add as never, close: state.close },
  };
});

import { FocusNotificationCoordinator } from "./FocusNotificationCoordinator";

let root: Root;

async function render() {
  await act(() => root.render(<FocusNotificationCoordinator />));
}

async function askForInput() {
  await render();
  state.input = true;
  await render();
}

beforeEach(() => {
  vi.clearAllMocks();
  Object.assign(state, {
    projectFocused: true,
    active: { environmentId: "env-1", threadId: "other-thread" },
    focused: true,
    input: false,
    completedAt: null,
  });
  vi.stubGlobal("IS_REACT_ACT_ENVIRONMENT", true);
  vi.spyOn(document, "visibilityState", "get").mockImplementation(() => "visible");
  vi.spyOn(document, "hasFocus").mockImplementation(() => state.focused);
  vi.stubGlobal("Notification", Object.assign(state.notification, { permission: "granted" }));
  vi.stubGlobal("desktopBridge", {
    requestAttention: state.attention.mockResolvedValue(undefined),
  });
  root = createRoot(document.createElement("div"));
});

afterEach(async () => {
  await act(() => root.unmount());
  vi.restoreAllMocks();
  vi.unstubAllGlobals();
});

describe("focus notifications", () => {
  it("keeps a focused thread's question on screen until it is answered", async () => {
    await askForInput();
    expect(state.add).toHaveBeenCalledTimes(1);
    expect(state.add).toHaveBeenLastCalledWith(
      expect.objectContaining({ title: "Input needed", timeout: 0 }),
    );
    expect(state.sound).toHaveBeenCalledTimes(1);
    expect(state.close).not.toHaveBeenCalled();
    state.input = false;
    await render();
    expect(state.close).toHaveBeenCalledWith("toast-1");
  });

  it("closes the alert once the thread is opened", async () => {
    await askForInput();
    state.active = { environmentId: "env-1", threadId: "thread-1" };
    await render();
    expect(state.close).toHaveBeenCalledWith("toast-1");
  });

  it("queues the alert and asks for attention while the window is away", async () => {
    state.focused = false;
    await askForInput();
    expect(state.add).toHaveBeenCalledWith(expect.objectContaining({ timeout: 0 }));
    expect(state.attention).toHaveBeenCalledTimes(1);
    expect(state.notification).toHaveBeenCalledWith(
      "Input needed",
      expect.objectContaining({ requireInteraction: true }),
    );
  });

  it("stays quiet for unfocused projects", async () => {
    state.projectFocused = false;
    await askForInput();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.sound).not.toHaveBeenCalled();
    expect(state.notification).not.toHaveBeenCalled();
  });

  it("stays quiet when a focused thread completes", async () => {
    await render();
    state.completedAt = "2026-09-13T10:00:00.000Z";
    await render();
    expect(state.add).not.toHaveBeenCalled();
    expect(state.sound).not.toHaveBeenCalled();
  });
});

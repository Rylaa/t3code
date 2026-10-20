import {
  type PendingSubagentRequest,
  presentThreadShell,
} from "@t3tools/client-runtime/state/models";
import { pendingSubagentRequestsByThread } from "@t3tools/client-runtime/state/threads";
import { useAtomValue } from "@effect/atom-react";
import { useNavigate, useParams } from "@tanstack/react-router";
import type { EnvironmentId, OrchestrationV2ThreadShell, ThreadId } from "@t3tools/contracts";
import * as Option from "effect/Option";
import { CircleAlertIcon, MessageCircleQuestionIcon, ShieldQuestionIcon } from "lucide-react";
import { useEffect, useRef } from "react";

import { resolveSidebarThreadStatus } from "../components/Sidebar.logic";
import { ThreadNotificationCoordinator } from "../components/ThreadNotificationCoordinator";
import { toastManager } from "../components/ui/toast";
import { getClientSettings, useClientSettings } from "../hooks/useSettings";
import { useProjects } from "../state/entities";
import { useEnvironmentIds } from "../state/environments";
import { environmentShell } from "../state/shell";
import { hasNotificationSound, playNotificationSound } from "../threadNotifications";
import { focusProjectKey } from "./focus.logic";
import { useFocusModeEnabled } from "./focusModeStore";

/** Normal notifications, or focus-mode alerts while focus mode is on. */
export function NotificationCoordinator() {
  return useFocusModeEnabled() ? (
    <FocusNotificationCoordinator />
  ) : (
    <ThreadNotificationCoordinator />
  );
}

/**
 * Only focused projects reach the user, and only when they need an answer:
 * their alert stays until the thread is opened or answered; everything else,
 * completions included, stays quiet.
 */
export function FocusNotificationCoordinator() {
  return useEnvironmentIds().map((environmentId) => (
    <EnvironmentFocusNotifications key={environmentId} environmentId={environmentId} />
  ));
}

interface SeenThread {
  readonly raw: OrchestrationV2ThreadShell;
  readonly subagentRequest: PendingSubagentRequest | null;
  readonly attention: string | null;
}

function EnvironmentFocusNotifications({ environmentId }: { environmentId: EnvironmentId }) {
  const shell = useAtomValue(environmentShell.stateValueAtom(environmentId));
  const threads =
    shell.status === "live" && Option.isSome(shell.snapshot) ? shell.snapshot.value.threads : null;
  const mode = useClientSettings((settings) => settings.notificationMode);
  const projects = useProjects();
  const focusedProjectKeys = new Set(
    projects
      .filter((project) => project.environmentId === environmentId && project.focus != null)
      .map((project) => focusProjectKey(project.environmentId, project.id)),
  );
  const navigate = useNavigate();
  const { environmentId: activeEnvironmentId, threadId: activeThreadId } = useParams({
    strict: false,
  });
  // Attention seen per thread, so only a new request alerts. Shells that did
  // not change keep their entry, so streaming events skip the status work.
  const previous = useRef<Map<ThreadId, SeenThread> | null>(null);
  const alerts = useRef(new Map<ThreadId, { toastId: string; attention: string }>());

  useEffect(() => {
    if (activeEnvironmentId !== environmentId || !activeThreadId) return;
    const open = alerts.current.get(activeThreadId as ThreadId);
    if (!open) return;
    toastManager.close(open.toastId);
    alerts.current.delete(activeThreadId as ThreadId);
  }, [activeEnvironmentId, activeThreadId, environmentId]);

  useEffect(() => {
    const open = alerts.current;
    return () => {
      for (const { toastId } of open.values()) toastManager.close(toastId);
      open.clear();
    };
  }, []);

  useEffect(() => {
    if (threads === null) return;
    const viewing = (threadId: ThreadId) =>
      activeEnvironmentId === environmentId && activeThreadId === threadId;
    const windowFocused = document.visibilityState === "visible" && document.hasFocus();
    const next = new Map<ThreadId, SeenThread>();
    const subagentRequests = pendingSubagentRequestsByThread(threads);
    for (const rawThread of threads) {
      if (rawThread.lineage.relationshipToParent === "subagent") continue;
      const subagentRequest = subagentRequests.get(rawThread.id) ?? null;
      const prior = previous.current?.get(rawThread.id);
      if (prior?.raw === rawThread && prior.subagentRequest === subagentRequest) {
        next.set(rawThread.id, prior);
        continue;
      }
      const thread = presentThreadShell(environmentId, rawThread, subagentRequest);
      let status = resolveSidebarThreadStatus(thread);
      if (status === "ready" && thread.latestRun?.status === "failed") status = "failed";
      const attention =
        status === "input" || status === "approval" || status === "failed" || status === "limited"
          ? `${thread.latestRun?.runId ?? ""}:${status}`
          : null;
      next.set(thread.id, { raw: rawThread, subagentRequest, attention });

      const open = alerts.current.get(thread.id);
      if (open && open.attention !== attention) {
        toastManager.close(open.toastId);
        alerts.current.delete(thread.id);
      }
      // The first snapshot only records state; requests that were already
      // waiting are visible in the Focus section.
      if (previous.current === null) continue;
      if (attention === null || attention === (prior?.attention ?? null)) continue;
      if (thread.archivedAt !== null) continue;
      if (!focusedProjectKeys.has(focusProjectKey(environmentId, thread.projectId))) continue;

      const title =
        status === "approval"
          ? "Approval needed"
          : status === "limited"
            ? "Usage limit reached"
            : status === "failed"
              ? "Thread failed"
              : "Input needed";
      const openThread = () =>
        void navigate({
          to: "/$environmentId/$threadId",
          params: { environmentId, threadId: thread.id },
        });
      if (hasNotificationSound(mode)) {
        void playNotificationSound("input", () =>
          hasNotificationSound(getClientSettings().notificationMode),
        );
      }
      if (!viewing(thread.id)) {
        const toastId = toastManager.add({
          timeout: 0,
          type: status === "failed" ? "error" : "warning",
          title,
          description: thread.title,
          data: {
            hideCopyButton: true,
            leadingIcon:
              status === "approval" ? (
                <ShieldQuestionIcon aria-hidden className="size-4 text-warning-foreground" />
              ) : status === "failed" ? (
                <CircleAlertIcon aria-hidden className="size-4 text-destructive-foreground" />
              ) : (
                <MessageCircleQuestionIcon aria-hidden className="size-4 text-info-foreground" />
              ),
          },
          actionProps: {
            children: "Open thread",
            onClick: () => {
              toastManager.close(toastId);
              alerts.current.delete(thread.id);
              openThread();
            },
          },
        });
        alerts.current.set(thread.id, { toastId, attention });
      }
      if (windowFocused) continue;
      void window.desktopBridge?.requestAttention?.().catch(() => {});
      if (typeof Notification === "undefined" || Notification.permission !== "granted") continue;
      try {
        const notification = new Notification(title, {
          body: thread.title,
          tag: `${environmentId}:${thread.id}`,
          silent: true,
          requireInteraction: true,
        });
        notification.addEventListener("click", () => {
          notification.close();
          window.focus();
          openThread();
        });
      } catch {
        // Some browsers expose Notification but reject desktop presentation.
      }
    }
    previous.current = next;
  }, [
    activeEnvironmentId,
    activeThreadId,
    environmentId,
    focusedProjectKeys,
    mode,
    navigate,
    threads,
  ]);

  return null;
}

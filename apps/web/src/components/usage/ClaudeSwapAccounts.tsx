import { AuthProvidersManageScope, ProviderDriverKind } from "@t3tools/contracts";
import {
  CLAUDE_SWAP_SWITCH_EFFECT,
  claudeSwapAutoSwitchLine,
  formatDuration,
  limitsNotice,
} from "@t3tools/shared/usageLimits";
import { Link } from "@tanstack/react-router";
import { AlertTriangleIcon } from "lucide-react";
import { useState } from "react";

import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { Alert, AlertDescription, AlertTitle } from "../ui/alert";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ANTIGRAVITY_FALLBACK_LABEL,
  type AntigravityFallbackView,
  antigravityFallbackDetails,
  type ClaudeSwapAccountView,
  type ClaudeSwapSourceView,
  type ClaudeSwapSwitchRequest,
  claudeSwapSwitchOutcome,
  loginExpiryNotice,
  sameSwitchRequest,
  staleAge,
} from "./claudeSwap.logic";
import { LimitWindows } from "./UsageLimits";

const CLAUDE_DRIVER = ProviderDriverKind.make("claudeAgent");

/**
 * One switch at a time for the whole Limits view: the confirm, the request in
 * flight, and the outcome line. The pooled popovers and the account list share
 * it, so the confirm mounts once, outside every popover.
 */
export function useClaudeSwapSwitch(sources: readonly ClaudeSwapSourceView[]) {
  const run = useAtomCommand(serverEnvironment.switchUsageLimitSourceAccount, {
    reportFailure: false,
  });
  const [request, setRequest] = useState<ClaudeSwapSwitchRequest | null>(null);
  const [confirming, setConfirming] = useState(false);
  const [busy, setBusy] = useState(false);
  const [status, setStatus] = useState<string | null>(null);

  const ask = (next: ClaudeSwapSwitchRequest) => {
    if (!readEnvironmentScope(next.environmentId, AuthProvidersManageScope)) return;
    setRequest(next);
    setConfirming(true);
  };

  const confirm = async () => {
    setConfirming(false);
    if (request === null || !readEnvironmentScope(request.environmentId, AuthProvidersManageScope))
      return;
    setBusy(true);
    setStatus(null);
    const result = await run({ environmentId: request.environmentId, input: request.input });
    setBusy(false);
    if (result._tag === "Success") {
      const accounts =
        sources.find(
          (view) =>
            view.environmentId === request.environmentId &&
            view.source.id === request.input.sourceId,
        )?.accounts ?? [];
      setStatus(claudeSwapSwitchOutcome(result.value, request, accounts));
      return;
    }
    setStatus(
      "error" in result.cause && result.cause.error instanceof Error
        ? result.cause.error.message
        : "Could not switch the Claude account.",
    );
  };

  return { request, confirming, setConfirming, busy, status, ask, confirm };
}

export type ClaudeSwapSwitcher = ReturnType<typeof useClaudeSwapSwitch>;

/** The account list row for a pooled account's switch target, if it has one. */
export function findClaudeSwapAccount(
  sources: readonly ClaudeSwapSourceView[],
  environmentId: ClaudeSwapSwitchRequest["environmentId"],
  sourceId: string,
  accountId: string,
): ClaudeSwapAccountView | undefined {
  return sources
    .find((view) => view.environmentId === environmentId && view.source.id === sourceId)
    ?.accounts.find((view) => view.account.id === accountId);
}

/**
 * Switching changes the machine's Claude login under every session that uses
 * it, so it never fires on a bare click.
 */
export function ClaudeSwapSwitchDialog({ switcher }: { readonly switcher: ClaudeSwapSwitcher }) {
  const request = switcher.request;
  const target = request?.name ?? "the account with the most headroom";
  return (
    <AlertDialog open={switcher.confirming} onOpenChange={switcher.setConfirming}>
      <AlertDialogPopup>
        <AlertDialogHeader>
          <AlertDialogTitle>
            {request?.name
              ? `Switch Claude to ${request.name}?`
              : "Switch Claude to the best account?"}
          </AlertDialogTitle>
          <AlertDialogDescription>
            claude-swap makes {target} the Claude login on{" "}
            {request?.environmentLabel ?? "this machine"}. {CLAUDE_SWAP_SWITCH_EFFECT}
          </AlertDialogDescription>
        </AlertDialogHeader>
        <AlertDialogFooter>
          <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
          <Button disabled={switcher.busy} onClick={() => void switcher.confirm()}>
            Switch account
          </Button>
        </AlertDialogFooter>
      </AlertDialogPopup>
    </AlertDialog>
  );
}

/** Opens the confirm for one switch; disabled without providers:manage or while one runs. */
export function ClaudeSwapSwitchButton({
  switcher,
  request,
  label,
  onBeforeConfirm,
}: {
  readonly switcher: ClaudeSwapSwitcher;
  readonly request: ClaudeSwapSwitchRequest;
  readonly label: string;
  /** Closes a popover holding the button, since the confirm stacks under popovers. */
  readonly onBeforeConfirm?: () => void;
}) {
  const canManageProviders = useEnvironmentScope(request.environmentId, AuthProvidersManageScope);
  return (
    <Button
      size="xs"
      variant="outline"
      disabled={switcher.busy || !canManageProviders}
      onClick={() => {
        onBeforeConfirm?.();
        switcher.ask(request);
      }}
    >
      {switcher.busy && switcher.request && sameSwitchRequest(switcher.request, request)
        ? "Switching…"
        : label}
    </Button>
  );
}

function AccountRow({
  view,
  switcher,
  now,
}: {
  readonly view: ClaudeSwapAccountView;
  readonly switcher: ClaudeSwapSwitcher;
  readonly now: number;
}) {
  const { account } = view;
  const windows = account.usageLimits.windows;
  const age = staleAge(account, now);
  const notice = windows.length === 0 ? limitsNotice(account.usageLimits) : null;
  const expiry = loginExpiryNotice(account.loginExpiresAt, now);
  const limitReached = windows.some((window) => window.usedPercent >= 100);
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">{view.name}</span>
        {account.alias && account.email ? (
          <span className="min-w-0 truncate text-xs text-muted-foreground">{account.email}</span>
        ) : null}
        <Tooltip>
          <TooltipTrigger render={<span className="text-xs text-muted-foreground tabular-nums" />}>
            #{account.id}
          </TooltipTrigger>
          <TooltipPopup side="top">claude-swap slot {account.id}</TooltipPopup>
        </Tooltip>
        {account.plan ? (
          <Badge size="sm" variant="outline">
            {account.plan}
          </Badge>
        ) : null}
        {account.active ? (
          <Badge size="sm" variant="success">
            Active
          </Badge>
        ) : null}
        {limitReached ? (
          <Badge size="sm" variant="error">
            Limit reached
          </Badge>
        ) : null}
        {account.disabled ? (
          <Tooltip>
            <TooltipTrigger render={<Badge size="sm" variant="outline" />}>Disabled</TooltipTrigger>
            <TooltipPopup side="top">
              Left out when claude-swap picks the best account. You can still switch to it.
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {account.weeklyPace?.aheadOfPace ? (
          <Tooltip>
            <TooltipTrigger render={<Badge size="sm" variant="warning" />}>
              Ahead of weekly pace
            </TooltipTrigger>
            <TooltipPopup side="top">
              claude-swap expected {Math.round(account.weeklyPace.expectedPercent)}% of the week
              used by now.
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {age ? (
          <Tooltip>
            <TooltipTrigger render={<Badge size="sm" variant="warning" />}>
              Stale · {age}
            </TooltipTrigger>
            <TooltipPopup side="top">
              claude-swap could not read this account just now. The bars are its last good reading.
            </TooltipPopup>
          </Tooltip>
        ) : null}
        {view.switchTo ? (
          <span className="ms-auto">
            <ClaudeSwapSwitchButton switcher={switcher} request={view.switchTo} label="Switch" />
          </span>
        ) : null}
      </div>
      {windows.length > 0 ? (
        <LimitWindows driver={account.driver} windows={windows} now={now} />
      ) : null}
      {notice ? <p className="text-xs text-muted-foreground">{notice}</p> : null}
      {expiry ? <p className="text-xs text-warning-foreground">{expiry}</p> : null}
    </li>
  );
}

/** Whether the server moves limited Claude threads to Antigravity right now. */
export function AntigravityFallbackBadge({ view }: { readonly view: AntigravityFallbackView }) {
  return (
    <Tooltip>
      <TooltipTrigger render={<Badge size="sm" variant={view.on ? "info" : "outline"} />}>
        {view.on ? "Fallback on" : "Fallback off"}
      </TooltipTrigger>
      <TooltipPopup side="top">
        {view.on
          ? "When every Claude account is full, limited threads continue here and return to Claude once an account has room."
          : "Turn it on under claude-swap in Settings → Providers."}
      </TooltipPopup>
    </Tooltip>
  );
}

/** The Antigravity Claude quota as an account list row; no switch, claude-swap does not hold it. */
function AntigravityFallbackListRow({
  view,
  now,
}: {
  readonly view: AntigravityFallbackView;
  readonly now: number;
}) {
  const windows = view.fallback.windows.filter(
    (window) => window.kind === "session" || window.kind === "weekly",
  );
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="min-w-0 truncate text-sm font-medium text-foreground">
          {ANTIGRAVITY_FALLBACK_LABEL}
        </span>
        <span className="min-w-0 truncate text-xs text-muted-foreground">
          {antigravityFallbackDetails(view).join(" · ")}
        </span>
        <AntigravityFallbackBadge view={view} />
      </div>
      {windows.length > 0 ? (
        <LimitWindows driver={view.fallback.provider.driver} windows={windows} now={now} />
      ) : null}
    </li>
  );
}

/**
 * What a claude-swap source says about itself: the machine it runs on when
 * several do, its last automatic switch, and why it could not be read.
 */
export function ClaudeSwapSourceStatus({
  view,
  now,
  showEnvironment,
}: {
  readonly view: ClaudeSwapSourceView;
  readonly now: number;
  readonly showEnvironment: boolean;
}) {
  const { source } = view;
  const autoSwitchLine = claudeSwapAutoSwitchLine(source);
  if (!showEnvironment && !(autoSwitchLine && source.autoSwitch) && !source.error) return null;
  return (
    <div className="flex flex-col gap-2">
      {showEnvironment || (autoSwitchLine && source.autoSwitch) ? (
        <p className="text-xs text-muted-foreground">
          {showEnvironment ? (
            <span className="font-medium text-foreground">{view.environmentLabel}</span>
          ) : null}
          {showEnvironment && autoSwitchLine ? " · " : null}
          {autoSwitchLine && source.autoSwitch
            ? `${autoSwitchLine} (${formatDuration(now - Date.parse(source.autoSwitch.at))} ago)`
            : null}
        </p>
      ) : null}
      {source.error ? (
        <Alert variant="warning" controlAlignment="first-line">
          <AlertTriangleIcon />
          <AlertTitle className="break-words">{source.error}</AlertTitle>
          <AlertDescription>
            <span>
              Check the claude-swap path in{" "}
              <Link to="/settings/providers" className="underline underline-offset-2">
                Settings → Providers
              </Link>
              .
            </span>
          </AlertDescription>
        </Alert>
      ) : null}
    </div>
  );
}

function SourceCard({
  view,
  switcher,
  now,
  showEnvironment,
}: {
  readonly view: ClaudeSwapSourceView;
  readonly switcher: ClaudeSwapSwitcher;
  readonly now: number;
  readonly showEnvironment: boolean;
}) {
  const { source } = view;
  return (
    <div className="flex flex-col gap-3">
      <div className="flex flex-wrap items-start gap-3">
        <div className="min-w-0 flex-1">
          <ClaudeSwapSourceStatus view={view} now={now} showEnvironment={showEnvironment} />
        </div>
        {view.switchBest ? (
          <ClaudeSwapSwitchButton
            switcher={switcher}
            request={view.switchBest}
            label="Switch to best"
          />
        ) : null}
      </div>
      {view.accounts.length === 0 && !source.error ? (
        <p className="text-xs text-muted-foreground">
          claude-swap has no saved accounts. Add one with cswap in a terminal.
        </p>
      ) : null}
      {view.accounts.length > 0 || view.antigravity ? (
        <ul className="divide-y divide-border/60 rounded-lg border border-border/60">
          {view.accounts.map((account) => (
            <AccountRow key={account.account.id} view={account} switcher={switcher} now={now} />
          ))}
          {view.antigravity ? (
            <AntigravityFallbackListRow view={view.antigravity} now={now} />
          ) : null}
        </ul>
      ) : null}
    </div>
  );
}

/**
 * Every account claude-swap holds on the selected environments, including the
 * ones the pooled bars leave out (expired logins, API keys), with the switch
 * actions. Rendered only when some environment publishes a claude-swap source.
 */
export function ClaudeSwapAccountsSection({
  sources,
  switcher,
  now,
}: {
  readonly sources: readonly ClaudeSwapSourceView[];
  readonly switcher: ClaudeSwapSwitcher;
  readonly now: number;
}) {
  if (sources.length === 0) return null;
  const showEnvironment = new Set(sources.map((view) => view.environmentId)).size > 1;
  return (
    <section className="flex flex-col gap-3">
      <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
        <ProviderInstanceIcon
          driverKind={CLAUDE_DRIVER}
          displayName="Claude"
          indicatorBackground="var(--background)"
          className="size-5"
          iconClassName="size-4 text-foreground/80"
        />
        Claude accounts
      </h2>
      {switcher.status ? (
        <p role="status" className="text-xs text-foreground">
          {switcher.status}
        </p>
      ) : null}
      {sources.map((view) => (
        <SourceCard
          key={`${view.environmentId}:${view.source.id}`}
          view={view}
          switcher={switcher}
          now={now}
          showEnvironment={showEnvironment}
        />
      ))}
    </section>
  );
}

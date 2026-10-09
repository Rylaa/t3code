import { AuthProvidersManageScope, ProviderDriverKind } from "@t3tools/contracts";
import { CLAUDE_SWAP_SWITCH_EFFECT, limitsNotice } from "@t3tools/shared/usageLimits";
import { Link } from "@tanstack/react-router";
import { AlertTriangleIcon } from "lucide-react";
import { createContext, useState } from "react";

import { readEnvironmentScope, useEnvironmentScope } from "../../state/session";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { RedactedSensitiveText } from "../settings/RedactedSensitiveText";
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

/**
 * Lets a pooled segment's popover offer the switch without threading the
 * switcher through every pool component. Null outside the Limits view.
 */
export const ClaudeSwapSwitchContext = createContext<{
  readonly switcher: ClaudeSwapSwitcher;
  readonly sources: readonly ClaudeSwapSourceView[];
} | null>(null);

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
  return (
    <li className="flex flex-col gap-2 px-4 py-3">
      <div className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
        <span className="text-sm font-medium text-foreground">{view.name}</span>
        {account.email ? (
          <RedactedSensitiveText
            value={account.email}
            ariaLabel="Toggle account email visibility"
            revealTooltip="Click to reveal email"
            hideTooltip="Click to hide email"
          />
        ) : null}
        {account.active ? (
          <Badge size="sm" variant="success">
            Active
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
        {account.plan ? (
          <span className="text-xs text-muted-foreground">{account.plan}</span>
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
    <div className="flex flex-col rounded-lg border border-border/60">
      {showEnvironment || view.switchBest ? (
        <div className="flex flex-wrap items-center gap-3 border-b border-border/60 px-4 py-2.5">
          {showEnvironment ? (
            <span className="text-xs font-medium text-foreground">{view.environmentLabel}</span>
          ) : null}
          {view.switchBest ? (
            <span className="ms-auto">
              <ClaudeSwapSwitchButton
                switcher={switcher}
                request={view.switchBest}
                label="Switch to best"
              />
            </span>
          ) : null}
        </div>
      ) : null}
      {source.error ? (
        <div className="p-4">
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
        </div>
      ) : null}
      {view.accounts.length > 0 ? (
        <ul className="divide-y divide-border/60">
          {view.accounts.map((account) => (
            <AccountRow key={account.account.id} view={account} switcher={switcher} now={now} />
          ))}
        </ul>
      ) : source.error ? null : (
        <p className="px-4 py-3 text-xs text-muted-foreground">
          claude-swap has no saved accounts. Add one with cswap in a terminal.
        </p>
      )}
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

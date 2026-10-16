import type { ServerProviderUsageWindow } from "@t3tools/contracts";
import {
  CHATGPT_USAGE_URL,
  collectLimitAccounts,
  collectExternalUsageLinks,
  collectLimitNotices,
  collectLimitPools,
  cursorUsageWindowDetails,
  displayLimitWindows,
  elapsedShare,
  formatResetsIn,
  isStaleLimitAccount,
  type LimitAccount,
  type LimitPool,
  type LimitPoolWindow,
  limitsNotice,
  paceOf,
  readingAge,
  remainingPercent,
  withoutClaudeSwapSources,
} from "@t3tools/shared/usageLimits";
import { AlertTriangleIcon, ExternalLinkIcon, RotateCcwIcon, TicketIcon } from "lucide-react";
import { Fragment, type ReactNode } from "react";

import { ensureLocalApi } from "../../localApi";
import { usePrimarySettings } from "../../hooks/useSettings";
import { cn } from "../../lib/utils";
import { formatUpcomingTimestamp } from "../../timestampFormat";
import { ProviderInstanceIcon } from "../chat/ProviderInstanceIcon";
import { providerClients } from "../settings/providerDriverMeta";
import { Badge } from "../ui/badge";
import { Button } from "../ui/button";
import { OpenAI } from "../Icons";
import { Alert, AlertTitle } from "../ui/alert";
import { Tooltip, TooltipPopup, TooltipTrigger } from "../ui/tooltip";
import {
  ClaudeSwapAccountsSection,
  ClaudeSwapSourceStatus,
  ClaudeSwapSwitchButton,
  ClaudeSwapSwitchDialog,
  type ClaudeSwapSwitcher,
  findClaudeSwapAccount,
  useClaudeSwapSwitch,
} from "./ClaudeSwapAccounts";
import {
  type ClaudeSwapAccountView,
  type ClaudeSwapSourceView,
  collectClaudeSwapSources,
  loginExpiryNotice,
} from "./claudeSwap.logic";
import {
  PaceIcon,
  ResetCreditDialog,
  barColor,
  resetCreditsSummary,
  useResetCredit,
} from "./UsageLimits";

/** `resets in 2h 13m` → `2h 13m`, for cells too narrow for the sentence. */
function shortResetsIn(window: ServerProviderUsageWindow, now: number): string | null {
  return formatResetsIn(window, now)?.replace(/^resets in /, "") ?? null;
}

/**
 * A thin meter of quota left. The hairline marks time left in the window,
 * which is where the fill would sit if spending had been even.
 */
function Meter({
  remaining,
  timeLeft,
  color,
}: {
  readonly remaining: number;
  readonly timeLeft: number | null;
  readonly color: string;
}) {
  return (
    <div aria-hidden className="relative h-1.5 rounded-full bg-muted">
      {remaining > 0 ? (
        <div
          className="absolute inset-y-0 left-0 rounded-full"
          style={{ width: `${remaining}%`, backgroundColor: color }}
        />
      ) : null}
      {timeLeft !== null ? (
        <span
          className="absolute -inset-y-0.5 w-px -translate-x-1/2 bg-foreground/50"
          style={{ left: `${timeLeft}%` }}
        />
      ) : null}
    </div>
  );
}

/** One account's reading of one window: percent, countdown, meter; exact figures on hover. */
function WindowCell({
  window,
  color,
  now,
}: {
  readonly window: ServerProviderUsageWindow;
  readonly color: string;
  readonly now: number;
}) {
  const timestampFormat = usePrimarySettings((settings) => settings.timestampFormat);
  const remaining = remainingPercent(window);
  const elapsed = elapsedShare(window, now);
  const timeLeft = elapsed === null ? null : Math.round((1 - elapsed) * 100);
  const resetsIn = shortResetsIn(window, now);
  const pace = paceOf(window, now);
  const resetsAt = window.resetsAt
    ? formatUpcomingTimestamp(window.resetsAt, timestampFormat, now)
    : null;
  return (
    <Tooltip>
      <TooltipTrigger
        render={
          <div
            role="img"
            tabIndex={0}
            aria-label={`${window.label}: ${remaining}% left${resetsIn ? `, resets in ${resetsIn}` : ""}`}
            className="flex min-w-0 cursor-default flex-col gap-1.5 rounded-sm outline-none focus-visible:ring-2 focus-visible:ring-inset focus-visible:ring-ring"
          />
        }
      >
        <span className="flex items-baseline justify-between gap-2 text-xs tabular-nums">
          <span
            className={cn(
              "font-medium",
              remaining === 0 ? "text-destructive-foreground" : "text-foreground",
            )}
          >
            {remaining}%
          </span>
          <span className="truncate text-2xs text-muted-foreground">{resetsIn ?? ""}</span>
        </span>
        <Meter remaining={remaining} timeLeft={timeLeft} color={color} />
      </TooltipTrigger>
      <TooltipPopup side="top">
        <div className="flex flex-col gap-0.5">
          <span className="text-foreground">
            {window.label}: {remaining}% left
          </span>
          {timeLeft !== null ? (
            <span className="text-muted-foreground">
              {timeLeft}% of the window left{pace === "ahead" ? " · spending ahead of pace" : ""}
            </span>
          ) : null}
          {resetsAt ? (
            <span className="text-muted-foreground">
              Resets {resetsAt}
              {resetsIn ? ` · in ${resetsIn}` : ""}
            </span>
          ) : null}
        </div>
      </TooltipPopup>
    </Tooltip>
  );
}

/** The pooled reading of one window: the share open across accounts and the next refill. */
function PooledCell({
  pool,
  accountCount,
  color,
  now,
}: {
  readonly pool: LimitPoolWindow;
  readonly accountCount: number;
  readonly color: string;
  readonly now: number;
}) {
  // The soonest reset that hands anything back; an untouched account resets to no effect.
  const nextRefill = pool.resets.find((reset) => reset.restoresPercent > 0);
  const reporting = pool.members.length;
  return (
    <div className="flex min-w-0 flex-col gap-1.5">
      <span className="flex items-baseline gap-1.5 tabular-nums">
        <span className="text-base font-semibold text-foreground">{pool.remainingPercent}%</span>
        <span className="inline-flex items-center gap-1.5 text-xs text-muted-foreground">
          <span>left</span>
          {pool.pace ? <PaceIcon pace={pool.pace} /> : null}
        </span>
      </span>
      <Meter remaining={pool.remainingPercent} timeLeft={null} color={color} />
      <span className="flex min-w-0 flex-wrap items-center gap-x-2 text-2xs text-muted-foreground tabular-nums">
        {nextRefill ? (
          <span className="inline-flex items-center gap-1">
            <RotateCcwIcon className="size-3" aria-hidden />+{nextRefill.restoresPercent}% in{" "}
            {shortResetsIn(nextRefill.member.window, now) ?? "—"}
          </span>
        ) : null}
        {reporting < accountCount ? (
          <span>
            {reporting} of {accountCount} accounts
          </span>
        ) : null}
      </span>
    </div>
  );
}

/** Banked reset credits as a compact action; the confirm mounts beside it, outside any popover. */
function ResetCreditAction({
  account,
  now,
}: {
  readonly account: LimitAccount;
  readonly now: number;
}) {
  const redeemAt = account.redeem!;
  const redeem = useResetCredit(redeemAt.environmentId, redeemAt.input);
  const credits = account.limits.resetCredits;
  if (!credits || (credits.availableCount === 0 && redeem.status === null)) return null;
  return (
    <span className="inline-flex items-center gap-2">
      {redeem.status ? (
        <span role="status" className="text-2xs text-foreground">
          {redeem.status}
        </span>
      ) : null}
      {credits.availableCount > 0 ? (
        <Tooltip>
          <TooltipTrigger
            render={
              <Button
                size="xs"
                variant="outline"
                disabled={redeem.busy || !redeem.canManageProviders}
                onClick={() => redeem.setConfirming(true)}
              />
            }
          >
            <TicketIcon aria-hidden />
            {redeem.busy ? "Using…" : `Use reset · ${credits.availableCount}`}
          </TooltipTrigger>
          <TooltipPopup side="top">{resetCreditsSummary(credits, now)}</TooltipPopup>
        </Tooltip>
      ) : null}
      <ResetCreditDialog
        open={redeem.confirming}
        onOpenChange={redeem.setConfirming}
        onConfirm={() => void redeem.redeem()}
        disabled={!redeem.canManageProviders}
      />
    </span>
  );
}

/** Status a row needs at a glance; detail lives in each badge's tooltip. */
function AccountBadges({ account, now }: { readonly account: LimitAccount; readonly now: number }) {
  const source = account.sourceAccount;
  const limitReached = account.limits.windows.some((window) => window.usedPercent >= 100);
  return (
    <>
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
      {source?.weeklyPace?.aheadOfPace ? (
        <Tooltip>
          <TooltipTrigger render={<Badge size="sm" variant="warning" />}>
            Ahead of pace
          </TooltipTrigger>
          <TooltipPopup side="top">
            claude-swap expected {Math.round(source.weeklyPace.expectedPercent)}% of the week used
            by now.
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {isStaleLimitAccount(account) ? (
        <Tooltip>
          <TooltipTrigger render={<Badge size="sm" variant="warning" />}>
            Stale · {readingAge(account.limits.checkedAt, now)}
          </TooltipTrigger>
          <TooltipPopup side="top">
            The account could not be read just now. These figures are its last good reading.
          </TooltipPopup>
        </Tooltip>
      ) : null}
      {source?.disabled ? (
        <Tooltip>
          <TooltipTrigger render={<Badge size="sm" variant="outline" />}>Disabled</TooltipTrigger>
          <TooltipPopup side="top">
            Left out when claude-swap picks the best account. You can still switch to it.
          </TooltipPopup>
        </Tooltip>
      ) : null}
    </>
  );
}

/** Name, then plan and where it is signed in, so a row reads without opening anything. */
function AccountIdentity({
  name,
  details,
  badges,
}: {
  readonly name: string;
  readonly details: readonly string[];
  readonly badges?: ReactNode;
}) {
  return (
    <div className="flex min-w-0 flex-col gap-0.5">
      <span className="flex min-w-0 items-center gap-1.5">
        <span className="min-w-0 truncate text-xs font-medium text-foreground">{name}</span>
        {badges}
      </span>
      {details.length > 0 ? (
        <span className="truncate text-2xs text-muted-foreground">{details.join(" · ")}</span>
      ) : null}
    </div>
  );
}

/** The account's own name, but its email over an instance named after the provider itself. */
function accountName(account: LimitAccount): string {
  const providerLabel = providerClients.get(account.driver)?.label ?? String(account.driver);
  const named = account.displayName && account.displayName !== providerLabel;
  return (named ? account.displayName : null) ?? account.email ?? providerLabel;
}

/**
 * One provider as a single table: a pooled row answering "can I keep going",
 * then one row per account answering "on which one". Columns are the
 * provider's windows, so a window an account does not report shows as a dash
 * instead of shifting the others.
 */
function PoolSection({
  pool,
  now,
  swapSources,
  switcher,
}: {
  readonly pool: LimitPool;
  readonly now: number;
  /** claude-swap sources on the selected environments; empty for other providers. */
  readonly swapSources: readonly ClaudeSwapSourceView[];
  readonly switcher: ClaudeSwapSwitcher;
}) {
  const color = barColor(pool.driver);
  const label = providerClients.get(pool.driver)?.label ?? String(pool.driver);
  const windows = displayLimitWindows(pool);
  const columns = windows.map((window) => ({
    window,
    details: pool.driver === "cursor" ? cursorUsageWindowDetails(window.id) : undefined,
  }));
  const accounts = pool.accounts;
  // Logins claude-swap holds that report no windows, such as expired ones, still get a row.
  const pooledEmails = new Set(
    accounts.flatMap((account) => (account.email ? [account.email.toLowerCase()] : [])),
  );
  const unreadable = swapSources.flatMap((source) =>
    source.accounts.filter(
      (view) => !view.account.email || !pooledEmails.has(view.account.email.toLowerCase()),
    ),
  );
  const multipleAccounts = accounts.length + unreadable.length > 1;
  const environmentIds = new Set(
    accounts.flatMap((account) => account.environments.map((entry) => entry.environmentId)),
  );
  const showWhere = environmentIds.size > 1 || accounts.some((account) => account.sourceLabel);
  const switchBest = swapSources.length === 1 ? swapSources[0]!.switchBest : null;
  const grid = {
    gridTemplateColumns: `minmax(12rem, 1.3fr) repeat(${columns.length}, minmax(7.5rem, 1fr)) auto`,
  };
  // Rows are subgrids of one table grid, so every column lines up whatever a row holds.
  const rowClass = "col-span-full grid grid-cols-subgrid items-center px-4 py-3";

  return (
    <section className="flex flex-col gap-3">
      <div className="flex flex-wrap items-center gap-x-3 gap-y-2">
        <h2 className="flex items-center gap-2 text-sm font-medium text-foreground">
          <ProviderInstanceIcon
            driverKind={pool.driver}
            displayName={label}
            indicatorBackground="var(--background)"
            className="size-5"
            iconClassName="size-4 text-foreground/80"
          />
          {label}
        </h2>
        {multipleAccounts ? (
          <span className="text-xs text-muted-foreground tabular-nums">
            {accounts.length + unreadable.length} accounts
          </span>
        ) : null}
        {switchBest ? (
          <span className="ms-auto">
            <ClaudeSwapSwitchButton
              switcher={switcher}
              request={switchBest}
              label="Switch to best"
            />
          </span>
        ) : null}
      </div>
      {swapSources.map((source) => (
        <ClaudeSwapSourceStatus
          key={`${source.environmentId}:${source.source.id}`}
          view={source}
          now={now}
          showEnvironment={swapSources.length > 1}
        />
      ))}
      <div className="overflow-x-auto rounded-lg border border-border/60">
        <div
          role="table"
          aria-label={`${label} limits`}
          className="grid min-w-fit gap-x-5"
          style={grid}
        >
          <div
            role="row"
            className={cn(
              rowClass,
              "border-b border-border/60 py-2 text-2xs text-muted-foreground",
            )}
          >
            <span role="columnheader">{multipleAccounts ? "Account" : ""}</span>
            {columns.map(({ window, details }) => (
              <span
                role="columnheader"
                key={`${window.kind}:${window.id}`}
                className="self-end text-balance"
              >
                {details?.label ?? window.label}
              </span>
            ))}
            <span role="columnheader" className="sr-only">
              Actions
            </span>
          </div>
          {multipleAccounts ? (
            <div role="row" className={cn(rowClass, "bg-muted/30")}>
              <span role="rowheader" className="text-xs font-medium text-foreground">
                All accounts
              </span>
              {columns.map(({ window }) => (
                <div role="cell" key={`${window.kind}:${window.id}`} className="min-w-0">
                  <PooledCell
                    pool={window}
                    accountCount={accounts.length}
                    color={color}
                    now={now}
                  />
                </div>
              ))}
              <span role="cell" />
            </div>
          ) : null}
          {accounts.map((account) => {
            const input = account.switchTo?.input;
            const swapView =
              account.switchTo && input && "accountId" in input
                ? findClaudeSwapAccount(
                    swapSources,
                    account.switchTo.environmentId,
                    input.sourceId,
                    input.accountId,
                  )
                : undefined;
            const where =
              account.environments.length > 0
                ? account.environments.map((entry) => entry.label).join(", ")
                : account.sourceLabel;
            const details = [
              account.plan,
              account.sourceKind === "claudeSwap" && account.sourceAccount
                ? `slot ${account.sourceAccount.id}`
                : undefined,
              showWhere ? where : undefined,
            ].filter((detail): detail is string => Boolean(detail));
            return (
              <div
                role="row"
                key={account.key}
                className={cn(rowClass, "border-t border-border/40")}
              >
                <div role="rowheader" className="min-w-0">
                  <AccountIdentity
                    name={accountName(account)}
                    details={details}
                    badges={<AccountBadges account={account} now={now} />}
                  />
                </div>
                {columns.map(({ window }) => {
                  const reading = window.columns.find(
                    (column) => column.account.key === account.key,
                  )?.window;
                  return (
                    <div role="cell" key={`${window.kind}:${window.id}`} className="min-w-0">
                      {reading ? (
                        <WindowCell window={reading} color={color} now={now} />
                      ) : (
                        <span className="text-xs text-muted-foreground">
                          <span aria-hidden>—</span>
                          <span className="sr-only">Not reported</span>
                        </span>
                      )}
                    </div>
                  );
                })}
                <div role="cell" className="flex items-center justify-end gap-2">
                  {account.redeem ? <ResetCreditAction account={account} now={now} /> : null}
                  {swapView?.switchTo ? (
                    <ClaudeSwapSwitchButton
                      switcher={switcher}
                      request={swapView.switchTo}
                      label="Switch"
                    />
                  ) : null}
                </div>
              </div>
            );
          })}
          {unreadable.map((view) => (
            <UnreadableSwapRow
              key={view.account.id}
              view={view}
              columnCount={columns.length}
              rowClass={rowClass}
              switcher={switcher}
              now={now}
            />
          ))}
        </div>
      </div>
      {columns.map(({ window, details }) =>
        details?.description ? (
          <p key={`${window.kind}:${window.id}`} className="text-xs text-muted-foreground">
            <span className="font-medium text-foreground">{details.label}:</span>{" "}
            {details.description}
          </p>
        ) : null,
      )}
    </section>
  );
}

/** A claude-swap login with nothing to pool: its reason spans the window columns. */
function UnreadableSwapRow({
  view,
  columnCount,
  rowClass,
  switcher,
  now,
}: {
  readonly view: ClaudeSwapAccountView;
  readonly columnCount: number;
  readonly rowClass: string;
  readonly switcher: ClaudeSwapSwitcher;
  readonly now: number;
}) {
  const { account } = view;
  const notice =
    loginExpiryNotice(account.loginExpiresAt, now) ??
    limitsNotice(account.usageLimits) ??
    "No limits reported.";
  return (
    <div role="row" className={cn(rowClass, "border-t border-border/40")}>
      <div role="rowheader" className="min-w-0">
        <AccountIdentity
          name={view.name}
          details={[account.plan, `slot ${account.id}`].filter((detail): detail is string =>
            Boolean(detail),
          )}
          badges={
            account.active ? (
              <Badge size="sm" variant="success">
                Active
              </Badge>
            ) : null
          }
        />
      </div>
      <span
        role="cell"
        className="text-xs text-warning-foreground"
        style={{ gridColumn: `span ${columnCount}` }}
      >
        {notice}
      </span>
      <div role="cell" className="flex justify-end">
        {view.switchTo ? (
          <ClaudeSwapSwitchButton switcher={switcher} request={view.switchTo} label="Switch" />
        ) : null}
      </div>
    </div>
  );
}

export function UsageLimitsPooled({
  presentations,
  now,
  cursorPrompt,
}: {
  readonly presentations: Parameters<typeof collectLimitAccounts>[0];
  readonly now: number;
  readonly cursorPrompt?: ReactNode;
}) {
  const pools = collectLimitPools(collectLimitAccounts(presentations), now);
  const swapSources = collectClaudeSwapSources(presentations);
  const switcher = useClaudeSwapSwitch(swapSources);
  // The Claude table reports claude-swap's own problems in place.
  const notices = collectLimitNotices(
    swapSources.length > 0 ? withoutClaudeSwapSources(presentations) : presentations,
  );
  const externalLinks = collectExternalUsageLinks(presentations);
  const hasClaudePool = pools.some((pool) => pool.driver === "claudeAgent");
  const cursorPromptAt =
    Math.max(
      pools.findIndex((pool) => pool.driver === "codex"),
      pools.findIndex((pool) => pool.driver === "claudeAgent"),
    ) + 1;
  return (
    <div className="flex flex-col gap-8">
      {pools.length === 0 &&
      notices.length === 0 &&
      swapSources.length === 0 &&
      !cursorPrompt &&
      externalLinks.length === 0 ? (
        <p className="text-sm text-muted-foreground">
          No provider on the selected environments reports subscription limits.
        </p>
      ) : null}
      {pools.map((pool, index) => (
        <Fragment key={pool.driver}>
          {index === cursorPromptAt ? cursorPrompt : null}
          <PoolSection
            pool={pool}
            now={now}
            swapSources={pool.driver === "claudeAgent" ? swapSources : []}
            switcher={switcher}
          />
        </Fragment>
      ))}
      {cursorPromptAt === pools.length ? cursorPrompt : null}
      {/* Without a Claude pool (every login unreadable) the accounts still need a home. */}
      {hasClaudePool ? null : (
        <ClaudeSwapAccountsSection sources={swapSources} switcher={switcher} now={now} />
      )}
      {externalLinks.map((link) => (
        <section
          key={link.url}
          className="flex flex-wrap items-center justify-between gap-3 rounded-lg border border-border/60 p-4"
        >
          <div className="flex min-w-0 flex-1 items-center gap-3">
            {link.url === CHATGPT_USAGE_URL ? (
              <OpenAI className="size-5 shrink-0" aria-hidden="true" />
            ) : null}
            <div className="min-w-0 space-y-1">
              <h2 className="text-sm font-medium">{link.label}</h2>
              {link.url === CHATGPT_USAGE_URL ? (
                <p className="text-xs text-muted-foreground">
                  View usage in ChatGPT with your connected account.
                </p>
              ) : link.message ? (
                <p className="max-w-xl text-xs text-muted-foreground">{link.message}</p>
              ) : null}
            </div>
          </div>
          <Button
            variant="ghost-muted"
            size="xs"
            onClick={() => void ensureLocalApi().shell.openExternal(link.url)}
          >
            Manage usage
            <ExternalLinkIcon className="size-3.5" aria-hidden="true" />
          </Button>
        </section>
      ))}
      <LimitNotices notices={notices} />
      <ClaudeSwapSwitchDialog switcher={switcher} />
    </div>
  );
}

function LimitNotices({ notices }: { readonly notices: readonly string[] }) {
  if (notices.length === 0) return null;
  return (
    <Alert variant="warning" controlAlignment="first-line">
      <AlertTriangleIcon />
      {notices.map((notice) => (
        <AlertTitle key={notice} className="break-words">
          {notice}
        </AlertTitle>
      ))}
    </Alert>
  );
}

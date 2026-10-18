import {
  type EnvironmentId,
  MAX_CLAUDE_SWAP_AUTO_SWITCH_PERCENT,
  MIN_CLAUDE_SWAP_AUTO_SWITCH_PERCENT,
  type ServerSettingsPatch,
  type UnifiedSettings,
} from "@t3tools/contracts";
import { useAtomValue } from "@effect/atom-react";
import {
  antigravityClaudeFallback,
  CLAUDE_SWAP_SWITCH_EFFECT,
  claudeSwapAutoSwitchLine,
} from "@t3tools/shared/usageLimits";
import { PlusIcon } from "lucide-react";
import { useState } from "react";

import { useUpdateEnvironmentSettings } from "../../hooks/useSettings";
import { serverEnvironment } from "../../state/server";
import { useAtomCommand } from "../../state/use-atom-command";
import { formatRelativeTimeLabel } from "../../timestampFormat";
import {
  AlertDialog,
  AlertDialogClose,
  AlertDialogDescription,
  AlertDialogFooter,
  AlertDialogHeader,
  AlertDialogPopup,
  AlertDialogTitle,
} from "../ui/alert-dialog";
import { Button } from "../ui/button";
import { DraftInput } from "../ui/draft-input";
import { Switch } from "../ui/switch";
import { AddUsageLimitSourceDialog } from "./AddUsageLimitSourceDialog";
import { IntegerSettingInput } from "./IntegerSettingInput";
import { searchableSetting } from "./settingsSearch";
import { SettingsRow, SettingsSection } from "./settingsLayout";

export function UsageProviderSettings({
  environmentId,
  environmentLabel,
  sources,
  cursorKeychainUsageEnabled,
  claudeSwapUsageEnabled,
  claudeSwapBinaryPath,
  claudeSwapAutoSwitchEnabled,
  claudeSwapAutoSwitchAtPercent,
  claudeSwapAntigravityFallbackEnabled,
  readOnly,
}: {
  readonly environmentId: EnvironmentId;
  readonly environmentLabel: string;
  readonly sources: UnifiedSettings["usageLimitSources"];
  readonly cursorKeychainUsageEnabled: boolean;
  readonly claudeSwapUsageEnabled: boolean;
  readonly claudeSwapBinaryPath: string;
  readonly claudeSwapAutoSwitchEnabled: boolean;
  readonly claudeSwapAutoSwitchAtPercent: number;
  readonly claudeSwapAntigravityFallbackEnabled: boolean;
  readonly readOnly: boolean;
}) {
  const updateSettings = useUpdateEnvironmentSettings(environmentId);
  const updateCursorSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "update Cursor account usage",
  });
  const refreshProviders = useAtomCommand(serverEnvironment.refreshProviders, {
    reportFailure: false,
  });
  const config = useAtomValue(serverEnvironment.configValueAtom(environmentId));
  const platform = config?.environment.platform;
  const claudeSwapSource = config?.usageLimitSources?.find(
    (source) => source.kind === "claudeSwap",
  );
  const autoSwitchLine = claudeSwapSource ? claudeSwapAutoSwitchLine(claudeSwapSource) : null;
  // The model needs no clock; `now` only filters windows this row does not show.
  const fallbackModel = antigravityClaudeFallback(config?.providers ?? [], 0)?.model ?? null;
  const [adding, setAdding] = useState(false);
  const [updatingCursor, setUpdatingCursor] = useState(false);
  const updateClaudeSwapSettings = useAtomCommand(serverEnvironment.updateSettings, {
    label: "update claude-swap accounts",
  });
  const [updatingClaudeSwap, setUpdatingClaudeSwap] = useState(false);
  const [confirmingAutoSwitch, setConfirmingAutoSwitch] = useState(false);
  const entries = Object.entries(sources);

  const setCursorUsageEnabled = async (enabled: boolean) => {
    setUpdatingCursor(true);
    const result = await updateCursorSettings({
      environmentId,
      input: { patch: { cursorKeychainUsageEnabled: enabled } },
    });
    if (result._tag === "Success") {
      await refreshProviders({ environmentId, input: {} });
    }
    setUpdatingCursor(false);
  };

  // The server re-reads claude-swap whenever one of its settings changes, so
  // there is no provider refresh here: it would only run cswap a second time.
  const setClaudeSwapSettings = async (patch: ServerSettingsPatch) => {
    setUpdatingClaudeSwap(true);
    try {
      await updateClaudeSwapSettings({ environmentId, input: { patch } });
    } finally {
      setUpdatingClaudeSwap(false);
    }
  };

  return (
    <>
      <SettingsSection
        {...searchableSetting("usage-providers")}
        headerAction={
          !readOnly ? (
            <Button size="xs" variant="outline" onClick={() => setAdding(true)}>
              <PlusIcon className="size-3" aria-hidden />
              Add hub
            </Button>
          ) : null
        }
      >
        {platform?.os === "darwin" ? (
          <SettingsRow
            id="cursor-keychain-usage"
            title="Cursor account usage"
            description="Read your existing Cursor CLI login from macOS Keychain to show account history and monthly limits. macOS may ask you to allow access."
            control={
              <Switch
                aria-label="Cursor account usage"
                checked={cursorKeychainUsageEnabled}
                disabled={readOnly || updatingCursor}
                onCheckedChange={(enabled) => void setCursorUsageEnabled(enabled)}
              />
            }
          />
        ) : null}
        <SettingsRow
          id={searchableSetting("claude-swap-usage").id}
          title="claude-swap accounts"
          description="Run claude-swap on this device to show every saved Claude account's limits in Usage and switch the device's Claude login from there. On macOS, claude-swap reads the logins from Keychain."
          control={
            <Switch
              aria-label="claude-swap accounts"
              checked={claudeSwapUsageEnabled}
              disabled={readOnly || updatingClaudeSwap}
              onCheckedChange={(enabled) =>
                void setClaudeSwapSettings({ claudeSwapUsageEnabled: enabled })
              }
            />
          }
        />
        {claudeSwapUsageEnabled ? (
          <>
            <SettingsRow
              title="claude-swap binary path"
              description="Leave empty to run cswap from PATH. ~ expands to the home folder."
              control={
                <div className="w-full sm:w-80">
                  <DraftInput
                    size="sm"
                    font="mono"
                    aria-label="claude-swap binary path"
                    placeholder="cswap"
                    spellCheck={false}
                    autoComplete="off"
                    disabled={readOnly}
                    value={claudeSwapBinaryPath}
                    onCommit={(next) => {
                      const path = next.trim();
                      if (path !== claudeSwapBinaryPath)
                        void setClaudeSwapSettings({ claudeSwapBinaryPath: path });
                    }}
                  />
                </div>
              }
            />
            <SettingsRow
              title={searchableSetting("claude-swap-auto-switch").title}
              description="When the active Claude account nears its 5-hour or weekly limit, claude-swap moves this device's Claude login to the account with the most headroom."
              status={
                autoSwitchLine && claudeSwapSource?.autoSwitch
                  ? `${autoSwitchLine} (${formatRelativeTimeLabel(claudeSwapSource.autoSwitch.at)})`
                  : null
              }
              control={
                <Switch
                  aria-label="Switch automatically between Claude accounts"
                  checked={claudeSwapAutoSwitchEnabled}
                  disabled={readOnly || updatingClaudeSwap}
                  onCheckedChange={(enabled) =>
                    enabled
                      ? setConfirmingAutoSwitch(true)
                      : void setClaudeSwapSettings({ claudeSwapAutoSwitchEnabled: false })
                  }
                />
              }
            />
            <SettingsRow
              title={searchableSetting("claude-swap-auto-switch-at").title}
              description="Percent of the active account's 5-hour or weekly limit."
              control={
                <IntegerSettingInput
                  value={claudeSwapAutoSwitchAtPercent}
                  min={MIN_CLAUDE_SWAP_AUTO_SWITCH_PERCENT}
                  max={MAX_CLAUDE_SWAP_AUTO_SWITCH_PERCENT}
                  ariaLabel="Percent of the Claude limit used before switching"
                  disabled={readOnly}
                  onCommit={(percent) =>
                    void setClaudeSwapSettings({ claudeSwapAutoSwitchAtPercent: percent })
                  }
                />
              }
            />
            <SettingsRow
              title="When every Claude account is full, continue on Antigravity Claude"
              description={
                fallbackModel
                  ? `Threads stopped by a Claude limit continue on ${fallbackModel.name} with a summary of the thread, once every account is at the switch percent. Antigravity shares this quota with GPT, and Claude Code skills, hooks and MCP servers are not available there. Threads return to their Claude model automatically once an account has room.`
                  : "Antigravity lists no Claude model. Enable an Antigravity provider that offers one."
              }
              control={
                <Switch
                  aria-label="When every Claude account is full, continue on Antigravity Claude"
                  checked={claudeSwapAntigravityFallbackEnabled}
                  disabled={
                    readOnly ||
                    updatingClaudeSwap ||
                    (!claudeSwapAntigravityFallbackEnabled &&
                      (!claudeSwapAutoSwitchEnabled || fallbackModel === null))
                  }
                  onCheckedChange={(enabled) =>
                    void setClaudeSwapSettings({ claudeSwapAntigravityFallbackEnabled: enabled })
                  }
                />
              }
            />
          </>
        ) : null}
        {entries.length === 0 ? (
          <SettingsRow title="No hubs configured." />
        ) : (
          entries.map(([id, source]) => {
            const label = source.label?.trim() || source.url;
            return (
              <SettingsRow
                key={id}
                title={label}
                description={
                  <span className="break-all">
                    CLI Proxy{source.enabled ? "" : " · Disabled"}
                    {label !== source.url ? ` · ${source.url}` : ""}
                  </span>
                }
                control={
                  !readOnly ? (
                    <RemoveUsageProviderButton
                      label={label}
                      onConfirm={() => updateSettings({ usageLimitSources: { [id]: null } })}
                    />
                  ) : null
                }
              />
            );
          })
        )}
      </SettingsSection>
      {adding && !readOnly ? (
        <AddUsageLimitSourceDialog
          open
          onOpenChange={setAdding}
          environmentId={environmentId}
          environmentLabel={environmentLabel}
        />
      ) : null}
      {/* Every later switch happens without asking, so turning it on asks once. */}
      <AlertDialog open={confirmingAutoSwitch} onOpenChange={setConfirmingAutoSwitch}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Switch Claude accounts automatically?</AlertDialogTitle>
            <AlertDialogDescription>
              When the active account's 5-hour or weekly usage reaches{" "}
              {claudeSwapAutoSwitchAtPercent}%, claude-swap moves the Claude login on{" "}
              {environmentLabel} to the account with the most headroom. This also switches Claude
              Code sessions you run outside T3 on that machine. {CLAUDE_SWAP_SWITCH_EFFECT}
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              disabled={readOnly || updatingClaudeSwap}
              onClick={() => {
                setConfirmingAutoSwitch(false);
                void setClaudeSwapSettings({ claudeSwapAutoSwitchEnabled: true });
              }}
            >
              Turn on
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

function RemoveUsageProviderButton({
  label,
  onConfirm,
}: {
  readonly label: string;
  readonly onConfirm: () => void;
}) {
  const [open, setOpen] = useState(false);
  return (
    <>
      <Button size="xs" variant="ghost" onClick={() => setOpen(true)}>
        Remove
      </Button>
      <AlertDialog open={open} onOpenChange={setOpen}>
        <AlertDialogPopup>
          <AlertDialogHeader>
            <AlertDialogTitle>Remove {label}?</AlertDialogTitle>
            <AlertDialogDescription>
              The hub's management key is deleted from this server. Its accounts leave the Limits
              view; the hub itself is untouched. Add it again with the URL and key to bring them
              back.
            </AlertDialogDescription>
          </AlertDialogHeader>
          <AlertDialogFooter>
            <AlertDialogClose render={<Button variant="outline" />}>Cancel</AlertDialogClose>
            <Button
              variant="destructive"
              onClick={() => {
                setOpen(false);
                onConfirm();
              }}
            >
              Remove hub
            </Button>
          </AlertDialogFooter>
        </AlertDialogPopup>
      </AlertDialog>
    </>
  );
}

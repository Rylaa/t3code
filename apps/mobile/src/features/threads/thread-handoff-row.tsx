import * as Dialog from "../../components/ui/Dialog";
import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveHandoffEndpoints, type HandoffEndpoints } from "@t3tools/client-runtime/handoff";
import {
  normalizeProviderAccentColor,
  resolveProviderInstanceDisplayName,
  shouldShowInstanceBadge,
} from "@t3tools/client-runtime/state/provider-instance-display";
import {
  isAgentWrittenHandoffItem,
  type EnvironmentId,
  type OrchestrationV2ProjectedTurnItem,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { useMemo, useState, type ReactNode } from "react";
import { Pressable, View, type ColorValue } from "react-native";
import { AppText as Text } from "../../components/ui/AppText";
import { SymbolView } from "../../components/ui/AppSymbol";
import { ProviderIcon, ProviderInstanceIcon } from "../../components/ProviderIcon";
import { environmentThreadDetails } from "../../state/threads";
import { serverEnvironment } from "../../state/server";
import { ThreadContextDivider } from "./thread-context-divider";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";

type HandoffProvider = ServerProvider & {
  readonly driverKind: ServerProvider["driver"];
  readonly acpRegistryAgentId: string | undefined;
};

function handoffEndpointsAtom(
  environmentId: EnvironmentId,
  { item, sourceThreadId }: OrchestrationV2ProjectedTurnItem,
) {
  let previous: ReturnType<typeof resolveHandoffEndpoints> | null = null;
  const ref = scopeThreadRef(environmentId, sourceThreadId);
  return Atom.make((get) => {
    if (item.type !== "handoff") return null;
    const projection = get(environmentThreadDetails.threadAtom(ref))?.projection;
    const next = resolveHandoffEndpoints(item, projection?.runs ?? []);
    // Run activity changes frequently; only endpoint changes affect this row.
    if (JSON.stringify(next) !== JSON.stringify(previous)) previous = next;
    return previous;
  });
}

export function ThreadHandoffRow(props: {
  environmentId: EnvironmentId;
  projectedItem: OrchestrationV2ProjectedTurnItem;
  iconColor: ColorValue;
  surfaceColor: string;
}) {
  const { item } = props.projectedItem;
  const endpointsAtom = useMemo(
    () => handoffEndpointsAtom(props.environmentId, props.projectedItem),
    [props.environmentId, props.projectedItem],
  );
  const endpoints = useAtomValue(endpointsAtom);
  const [showDocument, setShowDocument] = useState(false);
  if (item.type !== "handoff" || endpoints === null) return null;
  const color = item.status === "failed" ? "#e11d48" : props.iconColor;
  const document = isAgentWrittenHandoffItem(item) ? item.summary : undefined;
  return (
    <View>
      <ThreadHandoffDivider
        environmentId={props.environmentId}
        endpoints={endpoints}
        iconColor={color}
        surfaceColor={props.surfaceColor}
        label="Context handoff"
        failed={item.status === "failed"}
      >
        {document ? (
          <Pressable
            accessibilityRole="button"
            accessibilityLabel={showDocument ? "Hide handoff document" : "Show handoff document"}
            hitSlop={{ top: 8, bottom: 8, left: 8, right: 8 }}
            onPress={() => setShowDocument((shown) => !shown)}
          >
            <SymbolView name="doc.text" size={12} tintColor={color} />
          </Pressable>
        ) : null}
      </ThreadHandoffDivider>
      {document && showDocument ? (
        <View className="mb-3 gap-2 rounded-xl border border-border-subtle px-3 py-2.5">
          <Text selectable className="text-xs text-foreground">
            {document}
          </Text>
          <Pressable
            accessibilityRole="button"
            className="self-end rounded-full bg-subtle px-3 py-1 active:opacity-70"
            onPress={() => copyTextWithHaptic(document, { target: "handoff-document" })}
          >
            <Text className="text-xs font-t3-medium text-foreground">Copy</Text>
          </Pressable>
        </View>
      ) : null}
    </View>
  );
}

/** Pass `children` to add trailing controls after the endpoints. */
export function ThreadHandoffDivider(props: {
  environmentId: EnvironmentId;
  endpoints: HandoffEndpoints;
  iconColor: ColorValue;
  surfaceColor: string;
  label: string;
  failed?: boolean;
  children?: ReactNode;
}) {
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const { endpoints } = props;
  const endpointProps = {
    providers: (config?.providers ?? []).map((provider) => {
      const rawConfig = config?.settings.providerInstances[provider.instanceId]?.config;
      const instanceConfig =
        rawConfig !== null && typeof rawConfig === "object"
          ? (rawConfig as Readonly<Record<string, unknown>>)
          : null;
      const agentId = instanceConfig?.source === "local" ? undefined : instanceConfig?.agentId;
      return {
        ...provider,
        driverKind: provider.driver,
        accentColor: normalizeProviderAccentColor(provider.accentColor),
        acpRegistryAgentId: typeof agentId === "string" ? agentId.trim() || undefined : undefined,
      };
    }),
    surfaceColor: props.surfaceColor,
  };
  return (
    <ThreadContextDivider
      label={props.label}
      icon="arrow.left.arrow.right"
      iconColor={props.iconColor}
      failed={props.failed}
    >
      <View className="flex-row flex-wrap items-center justify-center gap-1.5">
        {endpoints.from.map((endpoint, index) => (
          <View
            key={`${endpoint.instanceId}:${endpoint.model ?? ""}`}
            className="max-w-full flex-row items-center"
          >
            <HandoffEndpoint {...endpoint} {...endpointProps} />
            {index < endpoints.from.length - 1 ? (
              <Text accessible={false} className="text-xs text-foreground-muted">
                ,
              </Text>
            ) : null}
          </View>
        ))}
        {endpoints.from.length > 0 ? (
          <SymbolView name="arrow.right" size={12} tintColor={props.iconColor} />
        ) : null}
        <HandoffEndpoint {...endpoints.to} {...endpointProps} />
        {props.children}
      </View>
    </ThreadContextDivider>
  );
}

function HandoffEndpoint(props: {
  instanceId: ProviderInstanceId;
  model?: string | undefined;
  providers: ReadonlyArray<HandoffProvider>;
  surfaceColor: string;
}) {
  const provider = props.providers.find((candidate) => candidate.instanceId === props.instanceId);
  const model = provider?.models.find((candidate) => candidate.slug === props.model);
  const label =
    model?.shortName ??
    model?.name ??
    props.model ??
    (provider ? resolveProviderInstanceDisplayName(provider) : props.instanceId);
  const showBadge = provider !== undefined && shouldShowInstanceBadge(provider, props.providers);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Show provider account"
      className="min-h-6 max-w-full flex-row items-center justify-center gap-1.5"
      hitSlop={{ top: 8, bottom: 8 }}
      onPress={() =>
        Dialog.alert(
          label,
          provider ? resolveProviderInstanceDisplayName(provider) : props.instanceId,
        )
      }
    >
      {showBadge && provider !== undefined ? (
        <ProviderInstanceIcon
          provider={provider.driver}
          iconUrl={provider.iconUrl}
          size={14}
          displayName={resolveProviderInstanceDisplayName(provider)}
          accentColor={provider.accentColor}
          showBadge
          surfaceColor={props.surfaceColor}
        />
      ) : (
        <ProviderIcon
          provider={provider?.driver ?? props.instanceId}
          iconUrl={provider?.iconUrl}
          size={12}
        />
      )}
      <Text numberOfLines={1} className="shrink text-xs text-foreground-muted">
        {label}
      </Text>
    </Pressable>
  );
}

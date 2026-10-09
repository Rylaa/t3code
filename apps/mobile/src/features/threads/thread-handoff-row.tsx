import { useAtomValue } from "@effect/atom-react";
import { scopeThreadRef } from "@t3tools/client-runtime/environment";
import { resolveHandoffEndpoints } from "@t3tools/client-runtime/handoff";
import { resolveProviderInstanceDisplayName } from "@t3tools/client-runtime/state/provider-instance-display";
import {
  isAgentWrittenHandoffItem,
  type EnvironmentId,
  type OrchestrationV2ProjectedTurnItem,
  type ProviderInstanceId,
  type ServerProvider,
} from "@t3tools/contracts";
import { Atom } from "effect/reactivity";
import { Fragment, useMemo, useState } from "react";
import { Alert, Pressable, View, type ColorValue } from "react-native";
import { AppText as Text } from "../../components/AppText";
import { SymbolView } from "../../components/AppSymbol";
import { ProviderIcon } from "../../components/ProviderIcon";
import { environmentThreadDetails } from "../../state/threads";
import { serverEnvironment } from "../../state/server";
import { ThreadContextDivider } from "./thread-context-divider";
import { copyTextWithHaptic } from "../../lib/copyTextWithHaptic";

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
}) {
  const { item } = props.projectedItem;
  const endpointsAtom = useMemo(
    () => handoffEndpointsAtom(props.environmentId, props.projectedItem),
    [props.environmentId, props.projectedItem],
  );
  const endpoints = useAtomValue(endpointsAtom);
  const config = useAtomValue(serverEnvironment.configValueAtom(props.environmentId));
  const [showDocument, setShowDocument] = useState(false);
  if (item.type !== "handoff" || endpoints === null) return null;
  const color = item.status === "failed" ? "#e11d48" : props.iconColor;
  const document = isAgentWrittenHandoffItem(item) ? item.summary : undefined;
  return (
    <View>
      <ThreadContextDivider
        label="Context handoff"
        icon="arrow.left.arrow.right"
        iconColor={color}
        failed={item.status === "failed"}
      >
        <View className="flex-row flex-wrap items-center justify-center gap-1.5">
          {endpoints.from.map((endpoint, index) => (
            <Fragment key={`${endpoint.instanceId}:${endpoint.model ?? ""}`}>
              {index > 0 ? (
                <Text accessible={false} className="text-xs text-foreground-muted">
                  ,
                </Text>
              ) : null}
              <HandoffEndpoint {...endpoint} providers={config?.providers ?? []} />
            </Fragment>
          ))}
          {endpoints.from.length > 0 ? (
            <SymbolView name="arrow.right" size={12} tintColor={color} />
          ) : null}
          <HandoffEndpoint {...endpoints.to} providers={config?.providers ?? []} />
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
        </View>
      </ThreadContextDivider>
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

function HandoffEndpoint(props: {
  instanceId: ProviderInstanceId;
  model?: string | undefined;
  providers: ReadonlyArray<ServerProvider>;
}) {
  const provider = props.providers.find((candidate) => candidate.instanceId === props.instanceId);
  const model = provider?.models.find((candidate) => candidate.slug === props.model);
  const label =
    model?.shortName ??
    model?.name ??
    props.model ??
    (provider ? resolveProviderInstanceDisplayName(provider) : props.instanceId);
  return (
    <Pressable
      accessibilityRole="button"
      accessibilityLabel={label}
      accessibilityHint="Show provider account"
      className="min-h-6 max-w-full flex-row items-center justify-center gap-1"
      hitSlop={{ top: 8, bottom: 8 }}
      onPress={() =>
        Alert.alert(
          label,
          provider ? resolveProviderInstanceDisplayName(provider) : props.instanceId,
        )
      }
    >
      <ProviderIcon
        provider={provider?.driver ?? props.instanceId}
        iconUrl={provider?.iconUrl}
        size={12}
      />
      <Text numberOfLines={1} className="shrink text-xs text-foreground-muted">
        {label}
      </Text>
    </Pressable>
  );
}

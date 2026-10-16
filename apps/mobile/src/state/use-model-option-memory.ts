import type {
  ModelCapabilities,
  ModelSelection,
  ProviderOptionSelection,
} from "@t3tools/contracts";
import {
  createModelSelection,
  withoutChromeOption,
  withThreadChromeOption,
} from "@t3tools/shared/model";
import { appAtomRegistry } from "./atom-registry";
import {
  modelOptionMemoryAtom,
  schedulePersistComposerState,
  type ModelOptionMemoryState,
} from "./use-composer-drafts";

function recordModelOptionsInState(
  state: ModelOptionMemoryState,
  instanceId: string,
  model: string,
  options: ReadonlyArray<ProviderOptionSelection>,
): ModelOptionMemoryState {
  if (options.length === 0) {
    return state;
  }
  return {
    ...state,
    [instanceId]: {
      ...(state[instanceId] ?? {}),
      [model]: options,
    },
  };
}

function lookupModelOptionsInState(
  state: ModelOptionMemoryState,
  instanceId: string,
  model: string,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  return state[instanceId]?.[model];
}

export function rememberModelOptions(
  instanceId: string,
  model: string,
  options: ReadonlyArray<ProviderOptionSelection>,
): void {
  const remembered = withoutChromeOption(options);
  if (remembered.length === 0) {
    return;
  }
  const current = appAtomRegistry.get(modelOptionMemoryAtom);
  const next = recordModelOptionsInState(current, String(instanceId), model, remembered);
  if (next !== current) {
    appAtomRegistry.set(modelOptionMemoryAtom, next);
    schedulePersistComposerState();
  }
}

export function rememberedModelOptions(
  instanceId: string,
  model: string,
): ReadonlyArray<ProviderOptionSelection> | undefined {
  return lookupModelOptionsInState(
    appAtomRegistry.get(modelOptionMemoryAtom),
    String(instanceId),
    model,
  );
}

export function withRememberedModelOptions<
  T extends {
    readonly instanceId: string;
    readonly model: string;
    readonly options?: ReadonlyArray<ProviderOptionSelection>;
  },
>(selection: T): T {
  const remembered = rememberedModelOptions(selection.instanceId, selection.model);
  // Memory never holds Claude in Chrome, so a pick that only adds it still matches.
  if (
    remembered === undefined ||
    JSON.stringify(remembered) === JSON.stringify(withoutChromeOption(selection.options))
  ) {
    return selection;
  }
  return { ...selection, options: remembered };
}

/**
 * A model picked inside a thread: its remembered options, and the thread's Claude in
 * Chrome while the picked model offers it (see withThreadChromeOption).
 */
export function threadModelPickSelection(
  option: { readonly selection: ModelSelection; readonly capabilities: ModelCapabilities | null },
  threadSelection: ModelSelection,
): ModelSelection {
  const picked = withRememberedModelOptions(option.selection);
  return createModelSelection(
    picked.instanceId,
    picked.model,
    withThreadChromeOption(picked.options, threadSelection.options, option.capabilities),
  );
}

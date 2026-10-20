import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as Option from "effect/Option";
import * as Schema from "effect/Schema";

import * as ProcessRunner from "../processRunner.ts";

interface ResolveServerEnvironmentLabelInput {
  readonly cwdBaseName: string;
}

const ServerEnvironmentLabelCommandProbe = Schema.Literals(["macos-computer-name"]);
type ServerEnvironmentLabelCommandProbe = typeof ServerEnvironmentLabelCommandProbe.Type;

export class ServerEnvironmentLabelCommandError extends Schema.TaggedError<ServerEnvironmentLabelCommandError>()(
  "ServerEnvironmentLabelCommandError",
  {
    probe: ServerEnvironmentLabelCommandProbe,
    executable: Schema.String,
    argumentCount: Schema.Number,
    cause: Schema.Defect(),
  },
) {
  override get message(): string {
    return `Failed to run environment-label probe '${this.probe}' with ${this.executable}.`;
  }
}

function normalizeLabel(value: string | null | undefined): string | null {
  const trimmed = value?.trim();
  return trimmed && trimmed.length > 0 ? trimmed : null;
}

const runFriendlyLabelCommand = Effect.fn("runFriendlyLabelCommand")(function* (input: {
  readonly probe: ServerEnvironmentLabelCommandProbe;
  readonly command: string;
  readonly args: readonly string[];
}) {
  const processRunner = yield* ProcessRunner.ProcessRunner;
  const result = yield* processRunner
    .run({
      command: input.command,
      args: input.args,
      timeoutBehavior: "timedOutResult",
    })
    .pipe(
      Effect.mapError(
        (cause) =>
          new ServerEnvironmentLabelCommandError({
            probe: input.probe,
            executable: input.command,
            argumentCount: input.args.length,
            cause,
          }),
      ),
      Effect.asSome,
      Effect.catchTags({
        ServerEnvironmentLabelCommandError: (error) =>
          Effect.logDebug(error.message).pipe(
            Effect.annotateLogs({
              probe: error.probe,
              executable: error.executable,
              argumentCount: error.argumentCount,
              cause: error,
            }),
            Effect.as(Option.none()),
          ),
      }),
    );

  if (Option.isNone(result) || result.value.code !== 0) {
    return null;
  }

  return normalizeLabel(result.value.stdout);
});

const resolveFriendlyHostLabel = () =>
  runFriendlyLabelCommand({
    probe: "macos-computer-name",
    command: "scutil",
    args: ["--get", "ComputerName"],
  });

export const resolveServerEnvironmentLabel = Effect.fn("resolveServerEnvironmentLabel")(function* (
  input: ResolveServerEnvironmentLabelInput,
) {
  const friendlyHostLabel = yield* resolveFriendlyHostLabel();
  if (friendlyHostLabel) {
    return friendlyHostLabel;
  }

  const hostname = normalizeLabel(yield* HostProcess.Hostname);
  if (hostname) {
    return hostname;
  }

  return normalizeLabel(input.cwdBaseName) ?? "T3 environment";
});

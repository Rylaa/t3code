import * as NodeNet from "node:net";

import * as NodeServices from "@effect/platform-node/NodeServices";
import { assert, describe, it } from "@effect/vitest";
import * as Effect from "effect/Effect";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";

// Node can bind 127.0.0.1:<port> while another process (such as the desktop
// app with network access on) listens on *:<port>.
describe("__ssh-helper pick-port", () => {
  const holdWildcardPort = Effect.acquireRelease(
    Effect.callback<NodeNet.Server>((resume) => {
      const server = NodeNet.createServer((socket) => socket.destroy());
      server.once("error", (error) => resume(Effect.die(error)));
      server.listen({ port: 0, host: "0.0.0.0" }, () => resume(Effect.succeed(server)));
    }),
    (server) =>
      Effect.callback<void>((resume) => {
        server.close(() => resume(Effect.void));
      }),
  );

  it.effect(
    "skips a port another server answers on loopback",
    () =>
      Effect.gen(function* () {
        const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
        const holder = yield* holdWildcardPort;
        const heldPort = (holder.address() as NodeNet.AddressInfo).port;

        const child = yield* spawner.spawn(
          ChildProcess.make(process.execPath, [
            "--experimental-strip-types",
            new URL("../bin.ts", import.meta.url).pathname,
            "__ssh-helper",
            "pick-port",
            "",
            String(heldPort),
            "20",
          ]),
        );
        const [stdout, exitCode] = yield* Effect.all(
          [
            child.stdout.pipe(
              Stream.decodeText(),
              Stream.runFold(
                () => "",
                (acc, chunk) => acc + chunk,
              ),
            ),
            child.exitCode.pipe(Effect.map(Number)),
          ],
          { concurrency: "unbounded" },
        );

        assert.equal(exitCode, 0);
        const picked = Number(stdout);
        assert.isAbove(picked, heldPort);
        assert.isBelow(picked, heldPort + 20);
      }).pipe(Effect.scoped, Effect.provide(NodeServices.layer)),
    30_000,
  );
});

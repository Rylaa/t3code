import { assert, beforeEach, it, vi } from "vite-plus/test";

const { execFileMock } = vi.hoisted(() => ({
  execFileMock: vi.fn(),
}));

vi.mock("node:child_process", () => ({ execFile: execFileMock }));

import { activeWindow } from "./ActiveWindow.ts";

beforeEach(() => {
  execFileMock.mockReset();
});

function stubMacLookup(stdout: string) {
  execFileMock.mockImplementation(
    (
      _file: string,
      _args: ReadonlyArray<string>,
      _options: unknown,
      callback: (error: Error | null, stdout: string) => void,
    ) => callback(null, stdout),
  );
}

it("parses the frontmost macOS window from the osascript lookup", async () => {
  stubMacLookup(
    JSON.stringify({
      id: 42,
      title: "main.ts",
      bounds: { x: 10, y: 20, width: 800, height: 600 },
      owner: {
        name: "Editor",
        processId: 123,
        path: "/Applications/Editor.app",
        bundleId: "com.example.editor",
      },
    }) + "\n",
  );

  const window = await activeWindow();

  assert.deepEqual(window, {
    id: 42,
    title: "main.ts",
    bounds: { x: 10, y: 20, width: 800, height: 600 },
    owner: {
      name: "Editor",
      processId: 123,
      path: "/Applications/Editor.app",
      bundleId: "com.example.editor",
    },
  });
  const [file, args] = execFileMock.mock.calls[0]!;
  assert.strictEqual(file, "/usr/bin/osascript");
  assert.deepEqual(args.slice(0, 3), ["-l", "JavaScript", "-e"]);
});

it("omits an empty macOS bundle identifier", async () => {
  stubMacLookup(
    JSON.stringify({
      id: 7,
      title: "",
      bounds: { x: 0, y: 0, width: 1, height: 1 },
      owner: { name: "cli", processId: 9, path: "", bundleId: "" },
    }),
  );

  const window = await activeWindow();

  assert.deepEqual(window?.owner, { name: "cli", processId: 9, path: "" });
});

it("resolves undefined when macOS has no frontmost window", async () => {
  stubMacLookup("\n");

  assert.isUndefined(await activeWindow());
});

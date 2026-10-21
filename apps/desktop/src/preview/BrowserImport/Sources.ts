import type { BrowserImportSourceId, BrowserImportSourceProfile } from "@t3tools/contracts";
import * as NodeSqliteClient from "@t3tools/shared/nodeSqliteClient";
import * as HostProcess from "@t3tools/shared/HostProcess";
import * as Effect from "effect/Effect";
import * as FileSystem from "effect/FileSystem";
import * as Path from "effect/Path";
import * as Schema from "effect/Schema";
import * as Stream from "effect/Stream";
import { ChildProcess, ChildProcessSpawner } from "effect/process";
import * as SqlClient from "effect/sql/SqlClient";

export type BrowserImportEngine = "chromium" | "firefox" | "safari";

export interface BrowserImportPathContext {
  readonly path: Path.Path;
  readonly home: string;
}

export interface BrowserImportSourceDefinition {
  readonly id: BrowserImportSourceId;
  readonly name: string;
  readonly engine: BrowserImportEngine;
  readonly userDataDirectory: (context: BrowserImportPathContext) => string | undefined;
  readonly keychainService?: string;
  readonly keychainAccount?: string;
}

const macApplicationSupport = (
  context: BrowserImportPathContext,
  ...segments: ReadonlyArray<string>
) => context.path.join(context.home, "Library", "Application Support", ...segments);

const chromiumSource = (input: {
  readonly id: BrowserImportSourceId;
  readonly name: string;
  readonly keychainService: string;
  readonly keychainAccount: string;
  readonly macSegments: ReadonlyArray<string>;
}): BrowserImportSourceDefinition => ({
  id: input.id,
  name: input.name,
  engine: "chromium",
  keychainService: input.keychainService,
  keychainAccount: input.keychainAccount,
  userDataDirectory: (context) => macApplicationSupport(context, ...input.macSegments),
});

export const BROWSER_IMPORT_SOURCES: ReadonlyArray<BrowserImportSourceDefinition> = [
  chromiumSource({
    id: "chrome",
    name: "Chrome",
    keychainService: "Chrome Safe Storage",
    keychainAccount: "Chrome",
    macSegments: ["Google", "Chrome"],
  }),
  chromiumSource({
    id: "edge",
    name: "Microsoft Edge",
    keychainService: "Microsoft Edge Safe Storage",
    keychainAccount: "Microsoft Edge",
    macSegments: ["Microsoft Edge"],
  }),
  chromiumSource({
    id: "brave",
    name: "Brave",
    keychainService: "Brave Safe Storage",
    keychainAccount: "Brave",
    macSegments: ["BraveSoftware", "Brave-Browser"],
  }),
  chromiumSource({
    id: "vivaldi",
    name: "Vivaldi",
    keychainService: "Vivaldi Safe Storage",
    keychainAccount: "Vivaldi",
    macSegments: ["Vivaldi"],
  }),
  chromiumSource({
    id: "opera",
    name: "Opera",
    keychainService: "Opera Safe Storage",
    keychainAccount: "Opera",
    macSegments: ["com.operasoftware.Opera"],
  }),
  chromiumSource({
    id: "arc",
    name: "Arc",
    keychainService: "Arc Safe Storage",
    keychainAccount: "Arc",
    macSegments: ["Arc", "User Data"],
  }),
  chromiumSource({
    id: "helium",
    name: "Helium",
    keychainService: "Helium Storage Key",
    keychainAccount: "Helium",
    macSegments: ["net.imput.helium"],
  }),
  {
    id: "safari",
    name: "Safari",
    engine: "safari",
    userDataDirectory: (context) =>
      context.path.join(
        context.home,
        "Library",
        "Containers",
        "com.apple.Safari",
        "Data",
        "Library",
        "Cookies",
      ),
  },
  {
    id: "firefox",
    name: "Firefox",
    engine: "firefox",
    userDataDirectory: (context) => macApplicationSupport(context, "Firefox"),
  },
];

const cookieDatabaseCandidatePaths = (
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
  profileDirectory: string,
): ReadonlyArray<string> => {
  const root = definition.userDataDirectory(context);
  if (root === undefined) return [];
  const profilePath = context.path.isAbsolute(profileDirectory)
    ? profileDirectory
    : context.path.join(root, profileDirectory);
  if (definition.engine === "firefox") {
    return [context.path.join(profilePath, "cookies.sqlite")];
  }
  if (definition.engine === "safari") {
    return [context.path.join(profilePath, "Cookies.binarycookies")];
  }
  // Chromium: pre-96 uses `Cookies`, 96+ use `Network/Cookies`. An upgrade
  // leaves the legacy file behind, so prefer the current one and fall back.
  return [
    context.path.join(profilePath, "Network", "Cookies"),
    context.path.join(profilePath, "Cookies"),
  ];
};

export const resolveCookieDatabase = Effect.fnUntraced(function* (
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
  profileDirectory: string,
) {
  for (const candidate of cookieDatabaseCandidatePaths(definition, context, profileDirectory)) {
    if (yield* databaseFileExists(candidate)) return candidate;
  }
  return undefined;
});

/**
 * Firefox records its profiles in `profiles.ini`. `Install*` sections point at
 * a default profile but do not describe one, so only `[ProfileN]` blocks
 * count.
 */
export function parseFirefoxProfiles(
  ini: string,
  path: Path.Path,
  root: string,
): ReadonlyArray<BrowserImportSourceProfile> {
  const profiles: BrowserImportSourceProfile[] = [];
  let current: { name?: string; path?: string; isRelative?: string } | null = null;

  const flush = () => {
    if (current?.path) {
      const candidate = current.path;
      const isRelative = current.isRelative === undefined || current.isRelative === "1";
      const validIsRelative = current.isRelative === undefined || /^[01]$/.test(current.isRelative);
      if (!validIsRelative || candidate.includes("\u0000")) {
        current = null;
        return;
      }

      let directory: string | undefined;
      if (isRelative) {
        if (!path.isAbsolute(candidate)) {
          const resolved = path.resolve(root, candidate);
          const relative = path.relative(root, resolved);
          const escapesRoot =
            relative === ".." || relative.startsWith(`..${path.sep}`) || path.isAbsolute(relative);
          if (!escapesRoot) directory = path.normalize(candidate);
        }
      } else if (path.isAbsolute(candidate)) {
        // Firefox supports profiles on arbitrary custom roots when
        // IsRelative=0. Do not constrain them to the standard Firefox root.
        directory = path.normalize(candidate);
      }

      if (directory !== undefined) {
        profiles.push({ directory, name: current.name?.trim() || directory });
      }
    }
    current = null;
  };

  for (const rawLine of ini.split(/\r?\n/)) {
    const line = rawLine.trim();
    if (line.startsWith("[")) {
      flush();
      current = /^\[Profile\d+\]$/i.test(line) ? {} : null;
      continue;
    }
    if (!current) continue;
    const separator = line.indexOf("=");
    if (separator === -1) continue;
    const key = line.slice(0, separator).trim().toLowerCase();
    const value = line.slice(separator + 1).trim();
    if (key === "name") current.name = value;
    if (key === "path") current.path = value;
    if (key === "isrelative") current.isRelative = value;
  }
  flush();
  return profiles;
}

export const sourcePathContext = Effect.gen(function* () {
  const path = yield* Path.Path;
  const environment = yield* HostProcess.Environment;
  return { path, home: environment.HOME ?? "" } satisfies BrowserImportPathContext;
});

const LocalState = Schema.Struct({
  profile: Schema.optional(
    Schema.Struct({
      info_cache: Schema.optional(
        Schema.Record(Schema.String, Schema.Struct({ name: Schema.optional(Schema.String) })),
      ),
    }),
  ),
});
const decodeLocalState = Schema.decodeUnknownEffect(Schema.fromJsonString(LocalState));

const isSafeProfileDirectory = (directory: string): boolean =>
  directory.length > 0 &&
  directory !== "." &&
  directory !== ".." &&
  !/[\\/]/.test(directory) &&
  !directory.includes("\u0000");

const CookieCountRow = Schema.Struct({ count: Schema.Number });
const decodeCookieCount = Schema.decodeUnknownEffect(Schema.Array(CookieCountRow));

/**
 * Firefox containers use identities Electron cannot represent, so its count
 * uses the same default-container predicate as the reader.
 */
const countProfileCookies = Effect.fnUntraced(function* (
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
  directory: string,
): Effect.fn.Return<number | undefined, never, FileSystem.FileSystem> {
  const database = yield* resolveCookieDatabase(definition, context, directory);
  if (database === undefined) return undefined;
  return yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    const rows =
      definition.engine === "firefox"
        ? yield* sql`select count(*) as count from moz_cookies where originAttributes = ''`
        : yield* sql`select count(*) as count from cookies`;
    const [row] = yield* decodeCookieCount(rows);
    return row?.count;
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: database, readonly: true })),
    Effect.orElseSucceed(() => undefined),
  );
});

const withCookieCounts = (
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
  profiles: ReadonlyArray<BrowserImportSourceProfile>,
) =>
  Effect.forEach(profiles, (profile) =>
    countProfileCookies(definition, context, profile.directory).pipe(
      Effect.map((cookieCount) =>
        cookieCount === undefined ? profile : { ...profile, cookieCount },
      ),
    ),
  );

const SafariProfileRows = Schema.Array(
  Schema.Struct({ title: Schema.NullOr(Schema.String), external_uuid: Schema.String }),
);
const decodeSafariProfiles = Schema.decodeUnknownEffect(SafariProfileRows);
const isSafariProfileUuid = (value: string) =>
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);

const listSafariProfiles = Effect.fnUntraced(function* (
  context: BrowserImportPathContext,
  root: string,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const library = context.path.dirname(root);
  const metadata = context.path.join(library, "Safari", "SafariTabs.db");
  const declared = yield* Effect.gen(function* () {
    const sql = yield* SqlClient.SqlClient;
    return yield* decodeSafariProfiles(
      yield* sql`
      select title, external_uuid from bookmarks
      where parent = 0 and type = 1 and subtype = 2 and deleted = 0
      order by order_index
    `,
    );
  }).pipe(
    Effect.provide(NodeSqliteClient.layer({ filename: metadata, readonly: true })),
    Effect.orElseSucceed(() => []),
  );
  const defaultProfile = declared.find((profile) => profile.external_uuid === "DefaultProfile");
  const profiles: Array<BrowserImportSourceProfile> = [
    {
      directory: ".",
      name: defaultProfile ? defaultProfile.title?.trim() || "Personal" : "Safari",
    },
  ];
  const stores = context.path.join(library, "WebKit", "WebsiteDataStore");
  const profileDirectory = (uuid: string) =>
    context.path.join(stores, uuid.toLowerCase(), "Cookies");
  for (const profile of declared) {
    if (!isSafariProfileUuid(profile.external_uuid)) continue;
    profiles.push({
      directory: profileDirectory(profile.external_uuid),
      name: profile.title?.trim() || profile.external_uuid,
    });
  }
  // With readable metadata, avoid resurrecting deleted profiles left on disk.
  if (declared.length === 0) {
    const entries = yield* fileSystem.readDirectory(stores).pipe(Effect.orElseSucceed(() => []));
    for (const entry of entries.filter(isSafariProfileUuid).sort()) {
      const directory = context.path.join(stores, entry, "Cookies");
      if (yield* databaseFileExists(context.path.join(directory, "Cookies.binarycookies"))) {
        profiles.push({ directory, name: entry });
      }
    }
  }
  return profiles;
});

export const listSourceProfiles = Effect.fn("BrowserImportSources.listSourceProfiles")(function* (
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
): Effect.fn.Return<ReadonlyArray<BrowserImportSourceProfile>, never, FileSystem.FileSystem> {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = definition.userDataDirectory(context);
  if (root === undefined) return [];

  if (definition.engine === "safari") {
    return yield* listSafariProfiles(context, root);
  }

  if (definition.engine === "firefox") {
    const declared = yield* fileSystem.readFileString(context.path.join(root, "profiles.ini")).pipe(
      Effect.map((ini) => parseFirefoxProfiles(ini, context.path, root)),
      Effect.orElseSucceed(() => [] as ReadonlyArray<BrowserImportSourceProfile>),
    );
    // `profiles.ini` also lists profiles the installer created but the user
    // never launched, which hold no cookie database and nothing to import. When
    // none of the declared profiles has one, fall through to the scan rather
    // than returning empty: `profiles.ini` can list stale or never-launched
    // profiles while the cookies live in one it does not mention, and an empty
    // answer here hides the browser entirely.
    if (declared.length > 0) {
      const found = yield* Effect.forEach(declared, (profile) =>
        Effect.forEach(
          cookieDatabaseCandidatePaths(definition, context, profile.directory),
          (candidate) => databaseFileExists(candidate),
        ).pipe(Effect.map((results) => (results.some(Boolean) ? profile : undefined))),
      );
      const withDatabase = found.filter((profile) => profile !== undefined);
      if (withDatabase.length > 0) {
        return yield* withCookieCounts(definition, context, withDatabase);
      }
    }

    const scanned = yield* fileSystem
      .readDirectory(context.path.join(root, "Profiles"))
      .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
    const found = yield* Effect.forEach(scanned, (entry) => {
      const directory = context.path.join("Profiles", entry);
      return resolveCookieDatabase(definition, context, directory).pipe(
        Effect.map((database) => (database === undefined ? undefined : { directory, name: entry })),
      );
    });
    return yield* withCookieCounts(
      definition,
      context,
      found.filter((profile) => profile !== undefined),
    );
  }

  const declared = yield* fileSystem.readFileString(context.path.join(root, "Local State")).pipe(
    Effect.flatMap(decodeLocalState),
    Effect.map((state) => Object.entries(state.profile?.info_cache ?? {})),
    // The keys are directory names from the browser's own metadata file, which
    // anything running as the user can write. Anything but a single plain
    // segment is dropped: `..` or a path separator would otherwise be handed
    // to `cookieDatabasePath` and read a database outside the user-data
    // directory.
    Effect.map((entries) => entries.filter(([directory]) => isSafeProfileDirectory(directory))),
    Effect.map((entries) =>
      entries.map(([directory, info]) => ({ directory, name: info.name?.trim() || directory })),
    ),
    Effect.orElseSucceed(() => [] as ReadonlyArray<BrowserImportSourceProfile>),
  );
  if (declared.length > 0) return yield* withCookieCounts(definition, context, declared);

  const entries = yield* fileSystem
    .readDirectory(root)
    .pipe(Effect.orElseSucceed(() => [] as ReadonlyArray<string>));
  const found = yield* Effect.forEach(entries.filter(isSafeProfileDirectory), (directory) =>
    resolveCookieDatabase(definition, context, directory).pipe(
      Effect.map((database) =>
        database === undefined ? undefined : { directory, name: directory },
      ),
    ),
  );
  return yield* withCookieCounts(
    definition,
    context,
    found.filter((profile) => profile !== undefined),
  );
});

const databaseFileExists = Effect.fnUntraced(function* (path: string) {
  const fileSystem = yield* FileSystem.FileSystem;
  return yield* fileSystem.stat(path).pipe(
    Effect.map((info) => info.type === "File"),
    Effect.orElseSucceed(() => false),
  );
});

type ProcessLivenessProbe = (pid: number) => Effect.Effect<boolean>;

export const chromiumProcessIsAlive = (
  pid: number,
  signalProcess: (pid: number, signal: 0) => unknown = process.kill.bind(process),
) =>
  Effect.sync(() => {
    try {
      signalProcess(pid, 0);
      return true;
    } catch (cause) {
      // Only ESRCH positively proves the process is gone. Permission errors
      // and unknown failures stay conservative so an active browser is never
      // mistaken for a stale lock.
      return !(
        typeof cause === "object" &&
        cause !== null &&
        "code" in cause &&
        cause.code === "ESRCH"
      );
    }
  });

const processIsAlive: ProcessLivenessProbe = (pid) => chromiumProcessIsAlive(pid);

export const chromiumSingletonLockIsHeld = Effect.fnUntraced(function* (
  target: string,
  currentHost: string,
  isProcessAlive: ProcessLivenessProbe,
) {
  const separator = target.lastIndexOf("-");
  if (separator <= 0) return true;
  const host = target.slice(0, separator);
  const pidText = target.slice(separator + 1);
  if (!/^\d+$/.test(pidText)) return true;
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  // A PID is meaningful only on this host. A foreign hostname can come from a
  // shared home directory, and cannot safely be declared stale from here.
  if (host !== currentHost) return true;
  return yield* isProcessAlive(pid);
});

export const firefoxSymlinkLockIsHeld = Effect.fnUntraced(function* (
  target: string,
  localAddresses: ReadonlySet<string>,
  isProcessAlive: ProcessLivenessProbe,
) {
  const separator = target.lastIndexOf(":");
  if (separator < 0) return true;
  // The owner half is whatever Firefox's resolver returned for the machine's
  // hostname — 127.0.0.1 when the lookup fails, but often 127.0.1.1 or a LAN
  // address — so a pid is only meaningful when that address is one of ours.
  const owner = target.slice(0, separator);
  if (!localAddresses.has(owner)) return true;
  // A `+` marks an fcntl-holding owner; the pid follows either way.
  const pidText = target.slice(separator + 1).replace(/^\+/, "");
  if (!/^\d+$/.test(pidText)) return true;
  const pid = Number(pidText);
  if (!Number.isSafeInteger(pid) || pid <= 0) return true;
  return yield* isProcessAlive(pid);
});

/**
 * `/usr/bin/python3` is named absolutely first so a Dock-launched app with
 * launchd's bare `PATH` still finds it without depending on the login-shell
 * PATH merge.
 */
const FCNTL_PROBE_INTERPRETERS = ["/usr/bin/python3", "python3"] as const;

/**
 * Anything else means the script never ran — most importantly Apple's
 * `/usr/bin/python3` shim, which on a Mac without the Command Line Tools exits
 * non-zero after printing an install prompt, without ever reaching our code.
 */
const FCNTL_PROBE_SCRIPT =
  "import fcntl,os,sys\n" +
  "fd=os.open(sys.argv[1],os.O_WRONLY)\n" +
  "try:\n" +
  "  fcntl.lockf(fd,fcntl.LOCK_EX|fcntl.LOCK_NB)\n" +
  "except BlockingIOError:\n" +
  "  print('held')\n" +
  "else:\n" +
  "  print('free')";

/**
 * Anything else — no interpreter on any candidate path, or one that refused to
 * run the script (Apple's shim without the developer tools) — is the probe
 * being unavailable, not evidence about the lock. That case falls back to "not
 * held" rather than "held": reporting every profile as locked forever would
 * block Firefox import outright on such machines, and the SQLite snapshot
 * already copes with a live database's WAL, as it does for every other engine.
 */
const posixLockIsHeld = Effect.fnUntraced(function* (
  path: string,
  interpreters: ReadonlyArray<string> = FCNTL_PROBE_INTERPRETERS,
) {
  const spawner = yield* ChildProcessSpawner.ChildProcessSpawner;
  const environment = yield* HostProcess.Environment;
  for (const interpreter of interpreters) {
    const verdict = yield* Effect.scoped(
      Effect.gen(function* () {
        const handle = yield* spawner.spawn(
          ChildProcess.make(interpreter, ["-c", FCNTL_PROBE_SCRIPT, path], {
            stdin: "ignore",
            env: environment,
          }),
        );
        const [stdout] = yield* Effect.all(
          [handle.stdout.pipe(Stream.decodeText(), Stream.mkString), handle.exitCode],
          { concurrency: "unbounded" },
        );
        return stdout.trim();
      }),
    ).pipe(Effect.orElseSucceed(() => ""));
    if (verdict === "held") return true;
    if (verdict === "free") return false;
  }
  return false;
});

/**
 * But `.parentlock` is a regular file held with fcntl and *deliberately left on
 * disk* after exit, as a last-used marker; treating it as proof of a running
 * browser blocks every import after Firefox has been used once.
 */
const firefoxProfileIsHeld = Effect.fnUntraced(function* (
  directory: string,
  context: BrowserImportPathContext,
  localAddresses: ReadonlySet<string>,
) {
  const fileSystem = yield* FileSystem.FileSystem;
  const symlinkHeld = yield* fileSystem.readLink(context.path.join(directory, "lock")).pipe(
    Effect.flatMap((target) => firefoxSymlinkLockIsHeld(target, localAddresses, processIsAlive)),
    Effect.orElseSucceed(() => false),
  );
  if (symlinkHeld) return true;
  const parentLock = context.path.join(directory, ".parentlock");
  const present = yield* fileSystem.stat(parentLock).pipe(
    Effect.map((info) => info.type === "File"),
    Effect.orElseSucceed(() => false),
  );
  if (!present) return false;
  return yield* posixLockIsHeld(parentLock);
});

export const isSourceRunning = Effect.fn("BrowserImportSources.isSourceRunning")(function* (
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
): Effect.fn.Return<
  boolean,
  never,
  FileSystem.FileSystem | ChildProcessSpawner.ChildProcessSpawner
> {
  const fileSystem = yield* FileSystem.FileSystem;
  const root = definition.userDataDirectory(context);
  if (root === undefined) return false;
  // Safari keeps no lock and writes its jar atomically, so a running instance
  // is not a hazard there.
  if (definition.engine === "safari") return false;
  if (definition.engine !== "firefox") {
    const currentHost = yield* HostProcess.Hostname;
    const lock = context.path.join(root, "SingletonLock");
    return yield* fileSystem.readLink(lock).pipe(
      Effect.flatMap((target) => chromiumSingletonLockIsHeld(target, currentHost, processIsAlive)),
      Effect.catch((error) => Effect.succeed(error.reason._tag !== "NotFound")),
    );
  }

  const profiles = yield* listSourceProfiles(definition, context);
  const localAddresses: ReadonlySet<string> = yield* yield* HostProcess.Addresses;
  const found = yield* Effect.forEach(profiles, (profile) => {
    const directory = context.path.isAbsolute(profile.directory)
      ? profile.directory
      : context.path.join(root, profile.directory);
    return firefoxProfileIsHeld(directory, context, localAddresses);
  });
  return found.some(Boolean);
});

/**
 * Keyed off the cookie database rather than the user-data directory, because
 * that directory is not evidence the browser exists: installers for native
 * messaging hosts create an empty one for every Chromium fork they know about,
 * so a machine with only Chrome reports Edge, Brave, Vivaldi, Opera and Arc as
 * present.
 *
 * Existence is checked without opening the file, which matters for Safari: TCC
 * permits `stat` on the jar inside its container but refuses a read, so this
 * still sees it and the user gets the Full Disk Access prompt rather than
 * having Safari disappear.
 */
export const isSourceInstalled = Effect.fn("BrowserImportSources.isSourceInstalled")(function* (
  definition: BrowserImportSourceDefinition,
  context: BrowserImportPathContext,
): Effect.fn.Return<boolean, never, FileSystem.FileSystem> {
  const profiles = yield* listSourceProfiles(definition, context);
  const found = yield* Effect.forEach(profiles, (profile) =>
    resolveCookieDatabase(definition, context, profile.directory).pipe(
      Effect.map((database) => database !== undefined),
    ),
  );
  return found.some(Boolean);
});

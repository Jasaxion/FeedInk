import { createHash, randomUUID } from "node:crypto";
import {
  mkdir,
  readFile,
  writeFile,
  readdir,
  mkdtemp,
  rm,
  link,
  stat,
  open,
} from "node:fs/promises";
import { resolve, join } from "node:path";
import { fileURLToPath } from "node:url";
import postgres from "postgres";
import ipaddr from "ipaddr.js";
import {
  DEFAULT_SETTINGS,
  type User,
  type ReaderSettings,
} from "@feedink/shared";

export interface Config {
  databaseUrl: string;
  dataDir: string;
  appUrl: string;
  sessionSecret: string;
  host: string;
  port: number;
  registration: boolean;
  adminEmail?: string; // Legacy input is ignored by public registration.
  trustProxy?: string[];
  fetchAllowHosts: string[];
  webDir: string;
  worker: boolean;
}
export function configFromEnv(): Config {
  const sessionSecret = process.env.SESSION_SECRET || "";
  if (sessionSecret.length < 32)
    throw new Error("SESSION_SECRET must contain at least 32 characters");
  if (process.env.NODE_ENV === "production" && !process.env.DATABASE_URL)
    throw new Error("DATABASE_URL is required in production");
  const appUrl = process.env.APP_URL || "http://localhost:3000";
  if (!["http:", "https:"].includes(new URL(appUrl).protocol))
    throw new Error("APP_URL must be HTTP(S)");
  return {
    databaseUrl:
      process.env.DATABASE_URL ||
      "postgres://feedink:feedink@localhost:5432/feedink",
    dataDir: resolve(process.env.DATA_DIR || "/data"),
    appUrl: new URL(appUrl).origin,
    sessionSecret,
    host: process.env.HOST || "0.0.0.0",
    port: Number(process.env.PORT || 3000),
    registration: process.env.REGISTRATION_ENABLED !== "false",
    trustProxy: parseTrustedProxies(process.env.TRUST_PROXY || ""),
    fetchAllowHosts: (process.env.FETCH_ALLOW_HOSTS || "")
      .split(",")
      .map((s) => s.trim().toLowerCase())
      .filter(Boolean),
    webDir: resolve(
      process.env.WEB_DIST ||
        fileURLToPath(new URL("../../web/dist", import.meta.url)),
    ),
    worker: process.env.WORKER_ENABLED !== "false",
  };
}
export type DB = ReturnType<typeof postgres>;
export type SQL = postgres.ISql;
export async function withConnection<T>(
  db: DB,
  task: (sql: SQL) => Promise<T>,
  existing?: SQL,
): Promise<T> {
  if (existing) return task(existing);
  const sql = await db.reserve();
  try {
    return await task(sql);
  } finally {
    sql.release();
  }
}
export function parseTrustedProxies(value: string): string[] {
  return value
    .split(",")
    .map((s) => s.trim())
    .filter(Boolean)
    .map((s) => {
      try {
        const [address, prefix] = s.includes("/")
          ? ipaddr.parseCIDR(s)
          : [ipaddr.parse(s), undefined];
        if (
          prefix === 0 ||
          address.range() === "unspecified" ||
          (address.kind() === "ipv6" &&
            (address as ipaddr.IPv6).isIPv4MappedAddress() &&
            prefix !== undefined &&
            prefix <= 96)
        )
          throw new Error();
        return s;
      } catch {
        throw new Error(
          "TRUST_PROXY must contain explicit non-universal IP addresses/CIDRs",
        );
      }
    });
}
// Database rows are deliberately confined to persistence modules; public DTOs have shared types.
export type Row = Record<string, any>;
export class ApiFailure extends Error {
  constructor(
    public statusCode: number,
    public code: string,
    message: string,
  ) {
    super(message);
  }
}
export const fail = (status: number, code: string, message: string): never => {
  throw new ApiFailure(status, code, message);
};
export const id = randomUUID;
export const hash = (body: string | Buffer) =>
  createHash("sha256").update(body).digest("hex");
export const iso = (date: unknown) => new Date(date as string).toISOString();
export const settingsFor = (user: Row): ReaderSettings => ({
  ...DEFAULT_SETTINGS,
  ...user.settings,
});
export const userDto = (r: Row): User => ({
  id: r.id,
  email: r.email,
  name: r.name,
  isAdmin: r.is_admin,
  isDemo: r.is_demo,
  createdAt: iso(r.created_at),
});
export function connect(config: Config): DB {
  return postgres(config.databaseUrl, {
    max: 10,
    idle_timeout: 20,
    connect_timeout: 10,
  });
}
export async function migrate(db: DB) {
  const connection = await db.reserve();
  try {
    await connection`SELECT pg_advisory_lock(71244001)`;
    await connection`CREATE TABLE IF NOT EXISTS schema_migrations (name text PRIMARY KEY, checksum text NOT NULL, applied_at timestamptz NOT NULL DEFAULT now())`;
    const directory = fileURLToPath(new URL("../migrations/", import.meta.url));
    for (const name of (await readdir(directory))
      .filter((s) => s.endsWith(".sql"))
      .sort()) {
      const content = await readFile(join(directory, name), "utf8");
      const [existing] =
        await connection`SELECT checksum FROM schema_migrations WHERE name=${name}`;
      if (existing) {
        if (existing.checksum !== hash(content))
          throw new Error(`Migration checksum mismatch: ${name}`);
        continue;
      }
      await connection`BEGIN`;
      try {
        await connection.unsafe(content);
        await connection`INSERT INTO schema_migrations (name,checksum) VALUES (${name},${hash(content)})`;
        await connection`COMMIT`;
      } catch (e) {
        await connection`ROLLBACK`;
        throw e;
      }
    }
  } finally {
    await connection`SELECT pg_advisory_unlock(71244001)`;
    connection.release();
  }
}
export class Store {
  constructor(readonly directory: string) {}
  async init() {
    await mkdir(this.directory, { recursive: true, mode: 0o700 });
  }
  path(key: string) {
    if (!/^[a-f0-9]{64}$/.test(key)) throw new Error("Invalid storage key");
    return join(this.directory, key);
  }
  async size(key: string) {
    return (await stat(this.path(key))).size;
  }
  async referenced(sql: SQL, key: string) {
    const [row] =
      await sql`SELECT EXISTS(SELECT 1 FROM images WHERE file_key=${key} UNION ALL SELECT 1 FROM ebooks WHERE file_key=${key} UNION ALL SELECT 1 FROM feeds WHERE icon_file_key=${key}) AS found`;
    return row.found;
  }
  async recover(sql: SQL) {
    await sql`SELECT pg_advisory_lock(71244004)`;
    try {
      for (const entry of await readdir(this.directory, {
        withFileTypes: true,
      })) {
        if (!entry.isDirectory() || !/^\.stage-[A-Za-z0-9]+$/.test(entry.name))
          continue;
        const directory = join(this.directory, entry.name);
        for (const key of await readdir(directory))
          if (/^[a-f0-9]{64}$/.test(key) && !(await this.referenced(sql, key)))
            await rm(this.path(key), { force: true });
        await rm(directory, { recursive: true, force: true });
      }
    } finally {
      await sql`SELECT pg_advisory_unlock(71244004)`;
    }
  }
  async writeTransaction<T>(
    sql: SQL,
    task: (put: (data: Buffer) => Promise<string>) => Promise<T>,
  ): Promise<T> {
    // Every production blob writer shares this lock, including DB references.
    // Never acquire a second pool connection while holding it.
    await sql`SELECT pg_advisory_lock(71244004)`;
    let directory: string | undefined,
      finished = false;
    const staged = new Set<string>(),
      created = new Set<string>();
    try {
      directory = await mkdtemp(join(this.directory, ".stage-"));
      await sql`BEGIN`;
      const result = await task(async (data) => {
        const key = hash(data);
        if (!staged.has(key)) {
          const file = await open(join(directory!, key), "wx", 0o600);
          try {
            await file.writeFile(data);
            await file.sync();
          } finally {
            await file.close();
          }
          staged.add(key);
        }
        return key;
      });
      const stageDirectory = await open(directory, "r");
      try {
        await stageDirectory.sync();
      } finally {
        await stageDirectory.close();
      }
      for (const key of staged) {
        try {
          await link(join(directory, key), this.path(key));
          created.add(key);
        } catch (e: any) {
          if (e.code !== "EEXIST") throw e;
        }
      }
      const rootDirectory = await open(this.directory, "r");
      try {
        await rootDirectory.sync();
      } finally {
        await rootDirectory.close();
      }
      await sql`COMMIT`;
      finished = true;
      return result;
    } catch (e) {
      try {
        await sql`ROLLBACK`;
        for (const key of created)
          if (!(await this.referenced(sql, key)))
            await rm(this.path(key), { force: true });
        finished = true;
      } catch {
        /* Keep durable staging for startup recovery when the DB outcome is unknown. */
      }
      throw e;
    } finally {
      if (finished && directory)
        await rm(directory, { recursive: true, force: true });
      try {
        await sql`SELECT pg_advisory_unlock(71244004)`;
      } catch {
        /* A lost connection releases its server-side lock. */
      }
    }
  }
  async get(key: string): Promise<Buffer> {
    return readFile(this.path(key));
  }
}
export function safeError(error: unknown): string {
  // Do not persist upstream URLs or credentials from HTTP library errors.
  return error instanceof ApiFailure
    ? error.message
    : "The operation failed; check operator logs and retry.";
}

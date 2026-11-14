import {
  scrypt as scryptCallback,
  randomBytes,
  timingSafeEqual,
  createHmac,
} from "node:crypto";
import { promisify } from "node:util";
import { z } from "zod";
import type { FastifyInstance, FastifyRequest, FastifyReply } from "fastify";
import {
  type DB,
  type Config,
  type Row,
  id,
  hash,
  userDto,
  settingsFor,
  ApiFailure,
} from "./core.js";
import { name, validateSettings, uuid } from "./validation.js";
const scrypt = promisify(scryptCallback);
export async function passwordHash(password: string) {
  const salt = randomBytes(16).toString("hex"),
    derived = (await scrypt(password, salt, 64)) as Buffer;
  return `${salt}:${derived.toString("hex")}`;
}
export async function passwordMatches(password: string, stored: string) {
  const [salt, digest] = stored.split(":");
  const derived = (await scrypt(password, salt || "invalid", 64)) as Buffer,
    expected = Buffer.from(digest || "", "hex");
  return (
    derived.length === expected.length && timingSafeEqual(derived, expected)
  );
}
declare module "fastify" {
  interface FastifyRequest {
    account: Row | null;
    sessionHash: string | null;
  }
}
export class Auth {
  constructor(
    readonly db: DB,
    readonly config: Config,
  ) {}
  csrf(token: string) {
    return createHmac("sha256", this.config.sessionSecret)
      .update(`csrf:${token}`)
      .digest("base64url");
  }
  async session(user: Row, reply: FastifyReply) {
    const token = randomBytes(32).toString("base64url");
    await this
      .db`INSERT INTO sessions(token_hash,user_id,expires_at) VALUES(${hash(token)},${user.id},now()+interval '30 days')`;
    reply.setCookie("feedink_session", token, {
      httpOnly: true,
      secure: this.config.appUrl.startsWith("https:"),
      sameSite: "lax",
      path: "/",
      maxAge: 30 * 86400,
    });
    return {
      user: userDto(user),
      settings: settingsFor(user),
      csrfToken: this.csrf(token),
    };
  }
  install(app: FastifyInstance, seedDemo: (user: Row) => Promise<void>) {
    app.decorateRequest("account", null);
    app.decorateRequest("sessionHash", null);
    const anonymous = new Set([
      "/api/health",
      "/api/auth/login",
      "/api/auth/register",
      "/api/auth/demo",
    ]);
    app.addHook("onRequest", async (request, reply) => {
      const path = request.url.split("?")[0];
      if (!path.startsWith("/api/")) return;
      reply.header("Cache-Control", "no-store").header("Vary", "Cookie");
      if (
        !["GET", "HEAD", "OPTIONS"].includes(request.method) &&
        request.headers.origin &&
        request.headers.origin !== this.config.appUrl
      )
        throw new ApiFailure(
          403,
          "FOREIGN_ORIGIN",
          "Requests must originate from this application",
        );
      if (anonymous.has(path)) return;
      const token = request.cookies.feedink_session;
      if (!token)
        throw new ApiFailure(401, "UNAUTHENTICATED", "Sign in to continue");
      const tokenHash = hash(token);
      const [user] = await this
        .db`SELECT u.* FROM users u JOIN sessions s ON s.user_id=u.id WHERE s.token_hash=${tokenHash} AND s.expires_at>now() AND NOT u.disabled`;
      if (!user)
        throw new ApiFailure(
          401,
          "UNAUTHENTICATED",
          "Your session has expired",
        );
      request.account = user;
      request.sessionHash = tokenHash;
      if (!["GET", "HEAD", "OPTIONS"].includes(request.method)) {
        const received = Buffer.from(
            String(request.headers["x-csrf-token"] || ""),
          ),
          expected = Buffer.from(this.csrf(token));
        if (
          received.length !== expected.length ||
          !timingSafeEqual(received, expected)
        )
          throw new ApiFailure(403, "CSRF", "Missing or invalid CSRF token");
      }
    });
    const jsonOnly = (request: FastifyRequest) => {
      if (!request.headers["content-type"]?.startsWith("application/json"))
        throw new ApiFailure(415, "JSON_REQUIRED", "Send application/json");
    };
    const credentials = z.object({
      email: z
        .email()
        .max(254)
        .transform((s) => s.toLowerCase()),
      password: z.string().min(10).max(256),
    });
    const authLimit = { rateLimit: { max: 10, timeWindow: "1 minute" } };
    app.post(
      "/api/auth/register",
      { config: authLimit },
      async (request, reply) => {
        jsonOnly(request);
        if (!this.config.registration)
          throw new ApiFailure(
            403,
            "REGISTRATION_DISABLED",
            "Registration is disabled by the operator",
          );
        const input = credentials.extend({ name }).strict().parse(request.body),
          userId = id();
        const digest = await passwordHash(input.password);
        let user: Row;
        try {
          [user] = await this
            .db`INSERT INTO users(id,email,name,password_hash,is_admin) VALUES(${userId},${input.email},${input.name},${digest},false) RETURNING *`;
        } catch (e: any) {
          if (e.code === "23505")
            throw new ApiFailure(
              409,
              "EMAIL_EXISTS",
              "An account already uses that email",
            );
          throw e;
        }
        reply.code(201);
        return this.session(user, reply);
      },
    );
    app.post(
      "/api/auth/login",
      { config: authLimit },
      async (request, reply) => {
        jsonOnly(request);
        const input = credentials.strict().parse(request.body);
        const [user] = await this
          .db`SELECT * FROM users WHERE email=${input.email}`;
        const valid = await passwordMatches(
          input.password,
          user?.password_hash ||
            "0123456789abcdef:00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000",
        );
        if (!user || user.disabled || user.is_demo || !valid)
          throw new ApiFailure(
            401,
            "INVALID_CREDENTIALS",
            "Email or password is incorrect",
          );
        return this.session(user, reply);
      },
    );
    app.post(
      "/api/auth/demo",
      { config: { rateLimit: { max: 5, timeWindow: "1 hour" } } },
      async (_request, reply) => {
        const userId = id();
        const [user] = await this
          .db`INSERT INTO users(id,email,name,password_hash,is_demo) VALUES(${userId},${`demo-${userId}@example.invalid`},'演示读者','disabled',true) RETURNING *`;
        try {
          await seedDemo(user);
        } catch (e) {
          await this.db`DELETE FROM users WHERE id=${userId}`;
          throw e;
        }
        reply.code(201);
        return this.session(user, reply);
      },
    );
    app.get("/api/session", async (request) => ({
      user: userDto(request.account!),
      settings: settingsFor(request.account!),
      csrfToken: this.csrf(request.cookies.feedink_session!),
    }));
    app.post("/api/auth/logout", async (request, reply) => {
      await this
        .db`DELETE FROM sessions WHERE token_hash=${request.sessionHash!}`;
      reply.clearCookie("feedink_session", { path: "/" }).code(204).send();
    });
    app.patch("/api/account", async (request) => {
      const input = z
          .object({
            name: name.optional(),
            currentPassword: z.string().max(256).optional(),
            password: z.string().min(10).max(256).optional(),
          })
          .strict()
          .parse(request.body),
        user = request.account!;
      if (input.password) {
        if (user.is_demo)
          throw new ApiFailure(
            403,
            "DEMO_RESTRICTED",
            "Demo accounts cannot change passwords",
          );
        if (
          !input.currentPassword ||
          !(await passwordMatches(input.currentPassword, user.password_hash))
        )
          throw new ApiFailure(
            403,
            "CURRENT_PASSWORD",
            "Current password is incorrect",
          );
        const digest = await passwordHash(input.password);
        await this.db.begin(async (tx) => {
          await tx`UPDATE users SET password_hash=${digest} WHERE id=${user.id}`;
          await tx`DELETE FROM sessions WHERE user_id=${user.id} AND token_hash!=${request.sessionHash!}`;
        });
      }
      if (input.name)
        await this.db`UPDATE users SET name=${input.name} WHERE id=${user.id}`;
      const [updated] = await this.db`SELECT * FROM users WHERE id=${user.id}`;
      return userDto(updated);
    });
    app.get("/api/settings", async (request) => settingsFor(request.account!));
    app.patch("/api/settings", async (request) => {
      const user = request.account!,
        settings = validateSettings(user.settings, request.body);
      if (user.is_demo && settings.ebookAutoSend)
        throw new ApiFailure(
          403,
          "DEMO_RESTRICTED",
          "Demo accounts cannot schedule email",
        );
      await this
        .db`UPDATE users SET settings=${this.db.json(settings)} WHERE id=${user.id}`;
      return settings;
    });
    const admin = (request: FastifyRequest) => {
      if (!request.account?.is_admin || request.account.is_demo)
        throw new ApiFailure(
          403,
          "ADMIN_REQUIRED",
          "Administrator access required",
        );
    };
    app.get("/api/admin/users", async (request) => {
      admin(request);
      return {
        items: (
          await this.db`SELECT * FROM users ORDER BY created_at LIMIT 1000`
        ).map((u) => ({ ...userDto(u), disabled: u.disabled })),
      };
    });
    app.patch("/api/admin/users/:id", async (request) => {
      admin(request);
      const userId = uuid.parse((request.params as any).id),
        input = z
          .object({ disabled: z.boolean().optional() })
          .strict()
          .parse(request.body);
      return this.db.begin(async (tx) => {
        await tx`SELECT pg_advisory_xact_lock(71244003)`;
        const [target] =
          await tx`SELECT * FROM users WHERE id=${userId} FOR UPDATE`;
        if (!target) throw new ApiFailure(404, "NOT_FOUND", "User not found");
        if (input.disabled) {
          const [{ count }] =
            await tx`SELECT count(*)::integer AS count FROM users WHERE is_admin AND NOT disabled`;
          if (userId === request.account!.id || (target.is_admin && count <= 1))
            throw new ApiFailure(
              409,
              "LAST_ADMIN",
              "Cannot disable yourself or the last administrator",
            );
          await tx`DELETE FROM sessions WHERE user_id=${userId}`;
        }
        const [result] =
          await tx`UPDATE users SET disabled=COALESCE(${input.disabled ?? null},disabled) WHERE id=${userId} RETURNING *`;
        return { ...userDto(result), disabled: result.disabled };
      });
    });
  }
}

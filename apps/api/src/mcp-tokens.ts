import { randomBytes } from 'node:crypto';
import { z } from 'zod';
import ipaddr from 'ipaddr.js';
import type { FastifyInstance, FastifyRequest } from 'fastify';
import type { McpAccessToken, McpScope } from '@feedink/shared';
import { type DB, type Config, type Row, ApiFailure, id, hash, iso } from './core.js';
import { uuid } from './validation.js';
import { finiteJson } from './annotation-validation.js';

export interface McpPrincipal { readonly userId: string; readonly tokenId: string; readonly scopes: readonly McpScope[] }
const scope = z.enum(['articles:read', 'notes:read']);
const accessDto = (r: Row): McpAccessToken => ({ id: r.id, name: r.name, scopes: r.scopes, createdAt: iso(r.created_at), expiresAt: iso(r.expires_at), lastUsedAt: r.last_used_at ? iso(r.last_used_at) : null });
export function secureMcpConfig(config: Config): boolean {
  const origin = new URL(config.appUrl);
  return origin.protocol === 'https:' || (origin.protocol === 'http:' && ['localhost', '127.0.0.1', '[::1]'].includes(origin.hostname));
}
/** Fastify computes host/protocol using only explicitly trusted immediate proxies.
 * Compare the complete external authority (including port); never trust arbitrary forwarded headers. */
export function mcpBoundary(request: FastifyRequest, config: Config): void {
  const origin = new URL(config.appUrl);
  const loopback = origin.protocol !== 'http:' || (() => { try { return ipaddr.process(request.ip).range() === 'loopback'; } catch { return false; } })();
  if (!secureMcpConfig(config) || !loopback || request.protocol !== origin.protocol.slice(0, -1) || request.host.toLowerCase() !== origin.host.toLowerCase()) throw new ApiFailure(403, 'MCP_ORIGIN', 'MCP requires the configured secure application origin');
  if (request.headers.origin !== undefined && request.headers.origin !== origin.origin) throw new ApiFailure(403, 'MCP_ORIGIN', 'MCP origin is not allowed');
}
export class McpTokens {
  constructor(readonly db: DB, readonly config: Config) {}
  async authenticate(authorization: string | undefined): Promise<McpPrincipal> {
    const match = authorization?.match(/^Bearer (fi_mcp_[A-Za-z0-9_-]{43})$/);
    if (!match) throw new ApiFailure(401, 'MCP_UNAUTHENTICATED', 'A valid MCP bearer token is required');
    const [row] = await this.db`UPDATE mcp_tokens t SET last_used_at=now() FROM users u WHERE t.user_id=u.id AND t.token_hash=${hash(match[1])} AND t.revoked_at IS NULL AND t.expires_at>now() AND NOT u.disabled AND NOT u.is_demo RETURNING t.id,t.user_id,t.scopes`;
    if (!row) throw new ApiFailure(401, 'MCP_UNAUTHENTICATED', 'A valid MCP bearer token is required');
    return Object.freeze({ userId: row.user_id as string, tokenId: row.id as string, scopes: Object.freeze([...row.scopes]) as readonly McpScope[] });
  }
  install(app: FastifyInstance): void {
    const owner = (r: FastifyRequest) => {
      if (r.account!.is_demo) throw new ApiFailure(403, 'DEMO_RESTRICTED', 'Demo accounts cannot manage MCP tokens');
      return r.account!.id as string;
    };
    app.get('/api/mcp-tokens', async r => ({ items: (await this.db`SELECT id,name,scopes,created_at,expires_at,last_used_at FROM mcp_tokens WHERE user_id=${owner(r)} AND revoked_at IS NULL ORDER BY created_at DESC,id LIMIT 1000`).map(accessDto) }));
    app.post('/api/mcp-tokens', { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } }, async (r, reply) => {
      const userId = owner(r);
      if (!secureMcpConfig(this.config)) throw new ApiFailure(403, 'MCP_HTTPS_REQUIRED', 'Configure HTTPS before creating MCP tokens');
      finiteJson(r.body, 4096);
      const input = z.object({ name: z.string().trim().min(1).max(160), scopes: z.array(scope).min(1).max(2).refine(s => new Set(s).size === s.length), expiresInDays: z.number().int().min(1).max(365).default(90) }).strict().parse(r.body);
      const token = `fi_mcp_${randomBytes(32).toString('base64url')}`;
      const access = await this.db.begin(async sql => {
        await sql`SELECT id FROM users WHERE id=${userId} FOR UPDATE`;
        const [{ count }] = await sql`SELECT count(*)::integer AS count FROM mcp_tokens WHERE user_id=${userId} AND revoked_at IS NULL`;
        if (count >= 100) throw new ApiFailure(409, 'MCP_TOKEN_LIMIT', 'Revoke an existing token before creating another');
        const [row] = await sql`INSERT INTO mcp_tokens(id,user_id,name,scopes,token_hash,expires_at) VALUES(${id()},${userId},${input.name},${input.scopes},${hash(token)},${new Date(Date.now() + input.expiresInDays * 86400000)}) RETURNING id,name,scopes,created_at,expires_at,last_used_at`;
        return accessDto(row);
      });
      reply.code(201);
      return { token, access };
    });
    app.delete('/api/mcp-tokens/:id', async (r, reply) => {
      const rows = await this.db`UPDATE mcp_tokens SET revoked_at=COALESCE(revoked_at,now()) WHERE id=${uuid.parse((r.params as { id: string }).id)} AND user_id=${owner(r)} RETURNING id`;
      if (!rows.length) throw new ApiFailure(404, 'NOT_FOUND', 'Token not found');
      reply.code(204).send();
    });
  }
}

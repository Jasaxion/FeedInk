import { createCipheriv, createDecipheriv, randomBytes } from 'node:crypto';
import { isIP } from 'node:net';
import { ApiFailure } from './core.js';

const errors = {
  AI_UNAVAILABLE: [503, 'AI encryption is not configured; contact the operator'],
  AI_SECRET: [409, 'The saved AI credential cannot be authenticated; save it again'],
  AI_CONFIG: [409, 'Save a complete AI configuration before requesting this operation'],
  AI_CONFIG_CHANGED: [409, 'The AI configuration changed; review it before requesting a new job'],
  AI_DESTINATION: [400, 'The AI destination is not permitted'],
  AI_PROVIDER: [502, 'The provider request failed; retry explicitly if desired'],
  AI_INTERRUPTED: [409, 'Work was interrupted or its outcome is unknown; retry explicitly if desired'],
  AI_OUTPUT: [502, 'The provider returned incomplete or invalid output'],
  AI_LIMIT: [413, 'The complete input or output exceeds the AI processing budget'],
  AI_QUEUE_FULL: [429, 'The AI queue is full; try again later'],
  AI_ACTIVE_JOB: [409, 'A matching job is already active; cancel it before forcing regeneration'],
  AI_CANCELLED: [409, 'AI work was cancelled'],
  AI_STALE_SOURCE: [409, 'The article context or AI configuration changed; request a new job'],
  AI_FULLTEXT_MISSING: [409, 'Full text has not been captured; select feed content or capture it first'],
  AI_DEMO: [403, 'Demo accounts cannot configure or invoke AI'],
  AI_NOT_FOUND: [404, 'AI job or owned article not found'],
  AI_REQUEST: [400, 'Invalid AI request'],
  AI_RESULT_SELECTION: [409, 'Select only existing terminal AI results owned by this account; nothing was deleted'],
} as const;
export type AiErrorCode = keyof typeof errors;
export function aiFailure(code: AiErrorCode): ApiFailure {
  const [status, message] = errors[code];
  return new ApiFailure(status, code, message);
}
export function aiErrorFromCode(code: string): ApiFailure {
  return aiFailure(Object.hasOwn(errors, code) ? code as AiErrorCode : 'AI_INTERRUPTED');
}
/** Never include upstream errors, response bodies, request values or credentials. */
export function safeAiError(error: unknown): ApiFailure {
  return error instanceof ApiFailure && Object.hasOwn(errors, error.code)
    ? aiFailure(error.code as AiErrorCode) : aiFailure('AI_INTERRUPTED');
}
/** Check literal decoded text and adjacent joins, not arbitrary encodings of a secret. */
export function assertAiCredentialAbsent(parts: Iterable<string>, credential: string): void {
  let tail = '';
  for (const part of parts) {
    const joined = tail + part;
    if (joined.includes(credential)) throw aiFailure('AI_OUTPUT');
    tail = credential.length > 1 ? joined.slice(-(credential.length - 1)) : '';
  }
}
export interface AiEnvironment { encryptionKey?: Buffer; allowHosts: readonly string[] }
/** Invalid/missing optional AI settings fail closed without breaking RSS startup. */
export function aiEnvironmentFromEnv(env: NodeJS.ProcessEnv = process.env): AiEnvironment {
  const value = env.AI_ENCRYPTION_KEY ?? '';
  const encryptionKey = /^[A-Za-z0-9+/]{43}=$/.test(value) && Buffer.from(value, 'base64').length === 32
    && Buffer.from(value, 'base64').toString('base64') === value ? Buffer.from(value, 'base64') : undefined;
  const allowHosts = (env.AI_ALLOW_HOSTS ?? '').split(',').map(host => host.trim().toLowerCase()).filter(Boolean);
  // Exact hostname/IP only, no wildcard, port, URL, suffix, whitespace or userinfo.
  const valid = allowHosts.every(host => isIP(host) || /^(?=.{1,253}$)[a-z0-9](?:[a-z0-9.-]*[a-z0-9])?$/.test(host) && !host.includes('..'));
  return { encryptionKey, allowHosts: valid ? allowHosts : [] };
}
const aad = (owner: string, revision: number) => Buffer.from(JSON.stringify(['feedink-ai-key', 1, owner, revision]));
export function encryptAiKey(key: Buffer | undefined, owner: string, revision: number, secret: string): string {
  if (!key || key.length !== 32) throw aiFailure('AI_UNAVAILABLE');
  const nonce = randomBytes(12), cipher = createCipheriv('aes-256-gcm', key, nonce);
  cipher.setAAD(aad(owner, revision));
  const ciphertext = Buffer.concat([cipher.update(secret, 'utf8'), cipher.final()]);
  return ['1', nonce.toString('base64'), ciphertext.toString('base64'), cipher.getAuthTag().toString('base64')].join('.');
}
export function decryptAiKey(key: Buffer | undefined, owner: string, revision: number, envelope: string): string {
  if (!key || key.length !== 32) throw aiFailure('AI_UNAVAILABLE');
  try {
    const [version, nonce, ciphertext, tag, extra] = envelope.split('.');
    if (version !== '1' || !nonce || !ciphertext || !tag || extra !== undefined) throw new Error();
    const iv = Buffer.from(nonce, 'base64'), authTag = Buffer.from(tag, 'base64');
    if (iv.length !== 12 || authTag.length !== 16) throw new Error();
    const cipher = createDecipheriv('aes-256-gcm', key, iv);
    cipher.setAAD(aad(owner, revision)); cipher.setAuthTag(authTag);
    return Buffer.concat([cipher.update(Buffer.from(ciphertext, 'base64')), cipher.final()]).toString('utf8');
  } catch { throw aiFailure('AI_SECRET'); }
}

import { lookup } from 'node:dns/promises';
import http from 'node:http';
import https from 'node:https';
import { isIP } from 'node:net';
import { publicAddress } from './network.js';
import { aiFailure, safeAiError, type AiEnvironment } from './ai-security.js';

export interface AiProviderConfig { baseUrl: string; model: string; apiKey: string }
export interface AiMessage { role: 'system' | 'user'; content: string }
export interface AiProvider {
  complete(config: AiProviderConfig, messages: AiMessage[], signal: AbortSignal, options?: { maxTokens?: number }): Promise<string>;
}
export const AI_REQUEST_TIMEOUT_MS = 45000;
export const AI_RESPONSE_BYTES = 512 * 1024;
export class PinnedAiProvider implements AiProvider {
  constructor(readonly environment: AiEnvironment, readonly resolveHost = (host: string) => lookup(host, { all: true, verbatim: true })) {}
  validate(baseUrl: string): URL {
    try {
      const url = new URL(baseUrl), host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
      const allowed = this.environment.allowHosts.includes(host);
      if (url.href.length > 2048 || url.username || url.password || url.search || url.hash || host.includes('%')
        || !['http:', 'https:'].includes(url.protocol)
        || !allowed && (url.protocol !== 'https:' || url.port && url.port !== '443')
        || !allowed && isIP(host) && !publicAddress(host)) throw new Error();
      return url;
    } catch { throw aiFailure('AI_DESTINATION'); }
  }
  async complete(config: AiProviderConfig, messages: AiMessage[], signal: AbortSignal, options: { maxTokens?: number } = {}): Promise<string> {
    const maxTokens = options.maxTokens ?? 8192;
    if (!Number.isInteger(maxTokens) || maxTokens < 1 || maxTokens > 8192) throw aiFailure('AI_LIMIT');
    const url = this.validate(config.baseUrl);
    url.pathname = url.pathname.replace(/\/$/, '') + '/chat/completions';
    const host = url.hostname.replace(/^\[|\]$/g, '').toLowerCase();
    const body = Buffer.from(JSON.stringify({ model: config.model, messages, temperature: 0, max_tokens: maxTokens, response_format: { type: 'json_object' }, stream: false }));
    if (body.length > 128 * 1024) throw aiFailure('AI_LIMIT');
    if (signal.aborted) throw aiFailure('AI_INTERRUPTED');
    const controller = new AbortController();
    const abort = () => controller.abort();
    signal.addEventListener('abort', abort, { once: true });
    const timeout = setTimeout(abort, AI_REQUEST_TIMEOUT_MS);
    let rejectAbort: (() => void) | undefined;
    try {
      const aborted = new Promise<never>((_, reject) => {
        rejectAbort = () => reject(aiFailure('AI_INTERRUPTED'));
        controller.signal.addEventListener('abort', rejectAbort, { once: true });
      });
      // Deadline includes DNS; validate every returned address and pin the connection, retaining Host/SNI.
      const addresses = await Promise.race([
        isIP(host) ? Promise.resolve([{ address: host, family: isIP(host) }]) : this.resolveHost(host), aborted,
      ]);
      if (!addresses.length || addresses.length > 64 || addresses.some(a => !isIP(a.address) || a.family !== isIP(a.address))
        || !this.environment.allowHosts.includes(host) && addresses.some(a => !publicAddress(a.address))) throw aiFailure('AI_DESTINATION');
      const address = addresses[0];
      const bytes = await Promise.race([new Promise<Buffer>((resolve, reject) => {
        if (controller.signal.aborted) { reject(aiFailure('AI_INTERRUPTED')); return; }
        const request = (url.protocol === 'https:' ? https : http).request(url, {
          method: 'POST', agent: false, signal: controller.signal,
          lookup: ((_host: string, options: { all?: boolean }, callback: (...args: any[]) => void) =>
            options.all ? callback(null, [address]) : callback(null, address.address, address.family)) as any,
          headers: { Authorization: `Bearer ${config.apiKey}`, 'Content-Type': 'application/json', Accept: 'application/json', 'Accept-Encoding': 'identity', 'Content-Length': body.length },
        }, response => {
          // All redirects are refused. Neither credential nor article text is sent to a second destination.
          if (response.statusCode !== 200 || !/^application\/json(?:\s*;|$)/i.test(String(response.headers['content-type'] ?? ''))
            || !['', 'identity'].includes(String(response.headers['content-encoding'] ?? ''))
            || Number(response.headers['content-length'] ?? 0) > AI_RESPONSE_BYTES) {
            reject(aiFailure('AI_PROVIDER')); response.destroy(); return;
          }
          let length = 0; const chunks: Buffer[] = [];
          response.on('data', (chunk: Buffer) => {
            length += chunk.length;
            // destroy() can emit aborted synchronously; settle the validation failure first.
            if (length > AI_RESPONSE_BYTES) { reject(aiFailure('AI_OUTPUT')); response.destroy(); }
            else chunks.push(chunk);
          });
          response.on('end', () => resolve(Buffer.concat(chunks)));
          response.on('aborted', () => reject(aiFailure('AI_INTERRUPTED')));
          response.on('error', () => reject(aiFailure('AI_INTERRUPTED')));
        });
        request.on('error', () => reject(aiFailure('AI_INTERRUPTED')));
        request.end(body);
      }), aborted]);
      try {
        const result = JSON.parse(new TextDecoder('utf-8', { fatal: true }).decode(bytes));
        const choice = result.choices?.[0];
        if (result.choices?.length !== 1 || choice?.finish_reason !== 'stop' || typeof choice?.message?.content !== 'string'
          || choice.message.refusal || choice.message.tool_calls) throw new Error();
        return choice.message.content;
      } catch { throw aiFailure('AI_OUTPUT'); }
    } catch (error) {
      // No Node request/TLS/parser exception (which can contain credentials or bodies) escapes.
      throw safeAiError(error);
    } finally {
      clearTimeout(timeout); signal.removeEventListener('abort', abort);
      if (rejectAbort) controller.signal.removeEventListener('abort', rejectAbort);
    }
  }
}

import http from 'node:http';
import type { AddressInfo } from 'node:net';
import type { AiSegment } from '../src/ai-content.js';

export const hostedAiTests = process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted';
export const syntheticAiKey = 'synthetic-ai-fixture-key-not-a-real-credential';
export const englishAiParagraph = 'The researchers carefully examined the historical evidence and explained how the scientific observations support the conclusion while acknowledging the remaining uncertainty about the experiment.';
export interface AiFixtureRequest { authorization?: string; body: { messages: { role: string; content: string }[]; max_tokens: number } }
export async function aiFixture() {
  if (!hostedAiTests) throw new Error('Synthetic provider execution requires approved GitHub-hosted CI');
  const requests: AiFixtureRequest[] = [];
  let behavior: 'ok' | 'missing' | 'truncated' | 'error' | 'redirect' | 'drop' | 'hold' | 'oversize' | 'malformed' = 'ok';
  let redirect = '', release: (() => void) | undefined;
  const server = http.createServer(async (request, response) => {
    const chunks: Buffer[] = [];
    for await (const chunk of request) chunks.push(Buffer.from(chunk));
    const body = JSON.parse(Buffer.concat(chunks).toString());
    requests.push({ authorization: request.headers.authorization, body });
    const send = () => {
      if (behavior === 'error') { response.writeHead(500, { 'content-type': 'application/json' }).end(JSON.stringify({ error: `${syntheticAiKey}: synthetic provider private error` })); return; }
      if (behavior === 'redirect') { response.writeHead(307, { location: redirect }).end(); return; }
      if (behavior === 'drop') { response.destroy(); return; }
      if (behavior === 'oversize') { response.writeHead(200, { 'content-type': 'application/json', 'content-length': 512 * 1024 + 1 }).end('x'); return; }
      if (behavior === 'malformed') { response.writeHead(200, { 'content-type': 'application/json' }).end('{broken JSON'); return; }
      const test = body.messages[1].content === 'Connectivity test.';
      const segments: AiSegment[] = test ? [] : JSON.parse(body.messages[1].content).segments;
      const summary = !test && body.messages[0].content.startsWith('Summarize');
      const output = test ? { ok: true } : summary
        ? { coveredIds: segments.map(s => s.id), summaryText: segments.map(s => s.text.includes('TAIL-MARKER') ? 'TAIL-MARKER' : 'Evidence considered').join('; ') }
        : { segments: segments.map(s => ({ id: s.id, text: `译文 ${s.text}` })) };
      if (behavior === 'missing' && !test) {
        if ('segments' in output) output.segments!.pop();
        else if ('coveredIds' in output) output.coveredIds!.pop();
      }
      response.writeHead(200, { 'content-type': 'application/json' }).end(JSON.stringify({ choices: [{ finish_reason: behavior === 'truncated' ? 'length' : 'stop', message: { content: JSON.stringify(output) } }] }));
    };
    if (behavior === 'hold') release = send; else send();
  });
  await new Promise<void>(resolve => server.listen(0, '127.0.0.1', resolve));
  return {
    baseUrl: `http://127.0.0.1:${(server.address() as AddressInfo).port}/v1`, requests,
    setBehavior(value: typeof behavior, destination = '') { behavior = value; redirect = destination; },
    release() { release?.(); release = undefined; },
    async close() { server.closeAllConnections(); await new Promise<void>((resolve, reject) => server.close(error => error ? reject(error) : resolve())); },
  };
}

import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { aiEnvironmentFromEnv, encryptAiKey, decryptAiKey, safeAiError } from '../src/ai-security.js';
import { PinnedAiProvider } from '../src/ai-provider.js';
import { aiFixture, hostedAiTests, syntheticAiKey } from './ai-fixture.js';

const hasCode = (code: string) => (error: any) => error.code === code;
test('ai-security: optional environment fails closed independently of RSS/session secrets', () => {
  assert.equal(aiEnvironmentFromEnv({}).encryptionKey, undefined);
  assert.equal(aiEnvironmentFromEnv({ AI_ENCRYPTION_KEY: 'invalid' }).encryptionKey, undefined);
  const key = randomBytes(32).toString('base64');
  assert.deepEqual(aiEnvironmentFromEnv({ AI_ENCRYPTION_KEY: key }).encryptionKey, Buffer.from(key, 'base64'));
  assert.deepEqual(aiEnvironmentFromEnv({ AI_ALLOW_HOSTS: '*.example.invalid,127.0.0.1' }).allowHosts, []);
  assert.deepEqual(aiEnvironmentFromEnv({ AI_ALLOW_HOSTS: 'LOCALHOST,127.0.0.1,::1' }).allowHosts, ['localhost', '127.0.0.1', '::1']);
  assert.throws(() => encryptAiKey(undefined, 'owner', 1, syntheticAiKey), hasCode('AI_UNAVAILABLE'));
});
test('ai-security: encrypted at rest, random nonces, owner/version AAD, tamper and wrong deployment key refusal', () => {
  const key = randomBytes(32), one = encryptAiKey(key, 'owner-a', 1, syntheticAiKey), two = encryptAiKey(key, 'owner-a', 1, syntheticAiKey);
  assert.notEqual(one, two); assert.ok(!one.includes(syntheticAiKey));
  assert.equal(decryptAiKey(key, 'owner-a', 1, one), syntheticAiKey);
  assert.throws(() => decryptAiKey(key, 'owner-b', 1, one), hasCode('AI_SECRET'));
  assert.throws(() => decryptAiKey(key, 'owner-a', 2, one), hasCode('AI_SECRET'));
  assert.throws(() => decryptAiKey(randomBytes(32), 'owner-a', 1, one), hasCode('AI_SECRET'));
  const tampered = one.split('.'); tampered[2] = Buffer.from('tampered').toString('base64');
  assert.throws(() => decryptAiKey(key, 'owner-a', 1, tampered.join('.')), hasCode('AI_SECRET'));
  const error = safeAiError(new Error(`Bearer ${syntheticAiKey}: private provider body`));
  assert.equal(error.code, 'AI_INTERRUPTED'); assert.ok(!JSON.stringify(error).includes(syntheticAiKey));
});
test('ai-provider: public HTTPS only, exact operator exceptions, every DNS address validated', async () => {
  const provider = new PinnedAiProvider({ allowHosts: [] }, async () => [{ address: '127.0.0.1', family: 4 }]);
  for (const url of ['http://example.invalid/v1', 'https://user:secret@example.invalid/v1', 'https://example.invalid/v1?key=secret', 'https://example.invalid:9000/v1', 'https://127.0.0.1/v1']) {
    assert.throws(() => provider.validate(url), hasCode('AI_DESTINATION'));
  }
  await assert.rejects(() => provider.complete({ baseUrl: 'https://example.invalid/v1', model: 'fixture', apiKey: syntheticAiKey }, [], new AbortController().signal), hasCode('AI_DESTINATION'));
  const mixed = new PinnedAiProvider({ allowHosts: [] }, async () => [{ address: '93.184.216.34', family: 4 }, { address: '::ffff:127.0.0.1', family: 6 }]);
  await assert.rejects(() => mixed.complete({ baseUrl: 'https://example.invalid/v1', model: 'fixture', apiKey: syntheticAiKey }, [], new AbortController().signal), hasCode('AI_DESTINATION'));
  const allowed = new PinnedAiProvider({ allowHosts: ['fixture.example.invalid'] });
  assert.equal(allowed.validate('http://fixture.example.invalid:9000/v1').port, '9000');
  assert.throws(() => allowed.validate('http://sub.fixture.example.invalid:9000/v1'), hasCode('AI_DESTINATION'));
  const stalledDns = new PinnedAiProvider({ allowHosts: [] }, () => new Promise(() => {}));
  const controller = new AbortController();
  const pending = stalledDns.complete({ baseUrl: 'https://example.invalid/v1', model: 'fixture', apiKey: syntheticAiKey }, [], controller.signal);
  controller.abort(); await assert.rejects(() => pending, hasCode('AI_INTERRUPTED'));
});
test('ai-provider: pinned fresh DNS, no redirect leakage, output truncation, safe failures, abort and lost outcomes', { skip: !hostedAiTests }, async () => {
  const fixture = await aiFixture(), recipient = await aiFixture();
  let lookups = 0;
  const baseUrl = fixture.baseUrl.replace('127.0.0.1', 'fixture.example.invalid');
  const provider = new PinnedAiProvider({ allowHosts: ['fixture.example.invalid'] }, async () => { lookups++; return [{ address: '127.0.0.1', family: 4 }]; });
  const config = { baseUrl, model: 'fixture', apiKey: syntheticAiKey };
  const messages = [{ role: 'system' as const, content: 'Return JSON' }, { role: 'user' as const, content: 'Connectivity test.' }];
  try {
    assert.equal(await provider.complete(config, messages, new AbortController().signal), '{"ok":true}');
    assert.equal(await provider.complete(config, messages, new AbortController().signal), '{"ok":true}');
    assert.equal(lookups, 2); assert.equal(fixture.requests[0].authorization, `Bearer ${syntheticAiKey}`);
    fixture.setBehavior('redirect', recipient.baseUrl);
    await assert.rejects(() => provider.complete(config, messages, new AbortController().signal), hasCode('AI_PROVIDER'));
    assert.equal(recipient.requests.length, 0);
    fixture.setBehavior('truncated');
    await assert.rejects(() => provider.complete(config, messages, new AbortController().signal), hasCode('AI_OUTPUT'));
    fixture.setBehavior('oversize');
    await assert.rejects(() => provider.complete(config, messages, new AbortController().signal), hasCode('AI_PROVIDER'));
    fixture.setBehavior('malformed');
    await assert.rejects(() => provider.complete(config, messages, new AbortController().signal), hasCode('AI_OUTPUT'));
    fixture.setBehavior('error');
    await assert.rejects(() => provider.complete(config, messages, new AbortController().signal), (error: any) => error.code === 'AI_PROVIDER' && !error.message.includes(syntheticAiKey) && !error.message.includes('private'));
    fixture.setBehavior('drop'); const count = fixture.requests.length;
    await assert.rejects(() => provider.complete(config, messages, new AbortController().signal), hasCode('AI_INTERRUPTED'));
    assert.equal(fixture.requests.length, count + 1, 'ambiguous POST must not be retried');
    fixture.setBehavior('hold');
    const controller = new AbortController(), pending = provider.complete(config, messages, controller.signal);
    controller.abort(); await assert.rejects(() => pending, hasCode('AI_INTERRUPTED'));
  } finally { await fixture.close(); await recipient.close(); }
});

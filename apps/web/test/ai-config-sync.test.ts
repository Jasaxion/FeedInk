import assert from 'node:assert/strict';
import test from 'node:test';
import { isNewAiConfigRevision } from '../src/aiConfigSync';
import { aiRequestError } from '../src/aiIdentity';
import { HttpError } from '../src/api';

test('isNewAiConfigRevision scopes invalidation to newer integer revisions for this owner', () => {
  assert.equal(isNewAiConfigRevision({ owner: 'alice', revision: 2 }, 'alice', 1), true);
  for (const value of [null, {}, { owner: 'bob', revision: 2 }, { owner: 'alice', revision: 1 }, { owner: 'alice', revision: 0 }, { owner: 'alice', revision: 1.5 }, { owner: 'alice', revision: '2' }]) assert.equal(isNewAiConfigRevision(value, 'alice', 1), false);
});
test('aiRequestError safely distinguishes interruption and admission configuration changes', () => {
  const secret = 'provider body must never be displayed';
  assert.match(aiRequestError(new HttpError(409, secret, 'AI_INTERRUPTED')), /可能产生费用/);
  assert.match(aiRequestError(new HttpError(409, secret, 'AI_CONFIG_CHANGED')), /未发送模型请求/);
  for (const code of ['AI_INTERRUPTED', 'AI_CONFIG_CHANGED', 'UNKNOWN']) assert.ok(!aiRequestError(new HttpError(409, secret, code)).includes(secret));
});

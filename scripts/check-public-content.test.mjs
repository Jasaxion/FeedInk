import test from 'node:test';
import assert from 'node:assert/strict';
import { inspectPublicText } from './check-public-content.mjs';

test('credential-like values are reported without echoing them', () => {
  const value = 'ghp_' + 'x'.repeat(36);
  const findings = inspectPublicText('sample.txt', `first\n${value}`);
  assert.deepEqual(findings, [{ file: 'sample.txt', line: 2, rule: 'github-token' }]);
  assert.equal(JSON.stringify(findings).includes(value), false);
});

test('application access tokens are caught without embedding one in source', () => {
  const token = 'fi_mcp_' + 'x'.repeat(43);
  const findings = inspectPublicText('sample.txt', token);
  assert.equal(findings[0].rule, 'feedink-access-token');
  assert.equal(JSON.stringify(findings).includes(token), false);
});

test('machine-specific paths and private environment files are rejected', () => {
  const path = ['', 'Users', 'example', 'notes.txt'].join('/');
  assert.equal(inspectPublicText('sample.txt', path)[0].rule, 'machine-path');
  assert.equal(inspectPublicText('.env', 'SETTING=value')[0].rule, 'private-environment-file');
  assert.deepEqual(inspectPublicText('.env.example', 'SETTING=REPLACE_ME'), []);
});

test('generic documentation and application API paths are not personal machine paths', () => {
  assert.deepEqual(inspectPublicText('sample.md', '/api/admin/users/123\n$HOME/work\n/data/archive'), []);
});

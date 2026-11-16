import assert from 'node:assert/strict';
import test from 'node:test';
import { progressAt } from '../src/logic';
import { originalProgressAt, originalScrollTop } from '../src/readingProgress';

const block = { top: 100, height: 2024 }; // includes the card's 24px bottom margin

test('originalProgressAt retains old progress semantics without AI', () => {
  for (const [top, height, viewport] of [[0, 400, 800], [100, 1000, 500], [-30, 1000, 500], [2000, 1000, 500]]) {
    assert.equal(originalProgressAt(top, height, viewport, { top: 0, height: 0 }), progressAt(top, height, viewport));
  }
});
test('originalProgressAt removes only the traversed AI content and margins', () => {
  const height = 1500 + block.height;
  assert.equal(originalProgressAt(50, height, 500, block), 0.05);
  for (const top of [100, 600, 2110, 2124]) assert.equal(originalProgressAt(top, height, 500, block), 0.1);
  assert.equal(originalProgressAt(500 + block.height, height, 500, block), 0.5);
  assert.equal(originalProgressAt(1000 + block.height, height, 500, block), 1);
});
test('originalScrollTop restores original positions with and without a transient block', () => {
  assert.equal(originalScrollTop(0.05, 1500 + block.height, 500, block), 50);
  assert.equal(originalScrollTop(0.5, 1500 + block.height, 500, block), 500 + block.height);
  assert.equal(originalScrollTop(0.5, 1500, 500, { top: 0, height: 0 }), 500);
  assert.equal(originalScrollTop(1, 400, 800, { top: 0, height: 0 }), 0);
});

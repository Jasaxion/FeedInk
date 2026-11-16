import test from 'node:test';
import assert from 'node:assert/strict';
import { isSafeArticleCss } from '@feedink/shared';
import { settingsPatch } from '../src/validation.js';

test('article CSS uses one restricted grammar for API and browser, including legacy declarations', () => {
  for (const css of ['', 'color:#123456; line-height:1.8', 'p { letter-spacing:1px } img { padding:40px }', 'h2, h3 { font-family:"Noto Sans"; margin-bottom:1em }']) {
    assert.equal(isSafeArticleCss(css), true, css);
    assert.equal(settingsPatch.safeParse({ customCss: css }).success, true, css);
  }
  for (const css of ['@import "https://example.invalid/x";', 'p { background-color:url(https://example.invalid/x) }', 'body { color:red }', '#app { color:red }', 'p { position:fixed }', 'p { color:var(--secret) }', 'p { color:red } unexpected', 'p { color:red; font-family:u/**/rl(x) }', 'p { color:red }<script>']) {
    assert.equal(isSafeArticleCss(css), false, css);
    assert.equal(settingsPatch.safeParse({ customCss: css }).success, false, css);
  }
});

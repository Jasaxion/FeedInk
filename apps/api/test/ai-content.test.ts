import { test } from 'node:test';
import assert from 'node:assert/strict';
import * as cheerio from 'cheerio';
import { JSDOM } from 'jsdom';
import { francAll } from 'franc';
import { assertAiCredentialAbsent } from '../src/ai-security.js';
import { prepareAiDocument, splitAiText, segmentBatches, validateTranslations, validateSummary, detectAiLanguage, assertAiDecodedCredentialAbsent, assertAiResultCredentialAbsent } from '../src/ai-content.js';
import { englishAiParagraph, hostedAiTests } from './ai-fixture.js';
import { supportedAiLanguageSamples, unsupportedAiLanguageSamples, englishAiBoundedSentence, englishAiLongSentence, shortEnglishAiRemainder, shortForeignAiFragments } from './ai-language-fixture.js';

const hasCode = (code: string) => (error: any) => error.code === code;
test('ai-content: long individual nodes beyond 14k, title, captions and image metadata have full segment coverage', () => {
  const long = `${englishAiParagraph.repeat(100)} TAIL-MARKER`, image = '11111111-1111-4111-8111-111111111111';
  const html = `<p class="feedink-ai-target">${long}</p><figure><img src="/api/assets/${image}" alt="Image description"><figcaption>Caption prose</figcaption></figure><pre><code>do_not_translate()</code></pre>`;
  const doc = prepareAiDocument(html, 'Original title', 'translate');
  assert.ok(long.length > 14000);
  const corpus = doc.segments.map(s => s.text).join('');
  assert.ok(corpus.includes(long)); assert.ok(corpus.includes('Original title')); assert.ok(corpus.includes('Caption prose')); assert.ok(corpus.includes('Image description'));
  assert.ok(!corpus.includes('do_not_translate'));
  assert.ok(doc.segments.every(s => s.text.length <= 1200));
  assert.equal(segmentBatches(doc.segments).flat().length, doc.segments.length);
  const values = new Map(doc.segments.map(s => [s.id, `Translation: ${s.text}`]));
  const result = doc.render(values, 'zh-CN'), $ = cheerio.load(result);
  assert.ok($('.feedink-ai-pair').length >= 3);
  assert.equal($('.feedink-ai-pair > .feedink-ai-source > p').first().text(), long);
  assert.ok($('.feedink-ai-target').text().includes('TAIL-MARKER'));
  assert.ok($('img').toArray().every(node => $(node).attr('src') === `/api/assets/${image}`));
  assert.equal($('pre').text(), 'do_not_translate()');
  assert.ok($('[class]').toArray().every(node => ['feedink-ai-pair', 'feedink-ai-source', 'feedink-ai-target'].includes($(node).attr('class')!)));
});
test('ai-content: bilingual pairs are paragraph-level, text-only and keep trusted links without ink anchors', () => {
  const doc = prepareAiDocument('<p id="ink-anchor">First <a href="https://example.invalid/source">paragraph</a></p><p>Second paragraph</p><ul><li>List prose</li></ul><table><tbody><tr><td>Cell prose</td></tr></tbody></table>', 'Title', 'translate');
  const attack = '<img src="https://attacker.invalid/x" onerror="alert(1)">[bad](javascript:alert(1))';
  const html = doc.render(new Map(doc.segments.map(s => [s.id, attack])), 'en'), $ = cheerio.load(html);
  assert.equal($('script,img,[onerror],[id]').length, 0);
  assert.ok($('.feedink-ai-target').first().text().includes(attack));
  assert.equal($('.feedink-ai-source > p').length, 2);
  assert.equal($('.feedink-ai-target > p').length, 2);
  assert.equal($('a[href="https://example.invalid/source"]').length, 2);
  assert.equal($('li > section.feedink-ai-pair').length, 1);
  assert.equal($('td > section.feedink-ai-pair').length, 1);
  assert.equal($('[data-ink-anchor]').length, 0);
});
test('ai-content: missing, duplicate, invented IDs and invalid/truncated JSON never count as complete', () => {
  const batch = [{ id: 'a', text: 'First source' }, { id: 'b', text: 'Second source' }];
  for (const segments of [[{ id: 'a', text: 'first' }], [{ id: 'a', text: 'first' }, { id: 'a', text: 'again' }], [{ id: 'a', text: 'first' }, { id: 'invented', text: 'other' }]]) {
    assert.throws(() => validateTranslations(JSON.stringify({ segments }), batch), hasCode('AI_OUTPUT'));
  }
  assert.throws(() => validateTranslations('{"segments":', batch), hasCode('AI_OUTPUT'));
  assert.throws(() => validateSummary(JSON.stringify({ coveredIds: ['a'], summaryText: 'Incomplete' }), batch), hasCode('AI_OUTPUT'));
  assert.throws(() => validateSummary(JSON.stringify({ coveredIds: ['a', 'a'], summaryText: 'Duplicate' }), batch), hasCode('AI_OUTPUT'));
  assert.equal(validateSummary(JSON.stringify({ coveredIds: ['a', 'b'], summaryText: 'Both covered' }), batch), 'Both covered');
  const doc = prepareAiDocument('<p>Prose</p>', 'Title', 'translate');
  assert.throws(() => doc.render(new Map(), 'en'), hasCode('AI_OUTPUT'));
  assert.throws(() => prepareAiDocument(`<p>${'x'.repeat(2 * 1024 * 1024)}</p>`, '', 'translate'), hasCode('AI_LIMIT'));
});
test('ai-content: conservative same-language consensus; short, mixed and unknown input does not skip', () => {
  assert.equal(detectAiLanguage([{ id: 'a', text: englishAiParagraph }]), 'en');
  assert.equal(detectAiLanguage([{ id: 'a', text: 'Hello' }]), 'unknown');
  assert.equal(detectAiLanguage([{ id: 'a', text: '1234!? ' }]), 'unknown');
  assert.notEqual(detectAiLanguage([{ id: 'a', text: englishAiParagraph }, { id: 'b', text: '这是另一种语言的文本，不能忽略这一部分。' }]), 'en');
  assert.notEqual(detectAiLanguage([{ id: 'a', text: `${englishAiParagraph} 日本語` }]), 'en');
  assert.notEqual(detectAiLanguage([{ id: 'a', text: englishAiParagraph }, { id: 'b', text: 'Les chercheurs ont soigneusement examiné les preuves historiques et expliqué les conclusions de cette expérience scientifique avec toutes les limites importantes.' }]), 'en');
});
test('ai-content detectAiLanguage: ordinary supported prose and independently agreeing short titles', () => {
  for (const { language, paragraph, title } of supportedAiLanguageSamples) {
    assert.equal(detectAiLanguage([{ id: 'paragraph', text: paragraph }]), language, `${language} paragraph`);
    assert.ok((title.match(/\p{L}/gu)?.length ?? 0) < 40);
    assert.equal(detectAiLanguage([{ id: 'title', text: title }]), 'unknown', `${language} title needs an anchor`);
    assert.equal(detectAiLanguage(prepareAiDocument(`<p>${paragraph}</p>`, title, 'translate').segments), language, `${language} title with body`);
    assert.equal(detectAiLanguage([{ id: 'body', text: paragraph }, { id: 'caption', text: title }]), language, `${language} short caption after body`);
  }
});
test('ai-content detectAiLanguage: bounded sentences and complete long-window remainders', () => {
  assert.ok(englishAiBoundedSentence.length > 240 && englishAiBoundedSentence.length < 480);
  assert.ok((englishAiBoundedSentence.slice(240).match(/\p{L}/gu)?.length ?? 0) < 40);
  assert.equal(detectAiLanguage([{ id: 'bounded', text: englishAiBoundedSentence }]), 'en');
  assert.ok(englishAiLongSentence.length > 480);
  assert.equal(detectAiLanguage([{ id: 'long', text: englishAiLongSentence }]), 'en');
  // Boundary padding exercises a short final window without depending on a particular word's length.
  const prefix = englishAiParagraph.slice(0, -1).padEnd(480, ' ');
  assert.equal(detectAiLanguage([{ id: 'tail', text: prefix + shortEnglishAiRemainder }]), 'en');
  for (const { name, text } of shortForeignAiFragments) {
    assert.notEqual(detectAiLanguage([{ id: 'tail', text: prefix + text }]), 'en', `${name} trailing window`);
    assert.notEqual(detectAiLanguage([{ id: 'tail', text: `${englishAiParagraph} ${text}` }]), 'en', `${name} trailing sentence`);
  }
  for (const text of ['oui', 'ja', '日本語', 'Ж', 'xqz']) {
    assert.equal(detectAiLanguage([{ id: 'tail', text: prefix + text }]), 'unknown', 'tiny remainders cannot inherit English');
  }
});
test('ai-content detectAiLanguage: open-set unsupported prose, multilingual consensus and explicit ambiguity', () => {
  const english = [{ id: 'en', text: englishAiParagraph }];
  for (const { name, paragraph } of unsupportedAiLanguageSamples) {
    assert.equal(detectAiLanguage([{ id: 'unsupported', text: paragraph }]), 'unknown', name);
    assert.equal(detectAiLanguage([...english, { id: 'unsupported', text: paragraph }]), 'unknown', `${name} must veto English`);
  }
  for (const { language, paragraph } of supportedAiLanguageSamples.filter(sample => sample.language !== 'en')) {
    assert.equal(detectAiLanguage([...english, { id: language, text: paragraph }]), 'mixed', `${language} and English`);
    assert.equal(detectAiLanguage([{ id: 'multilingual', text: `${englishAiParagraph} ${paragraph}` }]), 'mixed', `${language} and English sentences in one segment`);
  }
  for (const { name, text } of shortForeignAiFragments) {
    for (const fragments of [[{ id: 'foreign-title', text }, ...english], [...english, { id: 'foreign-caption', text }]]) {
      assert.notEqual(detectAiLanguage(fragments), 'en', `${name} short segment must not be overruled by context`);
    }
  }
  for (const text of ['', '1234!? 🙂', 'Menu', 'Radio', 'Gift', 'Hello', 'qxzv jqxv zqxx vjxz qzvx xzqj vqxz xjqv zqxv qjzx vxqz jxvq']) {
    assert.equal(detectAiLanguage([{ id: 'ambiguous', text }]), 'unknown');
  }
  for (const text of ['Menu', 'Radio', 'Gift', 'xqz']) {
    assert.equal(detectAiLanguage([{ id: 'title', text }, ...english]), 'unknown', 'ambiguous title remains explicit');
  }
  // A minority script outside the old Latin/Han/kana/Hangul checklist must also veto skipping.
  for (const script of ['Ж', 'ع', 'א', 'अ', '𐐀', '日本語']) {
    assert.equal(detectAiLanguage([{ id: 'mixed-script', text: `${englishAiParagraph.slice(0, -1)} ${script}.` }]), 'unknown');
  }
});
test('ai-content detectAiLanguage: late segments and metadata beyond 14k are never dropped', () => {
  const body = `<p>${englishAiParagraph}</p>`.repeat(100);
  assert.equal(detectAiLanguage(prepareAiDocument(body, englishAiParagraph, 'translate').segments), 'en', 'baseline must skip before adding foreign/ambiguous late text');
  for (const tail of ['Les résultats de la recherche', 'これは日本語です', 'Menu']) {
    const doc = prepareAiDocument(`${body}<p>${tail}</p>`, englishAiParagraph, 'translate');
    assert.ok(doc.segments.map(segment => segment.text).join('').length > 14000);
    assert.notEqual(detectAiLanguage(doc.segments), 'en', 'late body segment');
    for (const attribute of ['alt', 'title']) {
      const image = prepareAiDocument(`${body}<img ${attribute}="${tail}">`, englishAiParagraph, 'translate');
      assert.notEqual(detectAiLanguage(image.segments), 'en', `late ${attribute} attribute`);
    }
  }
});
test('ai-content detectAiLanguage: synthetic ranked-score diagnostics (hosted only, no article logging)', { skip: !hostedAiTests }, t => {
  const samples = [
    ...supportedAiLanguageSamples.flatMap(({ language, paragraph, title }) => [
      { name: `${language}-paragraph`, text: paragraph }, { name: `${language}-title`, text: title },
      { name: `${language}-title-context`, text: `${title}\n${paragraph}` },
    ]),
    ...unsupportedAiLanguageSamples.map(({ name, paragraph }) => ({ name: `${name}-unsupported`, text: paragraph })),
    ...shortForeignAiFragments.map(({ name, text }) => ({ name: `${name}-short-foreign`, text })),
    { name: 'en-bounded-sentence', text: englishAiBoundedSentence },
    { name: 'en-old-240-tail', text: englishAiBoundedSentence.slice(240) },
    { name: 'en-long-sentence', text: englishAiLongSentence },
    { name: 'en-raw-480-tail', text: englishAiLongSentence.slice(480) },
    { name: 'en-short-remainder', text: shortEnglishAiRemainder },
    { name: 'en-fr-same-script-switch', text: `${englishAiParagraph} ${supportedAiLanguageSamples.find(sample => sample.language === 'fr')!.paragraph}` },
    { name: 'ambiguous-short-heading', text: 'Menu' },
    { name: 'invented-letter-sequences', text: 'qxzv jqxv zqxx vjxz qzvx xzqj vqxz xjqv zqxv qjzx vxqz jxvq' },
  ];
  for (const { name, text } of samples) {
    t.diagnostic(JSON.stringify({ fixture: name, characters: text.length, letters: text.match(/\p{L}/gu)?.length ?? 0,
      ranked: francAll(text, { minLength: 12 }).slice(0, 5) }));
  }
});
test('ai-content: Unicode splitting is lossless and summary includes code as well as late content', () => {
  const text = '𠮷🙂é'.repeat(5000);
  const parts = splitAiText(text);
  assert.equal(parts.join(''), text); assert.ok(parts.every(part => !/^[\uDC00-\uDFFF]|[\uD800-\uDBFF]$/.test(part)));
  const doc = prepareAiDocument(`<p>${englishAiParagraph.repeat(100)}</p><pre><code>final_code()</code></pre><p>TAIL-MARKER conclusion</p>`, 'Summary title', 'summary');
  assert.ok(doc.segments.some(s => s.text.includes('final_code()')));
  assert.ok(doc.segments.some(s => s.text.includes('TAIL-MARKER')));
});
test('ai-content: disclosure labels keep one direct-child summary with bilingual phrasing and activation', () => {
  const doc = prepareAiDocument('<details><summary><strong>Important</strong> caveats</summary><p>Body text</p><summary>Additional caveats</summary></details>', 'Title', 'translate');
  const html = doc.render(new Map(doc.segments.map(s => [s.id, `Translated ${s.text}`])), 'zh-CN');
  const dom = new JSDOM(html), details = dom.window.document.querySelector('details')!;
  try {
    const summary = details.querySelector(':scope > summary')!;
    assert.equal(details.querySelectorAll(':scope > summary').length, 1);
    assert.equal(details.querySelectorAll('section summary,div summary').length, 0);
    assert.equal(summary.querySelectorAll('section,div,p,h1,h2').length, 0);
    assert.equal(summary.querySelector('span.feedink-ai-source')!.textContent, 'Important caveats');
    assert.match(summary.querySelector('span.feedink-ai-target')!.textContent!, /Translated Important/);
    assert.equal(summary.querySelector('span.feedink-ai-target')!.getAttribute('lang'), 'zh-CN');
    assert.ok(details.textContent!.includes('Additional caveats'));
    assert.equal(details.querySelectorAll('section.feedink-ai-pair > div.feedink-ai-source > p').length, 1);
    assert.equal(details.open, false); (summary as HTMLElement).click(); assert.equal(details.open, true);
    (summary as HTMLElement).click(); assert.equal(details.open, false);
  } finally { dom.window.close(); }
});
test('ai-content: decoded escapes, source-ordered joins, visible lanes and translated metadata reject literal credentials', () => {
  const credential = 'synthetic&credential', escaped = [...credential].map(c => `\\u${c.charCodeAt(0).toString(16).padStart(4, '0')}`).join('');
  for (const output of [`{"coveredIds":["s0"],"summaryText":"${escaped}"}`, `{"segments":[{"id":"s0","text":"${escaped}"}]}`]) {
    assert.ok(!output.includes(credential));
    assert.throws(() => assertAiDecodedCredentialAbsent(output, credential), hasCode('AI_OUTPUT'));
  }
  assert.throws(() => assertAiCredentialAbsent(['synthetic', '&cred', 'ential'], credential), hasCode('AI_OUTPUT'));
  const source = { sourceTitle: 'Title', sourceUrl: 'https://example.invalid' };
  for (const bilingualHtml of [
    '<div class="feedink-ai-target">synthetic&amp;<b>credential</b></div>',
    '<div class="feedink-ai-target">synthetic&amp;</div><div class="feedink-ai-source">original</div><div class="feedink-ai-target">credential</div>',
    '<img alt="synthetic&amp;credential">',
    '<div class="feedink-ai-target"><a title="synthetic&amp;">label</a></div><div class="feedink-ai-target"><a title="credential">label</a></div>',
  ]) assert.throws(() => assertAiResultCredentialAbsent({ ...source, bilingualHtml }, credential), hasCode('AI_OUTPUT'));
  assert.doesNotThrow(() => assertAiResultCredentialAbsent({ ...source, summaryText: 'Ordinary text' }, credential));
});

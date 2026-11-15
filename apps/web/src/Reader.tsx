import { useEffect, useRef, useState } from 'react';
import type { ArticleDetail, ArticleMode } from '@feedink/shared';
import { useApp } from './context';
import { download, downloadCachedImage, mutate } from './api';
import { AssetImage, Empty, Field, Icon, IconButton, Modal, Toggle, SourceIcon } from './components';
import { formatDate, ownedAssetUrl, progressAt, safeExternalUrl } from './logic';
import { AnnotatedArticle } from './Annotations';
import { retireActiveNotes } from './annotationSync';
import { assertAuthEpoch, authEpoch } from './authEpoch';

export function Reader({ article, mode, setMode, back, move, more, onDetail, scrollRef }: {
  article: ArticleDetail | null; mode: ArticleMode; setMode: (mode: ArticleMode) => void; back: () => void; move: (direction: number) => void; more: () => void; onDetail: (article: ArticleDetail) => void; scrollRef: React.RefObject<HTMLDivElement | null>;
}) {
  const app = useApp(); const settings = app.session.settings;
  const changeMode = (value: ArticleMode) => { const epoch = authEpoch(); void app.task(() => retireActiveNotes(() => { assertAuthEpoch(epoch); setMode(value); })); };
  const latestArticleId = useRef(article?.id); latestArticleId.current = article?.id;
  const progressTimer = useRef<ReturnType<typeof setTimeout> | null>(null);
  const touch = useRef<{ x: number; y: number } | null>(null);
  const [image, setImage] = useState<string | null>(null); const [zoom, setZoom] = useState(1); const [toolbar, setToolbar] = useState(!settings.hideToolbar); const [speech, setSpeech] = useState(false); const [fetching, setFetching] = useState(false);
  useEffect(() => setToolbar(!settings.hideToolbar), [settings.hideToolbar]);
  useEffect(() => setZoom(1), [image]);
  useEffect(() => {
    const id = requestAnimationFrame(() => { const element = scrollRef.current; if (element && article) element.scrollTop = article.progress * Math.max(0, element.scrollHeight - element.clientHeight); });
    return () => { cancelAnimationFrame(id); if (progressTimer.current) clearTimeout(progressTimer.current); };
  }, [article?.id, mode]);
  async function extract() {
    if (!article) return; setFetching(true);
    await app.task(async () => {
      const detail = await mutate<ArticleDetail>(`/articles/${article.id}/fulltext`, 'POST');
      if (latestArticleId.current === detail.id) await retireActiveNotes(() => { if (latestArticleId.current === detail.id) { onDetail(detail); setMode('fulltext'); } });
      await app.cacheArticle(detail);
      if (detail.fulltextError) app.notify(`全文提取未完成：${detail.fulltextError}`, true); else app.notify('全文与可用图片已持久归档');
    }); setFetching(false);
  }
  function scroll() {
    if (!article || !scrollRef.current) return;
    const element = scrollRef.current; const progress = progressAt(element.scrollTop, element.scrollHeight, element.clientHeight);
    if (progressTimer.current) clearTimeout(progressTimer.current);
    progressTimer.current = setTimeout(() => void app.task(() => app.patchArticle(article, { progress })), 700);
  }
  return <main className={`reader-pane ${settings.wrapCode ? 'wrap-code' : ''}`} data-testid="reader" aria-label="文章阅读区">
    {!article ? <Empty title="留一点时间，给阅读"><p>从左侧选择一篇文章</p><small>J / K 切换 · Enter 打开 · ? 快捷键</small></Empty> : <>
      {toolbar ? <header className="reader-toolbar"><IconButton icon="back" label="返回" onClick={back} /><IconButton icon="previous" label="上一篇 (K)" onClick={() => move(-1)} /><IconButton icon="next" label="下一篇 (J)" onClick={() => move(1)} /><span className="toolbar-spacer" />
        <IconButton icon="article" label={fetching ? '正在提取全文' : '提取全文'} aria-pressed={mode === 'fulltext'} disabled={fetching || !app.online} onClick={() => void extract()} />
        <IconButton icon="saved" label="稍后阅读" aria-pressed={article.saved} onClick={() => void app.task(() => app.patchArticle(article, { saved: !article.saved }))} />
        <IconButton icon="tag" label="管理文章标签" className="icon-button desktop-tool" onClick={more} />
        <IconButton icon={article.read ? 'unread' : 'check'} label={article.read ? '标记为未读' : '标记为已读'} className="icon-button desktop-tool" onClick={() => void app.task(() => app.patchArticle(article, { read: !article.read }))} />
        <IconButton icon="more" label="更多文章操作" onClick={more} />
      </header> : <div className="collapsed-toolbar"><IconButton icon="back" label="返回" onClick={back} /><button className="text-button" onClick={() => setToolbar(true)}>显示工具栏</button></div>}
      {!app.online && <div className="reader-offline"><Icon name="offline" size={13} />离线阅读 · 更改将在本账号联网后同步</div>}
      <div className="reader-scroll" ref={scrollRef} tabIndex={0} onScroll={scroll} onTouchStart={event => { const point = event.touches[0]; touch.current = { x: point.clientX, y: point.clientY }; }} onTouchEnd={event => { const start = touch.current; touch.current = null; if (!start || window.getSelection()?.toString()) return; const point = event.changedTouches[0]; if (Math.abs(point.clientY - start.y) < 50 && point.clientX - start.x > 110) back(); }}>
        <article className="article-document"><div className="article-source"><SourceIcon subscriptionId={article.subscriptionId} /><span>{article.feedTitle || '网页存档'}</span></div>
          <h1><a href={safeExternalUrl(article.url) || undefined} target="_blank" rel="noopener noreferrer">{article.title || '无标题文章'}</a></h1>
          <div className="article-meta"><time dateTime={article.publishedAt}>{formatDate(article.publishedAt)}</time>{article.author && <span>· {article.author}</span>}<span>· 约 {Math.max(1, Math.ceil(article.wordCount / 400))} 分钟</span></div>
          <div className="article-mode"><select aria-label="正文模式" value={mode} onChange={event => { const value = event.target.value as ArticleMode; changeMode(value); if (value === 'fulltext' && !article.fulltextHtml && app.online) void extract(); }}><option value="feed">RSS 正文</option><option value="fulltext">归档全文</option><option value="webpage">原网页</option></select><button className="text-button" onClick={() => setSpeech(value => !value)}><Icon name="audio" size={16} />{speech ? '收起朗读' : '朗读'}</button></div>
          {speech && <SpeechPanel article={article} next={() => move(1)} />}
          {mode === 'webpage' ? <section className="original-page"><div className="original-page-actions"><a className="secondary" href={safeExternalUrl(article.url) || undefined} target="_blank" rel="noopener noreferrer">在新标签页打开原文</a><button className="text-button" onClick={() => changeMode('feed')}>返回归档正文</button></div><p className="muted small">原网页在受限沙箱中显示。网站可能拒绝嵌入或需要脚本，此时请使用上方外部打开链接。页面不能导航本应用或读取账号。</p>{app.online && safeExternalUrl(article.url) ? <iframe key={article.url} className="original-frame" title={`原网页：${article.title}`} src={safeExternalUrl(article.url)!} sandbox="" referrerPolicy="no-referrer" /> : <p role="status">离线时原网页不可用，请返回已归档正文。</p>}</section> : <>
            {mode === 'fulltext' && !article.fulltextHtml && <p className="notice">{article.fulltextError || (app.online ? '尚未取得全文，当前显示 RSS 正文。可点击上方“提取全文”重试。' : '此文章的全文尚未缓存，当前显示已缓存的 RSS 正文。')}</p>}
            <AnnotatedArticle key={`${article.id}:${mode}:${mode === 'fulltext' ? article.fulltextHtml : article.contentHtml}`} article={article} mode={mode === 'fulltext' && article.fulltextHtml ? 'fulltext' : 'feed'} onImage={setImage} onTap={() => { if (settings.tapToPage) scrollRef.current?.scrollBy({ top: scrollRef.current.clientHeight * 0.85, behavior: 'instant' }); }} />
          </>}
          {article.enclosures.length > 0 && <section className="enclosures"><h3>播客与附件</h3>{article.enclosures.map((enclosure, index) => { const url = safeExternalUrl(enclosure.url); if (!url) return null; return <div key={index}>{enclosure.type.startsWith('audio/') ? <audio controls preload="none" src={url} aria-label={`播客音频 ${index + 1}`} /> : enclosure.type.startsWith('video/') ? <video controls preload="none" src={url} aria-label={`视频 ${index + 1}`} /> : <a href={url} target="_blank" rel="noopener noreferrer">打开附件 {index + 1} ({enclosure.type})</a>}<small className="muted">媒体由原站提供，未加入离线图片缓存。浏览器支持的格式才能播放。</small></div>; })}</section>}
          <details className="archive-details"><summary><Icon name="archive" size={16} />存档信息 · {article.images.filter(item => item.status === 'cached').length}/{article.images.length} 张图片已在服务器保存</summary><p>正文抓取：{formatDate(article.fetchedAt)}</p><p>首次归档：{formatDate(article.archivedAt)}</p><p className="hash">SHA-256: {article.contentHash}</p>{article.images.map(item => <div className="image-status" key={item.id}><span>{item.status === 'cached' ? '已归档' : item.status === 'failed' ? '抓取失败' : '等待抓取'}</span><span className="truncate">{item.originalUrl}</span>{item.status === 'cached' && ownedAssetUrl(item.url) && <button className="text-button" onClick={() => setImage(item.url)}>查看</button>}</div>)}<button className="secondary" disabled={!app.online} onClick={() => void app.task(async () => { const detail = await mutate<ArticleDetail>(`/articles/${article.id}/retry-images`, 'POST'); await retireActiveNotes(() => { if (latestArticleId.current === detail.id) onDetail(detail); }); await app.cacheArticle(detail); const failed = detail.images.filter(item => item.status !== 'cached').length; app.notify(failed ? `重试完成，仍有 ${failed} 张图片未归档` : '所有图片已归档', failed > 0); })}>重新抓取图片</button><p className="muted small">服务器归档与此设备离线缓存不同。源站限制可能导致部分图片始终无法抓取。</p></details>
          <footer className="article-end"><span>— 读到这里 —</span><button className="secondary" onClick={() => move(1)}>下一篇 <Icon name="next" /></button></footer>
        </article>
      </div>
      <nav className="page-controls" aria-label="阅读翻页"><button onClick={() => scrollRef.current?.scrollBy({ top: -(scrollRef.current.clientHeight * 0.85), behavior: 'instant' })}><Icon name="up" />上一页</button><button onClick={() => { const element = scrollRef.current; if (element && progressAt(element.scrollTop, element.scrollHeight, element.clientHeight) >= 0.99) move(1); else element?.scrollBy({ top: element.clientHeight * 0.85, behavior: 'instant' }); }}>下一页 <Icon name="down" /></button></nav>
    </>}
    {image && <Modal title="图片预览" wide onClose={() => setImage(null)}><div className="image-preview" style={{ '--zoom': zoom } as React.CSSProperties}><AssetImage src={image} alt="归档文章图片" className="zoomed-image" /></div><div className="button-row zoom-controls"><button className="secondary" disabled={zoom <= 0.5} onClick={() => setZoom(value => Math.max(0.5, value - 0.25))}>缩小</button><output aria-live="polite">{Math.round(zoom * 100)}%</output><button className="secondary" disabled={zoom >= 4} onClick={() => setZoom(value => Math.min(4, value + 0.25))}>放大</button><button className="text-button" onClick={() => setZoom(1)}>适应宽度</button></div><button className="primary" onClick={() => void app.task(async () => { const source = await app.store.imageSource(app.session.user.id, image); if (source) downloadCachedImage(source, 'FeedInk-image'); else await download(image, 'FeedInk-image'); })}><Icon name="download" />下载图片</button><p className="muted">可使用浏览器缩放手势放大查看。</p></Modal>}
  </main>;
}

function SpeechPanel({ article, next }: { article: ArticleDetail; next: () => void }) {
  const app = useApp(); const [voices, setVoices] = useState<SpeechSynthesisVoice[]>([]); const [voice, setVoice] = useState(app.session.settings.speechVoice); const [rate, setRate] = useState(app.session.settings.speechRate); const [status, setStatus] = useState<'stopped' | 'speaking' | 'paused'>('stopped'); const [continuous, setContinuous] = useState(false);
  const continueRef = useRef(false); const autoStart = useRef(false); const speakingId = useRef(0);
  const supported = 'speechSynthesis' in window;
  useEffect(() => {
    if (!supported) return;
    const load = () => setVoices(speechSynthesis.getVoices()); load(); speechSynthesis.addEventListener('voiceschanged', load);
    return () => { speakingId.current++; speechSynthesis.cancel(); speechSynthesis.removeEventListener('voiceschanged', load); };
  }, []);
  useEffect(() => { if (!supported) return; speakingId.current++; speechSynthesis.cancel(); setStatus('stopped'); if (autoStart.current) { autoStart.current = false; start(); } }, [article.id]);
  useEffect(() => { continueRef.current = continuous; }, [continuous]);
  function start() {
    if (!supported) return; speechSynthesis.cancel(); const run = ++speakingId.current;
    const text = `${article.title}。${article.contentText}`; const chunks = text.match(/[\s\S]{1,700}/g) || [text];
    let index = 0;
    function speakChunk() {
      if (run !== speakingId.current) return;
      if (index >= chunks.length) { setStatus('stopped'); if (continueRef.current) { autoStart.current = true; next(); } return; }
      const utterance = new SpeechSynthesisUtterance(chunks[index++]); utterance.rate = rate; utterance.lang = 'zh-CN'; utterance.voice = voices.find(item => item.voiceURI === voice) || null;
      utterance.onend = speakChunk; utterance.onerror = event => { if (event.error !== 'canceled' && event.error !== 'interrupted') app.notify(`朗读失败：${event.error}`, true); setStatus('stopped'); };
      speechSynthesis.speak(utterance); setStatus('speaking');
    }
    speakChunk();
  }
  if (!supported) return <p className="notice">当前浏览器不支持 SpeechSynthesis 朗读。</p>;
  return <section className="speech-panel" aria-label="朗读控制"><div className="button-row"><button className="secondary" onClick={() => { if (status === 'speaking') { speechSynthesis.pause(); setStatus('paused'); } else if (status === 'paused') { speechSynthesis.resume(); setStatus('speaking'); } else start(); }}><Icon name={status === 'speaking' ? 'pause' : 'play'} />{status === 'speaking' ? '暂停' : status === 'paused' ? '继续' : '开始朗读'}</button><IconButton icon="stop" label="停止朗读" onClick={() => { speakingId.current++; speechSynthesis.cancel(); setStatus('stopped'); }} /></div><div className="field-grid"><Field label="声音"><select value={voice} onChange={event => { setVoice(event.target.value); void app.task(() => app.updateSettings({ speechVoice: event.target.value })); }}><option value="">系统默认</option>{voices.map(item => <option key={item.voiceURI} value={item.voiceURI}>{item.name} ({item.lang})</option>)}</select></Field><Field label="速度"><input type="range" min="0.5" max="2" step="0.1" value={rate} onChange={event => setRate(Number(event.target.value))} onPointerUp={() => void app.task(() => app.updateSettings({ speechRate: rate }))} onKeyUp={() => void app.task(() => app.updateSettings({ speechRate: rate }))} /><small>{rate} 倍（下次开始生效）</small></Field></div><Toggle label="连续朗读下一篇" checked={continuous} onChange={setContinuous} /></section>;
}

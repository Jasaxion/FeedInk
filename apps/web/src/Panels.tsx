import { useEffect, useState, type FormEvent } from 'react';
import type { ArticleDetail, DiscoveryFeed, DiscoveryResult, Ebook, FeedPreferences, Folder, Subscription, Tag } from '@feedink/shared';
import { api, download, mutate } from './api';
import { useApp } from './context';
import { Empty, Field, Icon, Toggle } from './components';
import { formatDate, safeExternalUrl } from './logic';

export function DiscoveryPanel() {
  const app = useApp(); const [query, setQuery] = useState(''); const [topic, setTopic] = useState(''); const [feeds, setFeeds] = useState<DiscoveryFeed[]>([]); const [folderId, setFolder] = useState(''); const [busy, setBusy] = useState(false); const [searched, setSearched] = useState(false);
  async function search(event?: FormEvent, chosenTopic = topic) { event?.preventDefault(); setBusy(true); await app.task(async () => { const result = await api<DiscoveryResult>(`/discover?${new URLSearchParams({ q: query, topic: chosenTopic })}`); setFeeds(result.feeds); setSearched(true); }); setBusy(false); }
  async function subscribe(url: string, title?: string) { setBusy(true); await app.task(async () => { await mutate('/subscriptions', 'POST', { url, title, folderId: folderId || null }); app.refresh(); app.notify('订阅已添加'); }); setBusy(false); }
  return <section><p className="muted">输入 RSS、Atom、JSON Feed 或网站地址，自动发现可订阅的内容。也可以按主题探索。</p><form onSubmit={search}><Field label="网址或关键字"><div className="input-action"><input autoFocus placeholder="https://example.com/feed 或 科技" value={query} onChange={event => setQuery(event.target.value)} /><button className="primary" disabled={busy || !app.online}><Icon name="search" />查找</button></div></Field></form>
    <div className="chips" aria-label="发现主题">{[['', '全部'], ['technology', '科技'], ['design', '设计'], ['culture', '人文'], ['science', '科学'], ['news', '新闻']].map(([value, title]) => <button key={value} className={topic === value ? 'active' : ''} onClick={() => { setTopic(value); void search(undefined, value); }}>{title}</button>)}</div>
    <Field label="添加到文件夹"><select value={folderId} onChange={event => setFolder(event.target.value)}><option value="">未分类</option>{app.library.folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></Field>
    {busy && <p role="status">正在连接订阅源…</p>}{searched && !busy && feeds.length === 0 && <Empty icon="search" title="未找到订阅源"><p>可尝试完整 RSS 地址，或更换关键字。</p></Empty>}
    {feeds.map(feed => <div className="discovery-row" key={feed.url}><span className="source-icon"><Icon name="rss" /></span><div><h3>{feed.title}</h3><p>{feed.description}</p><small>{feed.url}</small></div><button className="secondary" disabled={busy || app.library.subscriptions.some(sub => sub.url === feed.url)} onClick={() => void subscribe(feed.url, feed.title)}>{app.library.subscriptions.some(sub => sub.url === feed.url) ? '已订阅' : '订阅'}</button></div>)}
    {safeExternalUrl(query) && <button className="secondary" disabled={busy || !app.online} onClick={() => void subscribe(query)}>直接订阅此地址</button>}
    <p className="muted small">RSSHub：粘贴你的 RSSHub 实例生成的完整路由地址即可订阅。实例由你选择，不依赖固定代理。</p>
  </section>;
}

export type OrganizationTarget = { kind: 'subscription'; value: Subscription } | { kind: 'folder'; value?: Folder } | { kind: 'tag'; value?: Tag };
export function OrganizationPanel({ target, close }: { target: OrganizationTarget; close: () => void }) {
  const app = useApp(); const value = target.value;
  const [name, setName] = useState(target.kind === 'subscription' ? target.value.title : target.value?.name || '');
  const [folderId, setFolder] = useState(target.kind === 'subscription' ? target.value.folderId || '' : '');
  const [color, setColor] = useState(target.kind === 'tag' ? target.value?.color || '#861dd4' : '#861dd4');
  const [settings, setSettings] = useState<FeedPreferences>(target.kind === 'tag' ? {} : target.value?.settings || {});
  const [busy, setBusy] = useState(false);
  const route = target.kind === 'subscription' ? '/subscriptions' : target.kind === 'folder' ? '/folders' : '/tags';
  async function save(event: FormEvent) { event.preventDefault(); setBusy(true); await app.task(async () => { await mutate(`${route}${value ? `/${value.id}` : ''}`, value ? 'PATCH' : 'POST', target.kind === 'subscription' ? { title: name, folderId: folderId || null, settings } : target.kind === 'folder' ? { name, ...(value ? { settings } : {}) } : { name, color }); app.refresh(); app.notify('已保存'); close(); }); setBusy(false); }
  async function remove() { if (!value || !confirm(target.kind === 'subscription' ? '取消订阅？已归档文章和图片会保留，可在“全部存档”中阅读。' : '删除此项目？文章不会被删除。')) return; setBusy(true); await app.task(async () => { await mutate(`${route}/${value.id}`, 'DELETE'); app.refresh(); app.notify('已删除整理项目，文章存档保留'); close(); }); setBusy(false); }
  return <form onSubmit={save}><Field label="名称"><input autoFocus required maxLength={200} value={name} onChange={event => setName(event.target.value)} /></Field>
    {target.kind === 'tag' ? <Field label="标签颜色"><input type="color" value={color} onChange={event => setColor(event.target.value)} /></Field> : <>
      {target.kind === 'subscription' && <><Field label="文件夹"><select value={folderId} onChange={event => setFolder(event.target.value)}><option value="">未分类</option>{app.library.folders.map(folder => <option key={folder.id} value={folder.id}>{folder.name}</option>)}</select></Field><p className="url-text">{target.value.url}</p><p className={target.value.status === 'error' ? 'error-box' : 'muted'}>{target.value.lastError || `上次更新：${target.value.lastFetchedAt ? formatDate(target.value.lastFetchedAt) : '等待首次抓取'}`}</p></>}
      <h3>独立阅读偏好</h3><p className="muted">留空时继承文件夹或全局设置。</p>
      <Field label="列表样式"><select value={settings.view || ''} onChange={event => setSettings(old => ({ ...old, view: (event.target.value || undefined) as FeedPreferences['view'] }))}><option value="">继承</option><option value="magazine">杂志</option><option value="list">单行</option><option value="grid">网格</option></select></Field>
      <Field label="排序"><select value={settings.sort || ''} onChange={event => setSettings(old => ({ ...old, sort: (event.target.value || undefined) as FeedPreferences['sort'] }))}><option value="">继承</option><option value="newest">最新在前</option><option value="oldest">最早在前</option></select></Field>
      <Field label="未读筛选"><select value={settings.unreadOnly === undefined ? '' : String(settings.unreadOnly)} onChange={event => setSettings(old => ({ ...old, unreadOnly: event.target.value === '' ? undefined : event.target.value === 'true' }))}><option value="">继承</option><option value="true">仅未读</option><option value="false">全部</option></select></Field>
      <Field label="文章模式"><select value={settings.articleMode || ''} onChange={event => setSettings(old => ({ ...old, articleMode: (event.target.value || undefined) as FeedPreferences['articleMode'] }))}><option value="">继承</option><option value="feed">RSS 正文</option><option value="fulltext">提取全文</option><option value="webpage">原网页链接</option></select></Field>
      {target.kind === 'subscription' && <><Toggle label="置顶订阅" checked={!!settings.pinned} onChange={pinned => setSettings(old => ({ ...old, pinned }))} /><Toggle label="静音订阅" hint="不参与 G 键跳转下一个未读源，仍保留文章与自动抓取。" checked={!!settings.muted} onChange={muted => setSettings(old => ({ ...old, muted }))} /></>}
    </>}
    <div className="form-footer"><button className="primary" disabled={busy || !app.online}>保存</button>{target.kind === 'subscription' && <button type="button" className="secondary" disabled={busy || !app.online} onClick={() => void app.task(async () => { await mutate(`/subscriptions/${target.value.id}/refresh`, 'POST'); app.refresh(); app.notify('订阅源已刷新'); })}>立即刷新</button>}{value && <button type="button" className="danger" disabled={busy || !app.online} onClick={() => void remove()}>{target.kind === 'subscription' ? '取消订阅' : '删除'}</button>}</div>
  </form>;
}

export function TransferPanel({ mode }: { mode: 'import' | 'export' }) {
  const app = useApp(); const [busy, setBusy] = useState(false); const [result, setResult] = useState<{ imported: number; skipped: number; errors: string[] } | null>(null); const [ebooks, setEbooks] = useState<Ebook[]>([]); const [title, setTitle] = useState('FeedInk 阅读精选'); const [send, setSend] = useState(false);
  const loadEbooks = async () => setEbooks((await api<{ items: Ebook[] }>('/ebooks')).items);
  useEffect(() => { if (mode === 'export' && app.online) void app.task(loadEbooks); }, []);
  async function importFile(file: File, archive: boolean) {
    setBusy(true); await app.task(async () => {
      if (file.size > (archive ? 512 * 1024 * 1024 : 5 * 1024 * 1024)) throw new Error('文件过大：OPML 上限 5 MB，ZIP 上限 512 MB（服务器可能更严格）');
      const form = new FormData(); form.append('file', file);
      const value = archive ? await api<typeof result>('/import/archive', { method: 'POST', body: form }) : await mutate<typeof result>('/import/opml', 'POST', { content: await file.text() });
      setResult(value); app.refresh();
    }); setBusy(false);
  }
  async function createEbook(event: FormEvent) { event.preventDefault(); setBusy(true); await app.task(async () => { const ebook = await mutate<Ebook>('/ebooks', 'POST', { articleIds: app.articles.slice(0, 100).map(article => article.id), title, send }); await loadEbooks(); if (ebook.error) throw new Error(ebook.error); app.notify(send ? ebook.sentAt ? '电子书已生成并发送' : '电子书已生成，请查看发送状态' : '电子书已生成，可下载'); }); setBusy(false); }
  return mode === 'import' ? <section><h3>带上你的阅读收藏</h3><p>OPML 恢复订阅和文件夹。FeedInk ZIP 恢复正文、图片和阅读状态，并归入当前账号。不会覆盖其他用户的数据。</p>
    <Field label="导入 OPML"><input type="file" accept=".opml,.xml,text/xml,application/xml" disabled={busy || !app.online} onChange={event => { const file = event.target.files?.[0]; if (file) void importFile(file, false); event.target.value = ''; }} /></Field>
    <Field label="导入 FeedInk ZIP 存档"><input type="file" accept=".zip,application/zip" disabled={busy || !app.online} onChange={event => { const file = event.target.files?.[0]; if (file) void importFile(file, true); event.target.value = ''; }} /></Field>
    {busy && <p role="status">正在安全导入，请不要关闭页面…</p>}{result && <div role="status"><h3>导入结果</h3><p>导入 {result.imported} · 跳过 {result.skipped} · 失败 {result.errors.length}</p>{result.errors.map((error, index) => <p key={index} className="error-box">{error}</p>)}</div>}
  </section> : <section><h3>数据属于你</h3><p className="muted">OPML 只包含订阅；ZIP 包含持久化正文、已成功归档的图片及阅读状态。导出文件可能含私人数据，请妥善保管。</p><div className="button-row"><button className="secondary" disabled={!app.online} onClick={() => void app.task(() => download('/api/export/opml', 'FeedInk-subscriptions.opml'))}><Icon name="download" />导出 OPML</button><button className="secondary" disabled={!app.online} onClick={() => void app.task(() => download('/api/export/archive', 'FeedInk-archive.zip'))}><Icon name="archive" />导出完整 ZIP 存档</button></div>
    <hr /><form onSubmit={createEbook}><h3>制作 EPUB 电子书</h3><p>使用当前列表已加载的前 {Math.min(app.articles.length, 100)} 篇文章。可先按文件夹、标签或稍后阅读筛选。</p><Field label="书名"><input required value={title} maxLength={200} onChange={event => setTitle(event.target.value)} /></Field><Toggle label="同时发送到设置中的邮箱" hint={app.session.user.isDemo ? '演示账号不可发送邮件' : `收件地址：${app.session.settings.ebookEmail || '尚未设置'}`} checked={send} onChange={setSend} /><div className="button-row"><button className="primary" disabled={busy || !app.online || !app.articles.length || send && app.session.user.isDemo}>{busy ? '生成中…' : '生成电子书'}</button><button type="button" className="text-button" onClick={() => app.navigate('/settings/ebook')}>邮箱和定时设置</button></div></form>
    <h3>已生成的电子书</h3>{!ebooks.length && <p className="muted">还没有电子书</p>}{ebooks.map(ebook => <div className="management-row" key={ebook.id}><div><strong>{ebook.title}</strong><small>{formatDate(ebook.createdAt)} · {ebook.articleCount} 篇 · {ebook.sentAt ? '已发送' : '未发送'}</small>{ebook.error && <p className="error-box">{ebook.error}</p>}</div><button className="secondary" disabled={!app.online} onClick={() => void app.task(() => download(`/api/ebooks/${ebook.id}/download`, `${ebook.title.replace(/[\\/:*?"<>|]/g, '_')}.epub`))}>下载</button></div>)}</section>;
}

export function SaveUrlPanel() {
  const app = useApp(); const params = new URLSearchParams(location.search); const [url, setUrl] = useState(params.get('url') || params.get('text')?.match(/https?:\/\/\S+/)?.[0] || ''); const [busy, setBusy] = useState(false);
  return <form onSubmit={event => { event.preventDefault(); setBusy(true); void app.task(async () => { if (!safeExternalUrl(url)) throw new Error('请输入有效的 HTTP 或 HTTPS 网页地址'); const article = await mutate<ArticleDetail>('/articles/save-url', 'POST', { url }); await app.cacheArticle(article); app.refresh(); app.navigate(`/?scope=saved&article=${encodeURIComponent(article.id)}`); app.notify('网页已保存为持久化阅读档案'); }).finally(() => setBusy(false)); }}><p className="muted">保存网页正文与可抓取的图片，稍后慢慢读。登录限制、付费墙或源站风控可能使抓取失败，FeedInk 不绕过这些限制。</p><Field label="网页地址"><input autoFocus type="url" required placeholder="https://…" value={url} onChange={event => setUrl(event.target.value)} /></Field><button className="primary" disabled={busy || !app.online}>{busy ? '正在归档网页…' : '保存到稍后阅读'}</button></form>;
}

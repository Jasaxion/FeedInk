import { useEffect, useState, type FormEvent } from 'react';
import { DEFAULT_SETTINGS, type ReaderSettings, type User } from '@feedink/shared';
import { useApp } from './context';
import { api, mutate } from './api';
import { Field, Icon, Toggle } from './components';
import { scopedCss } from './safety';
import { McpTokens } from './McpTokens';

type Tab = 'appearance' | 'content' | 'listing' | 'ebook' | 'account' | 'offline' | 'admin' | 'mcp';
export function SettingsPanel({ path }: { path: string }) {
  const app = useApp();
  const initial: Tab = path.includes('article-contents') ? 'content' : path.includes('article-listing') ? 'listing' : path.endsWith('ebook') ? 'ebook' : 'appearance';
  const [tab, setTab] = useState<Tab>(initial);
  const [draft, setDraft] = useState(app.session.settings);
  const [busy, setBusy] = useState(false);
  const [storage, setStorage] = useState('');
  useEffect(() => { if (navigator.storage?.estimate) void navigator.storage.estimate().then(value => setStorage(`${((value.usage || 0) / 1024 / 1024).toFixed(1)} MB / ${((value.quota || 0) / 1024 / 1024).toFixed(0)} MB`)); }, []);
  const set = <K extends keyof ReaderSettings>(key: K, value: ReaderSettings[K]) => setDraft(old => ({ ...old, [key]: value }));
  const toggle = (key: keyof ReaderSettings, label: string, hint?: string) => <Toggle label={label} hint={hint} checked={Boolean(draft[key])} onChange={value => set(key, value as never)} />;
  const number = (key: keyof ReaderSettings, label: string, min: number, max: number, step = 1) => <Field label={label}><input type="number" required min={min} max={max} step={step} value={Number(draft[key])} onChange={event => set(key, Number(event.target.value) as never)} /></Field>;
  async function save(event: FormEvent) { event.preventDefault(); setBusy(true); await app.task(async () => { scopedCss(draft.customCss); await app.updateSettings(draft); app.notify('设置已保存并同步'); }); setBusy(false); }
  return <div className="settings-layout"><nav className="settings-nav" aria-label="设置分类">{([
    ['appearance', '外观与排版'], ['content', '文章内容'], ['listing', '文章列表'], ['ebook', '电子书与邮箱'], ['offline', '离线与安装'], ['account', '我的账号'], ['mcp', 'MCP 令牌'], ...(app.session.user.isAdmin ? [['admin', '用户管理']] : []),
  ] as [Tab, string][]).map(([key, label]) => <button key={key} aria-current={key === tab ? 'page' : undefined} onClick={() => setTab(key)}>{label}</button>)}<button type="button" className="danger" onClick={() => void app.logout()}>退出登录</button></nav>
    {tab === 'mcp' ? <McpTokens /> : tab === 'account' ? <AccountPanel /> : tab === 'admin' ? <AdminPanel /> : <form className="settings-form" onSubmit={save}>
      {tab === 'appearance' && <><h3>让阅读更合心意</h3><Field label="主题"><select value={draft.theme} onChange={event => set('theme', event.target.value as ReaderSettings['theme'])}><option value="system">跟随系统</option><option value="light">明亮</option><option value="dark">深色</option><option value="sepia">护眼纸张</option><option value="eink">墨水屏（纯黑白）</option></select></Field>
        <Field label="强调色"><input type="color" value={draft.accent} onChange={event => set('accent', event.target.value)} /></Field>
        <Field label="正文字体"><select value={draft.fontFamily} onChange={event => set('fontFamily', event.target.value as ReaderSettings['fontFamily'])}><option value="system">系统字体</option><option value="sans">无衬线</option><option value="serif">衬线 / 宋体</option></select></Field>
        <div className="field-grid">{number('fontSize', '字号 (px)', 12, 36)}{number('lineHeight', '行高', 1.2, 2.6, 0.1)}{number('contentWidth', '正文宽度 (px)', 400, 1200)}{number('sidebarWidth', '侧栏宽度 (px)', 180, 360)}{number('listWidth', '列表宽度 (px)', 260, 600)}</div>
        <p className="muted">墨水屏模式禁用颜色、动画、阴影与渐变，并增大触摸和翻页目标。系统减少动态效果设置始终受到尊重。</p></>}
      {tab === 'content' && <><h3>文章内容</h3>{toggle('autoFulltext', '自动提取全文', '提取结果与图片由服务器持久保存；失败时保留 RSS 正文。')}{toggle('lazyImages', '懒加载正文图片')}{toggle('hideToolbar', '阅读时收起工具栏', '保留“显示工具栏”按钮。')}{toggle('tapToPage', '轻点正文空白处向下翻页')}{toggle('wrapCode', '代码自动换行')}
        <Field label="自定义正文 CSS" hint="仅允许正文元素选择器及排版属性；禁止 URL、@规则、变量、定位与活动内容。例如 p { text-indent: 2em; }"><textarea rows={6} spellCheck={false} value={draft.customCss} onChange={event => set('customCss', event.target.value)} /></Field>
        <Field label="朗读速度"><input type="number" min={0.5} max={2} step={0.1} value={draft.speechRate} onChange={event => set('speechRate', Number(event.target.value))} /></Field></>}
      {tab === 'listing' && <><h3>文章列表</h3>{(['view', 'mobileView'] as const).map(key => <Field key={key} label={key === 'view' ? '桌面列表样式' : '手机列表样式'}><select value={draft[key]} onChange={event => set(key, event.target.value as ReaderSettings['view'])}><option value="magazine">杂志</option><option value="list">单行列表</option><option value="grid">网格</option></select></Field>)}
        <Field label="排序"><select value={draft.sort} onChange={event => set('sort', event.target.value as ReaderSettings['sort'])}><option value="newest">最新在前</option><option value="oldest">最早在前</option></select></Field>
        {toggle('unreadOnly', '默认只看未读')}{toggle('showFeedIcons', '显示订阅图标')}{toggle('showThumbnails', '显示文章缩略图')}{toggle('hideReadFeeds', '隐藏没有未读的订阅')}{toggle('markReadOnScroll', '滚过列表时标为已读', '只有完整离开列表顶部的文章才会被标为已读。')}</>}
      {tab === 'ebook' && <><h3>电子书与定时发送</h3><p className="muted">EPUB 包含已归档图片。发送需要管理员配置 SMTP；演示账号不能发送邮件。定时任务在服务器运行。</p>
        <Field label="收件邮箱"><input type="email" value={draft.ebookEmail} onChange={event => set('ebookEmail', event.target.value)} /></Field>
        {toggle('ebookAutoSend', '自动发送未读文章')}
        <div className="field-grid">{number('ebookIntervalDays', '发送间隔（天）', 1, 365)}{number('ebookHour', '发送时间（服务器小时）', 0, 23)}{number('ebookMinArticles', '最少文章数', 1, 100)}{number('ebookMaxArticles', '最多文章数', 1, 100)}</div>
        <Field label="电子书语言"><select value={draft.ebookLanguage} onChange={event => set('ebookLanguage', event.target.value)}><option value="zh-CN">简体中文</option><option value="en">English</option></select></Field>{toggle('ebookKeepLinks', '保留原文链接')}
        <button type="button" className="secondary" onClick={() => app.navigate('/export')}>生成、下载与查看发送状态</button></>}
      {tab === 'offline' && <><h3>离线阅读与 PWA</h3>{toggle('offlineEnabled', '在此设备保存读过的文章和图片', '离线数据仅属于当前账号。关闭后清除正文与图片缓存，但保留笔记、草稿及尚未同步的状态队列。')}
        <p>本地占用：{storage || '浏览器未提供存储统计'}</p><p className="muted">离线只显示已缓存文章，不代表全部服务器存档。服务器持久存档不受浏览器缓存清理影响。离线已读、收藏、标签和进度将在相同账号联网后同步。</p>
        <div className="button-row"><button type="button" className="secondary" onClick={() => void app.task(async () => { await app.clearCache(); app.notify('此设备的正文与图片缓存已清除，服务器存档未删除'); })}>清理正文缓存</button>
        <button type="button" className="secondary" onClick={() => void app.task(async () => { if (!navigator.storage?.persist) throw new Error('当前浏览器不支持持久存储授权'); const granted = await navigator.storage.persist(); app.notify(granted ? '浏览器已授予持久存储' : '浏览器未授予持久存储，缓存可能被系统回收', !granted); })}>申请保留离线数据</button></div>
        <h4>安装到桌面或主屏幕</h4><p>Chrome / Edge：使用地址栏的安装按钮或浏览器菜单“安装 FeedInk”。iPhone / iPad：Safari → 分享 → 添加到主屏幕。需要 HTTPS（或 localhost）。无需应用商店或原生安装包。</p><p>先联网打开文章或选择“缓存当前列表”，确认图片已归档后即可离线阅读。退出账号会清除所有私有缓存与待同步状态。</p></>}
      <div className="form-footer"><button className="primary" disabled={busy || !app.online}>{busy ? '保存中…' : '保存设置'}</button><button type="button" className="text-button" onClick={() => setDraft({ ...DEFAULT_SETTINGS })}>恢复默认值（保存后生效）</button></div>
    </form>}
  </div>;
}

function AccountPanel() {
  const app = useApp(); const [name, setName] = useState(app.session.user.name); const [currentPassword, setCurrentPassword] = useState(''); const [password, setPassword] = useState('');
  return <form className="settings-form" onSubmit={event => { event.preventDefault(); void app.task(async () => { const user = await mutate<User>('/account', 'PATCH', { name, ...(password ? { currentPassword, password } : {}) }); app.updateSession({ ...app.session, user }); setPassword(''); setCurrentPassword(''); app.notify('账号资料已保存'); }); }}>
    <h3>我的账号 {app.session.user.isDemo && <span className="badge">演示</span>}</h3><p>{app.session.user.email}</p><Field label="昵称"><input required value={name} maxLength={80} onChange={event => setName(event.target.value)} /></Field>
    <h4>修改密码</h4><Field label="当前密码"><input type="password" autoComplete="current-password" required={Boolean(password)} value={currentPassword} onChange={event => setCurrentPassword(event.target.value)} /></Field><Field label="新密码" hint="至少 10 个字符；留空不修改。修改后会撤销其他设备的会话。"><input type="password" autoComplete="new-password" minLength={10} value={password} onChange={event => setPassword(event.target.value)} /></Field>
    <button className="primary" disabled={!app.online}>保存账号资料</button><hr /><p className="muted">退出时会处理本机私有缓存；未同步笔记需先同步、导出、锁定保留或明确放弃，不会因普通缓存清理自动删除。</p>
  </form>;
}
function AdminPanel() {
  const app = useApp(); const [users, setUsers] = useState<(User & { disabled: boolean })[]>([]);
  useEffect(() => { void app.task(async () => setUsers((await api<{ items: (User & { disabled: boolean })[] }>('/admin/users')).items)); }, []);
  return <section className="settings-form"><h3>用户管理</h3><p className="muted">停用账号将立即撤销其所有会话。不能停用自己的管理员账号。</p>{users.map(user => <div key={user.id} className="management-row"><div><strong>{user.name}</strong><small>{user.email} {user.isAdmin && '· 管理员'} {user.isDemo && '· 演示'}</small></div><button className="secondary" disabled={user.id === app.session.user.id || !app.online} onClick={() => void app.task(async () => { const updated = await mutate<User & { disabled: boolean }>(`/admin/users/${user.id}`, 'PATCH', { disabled: !user.disabled }); setUsers(old => old.map(item => item.id === updated.id ? updated : item)); })}>{user.disabled ? '启用' : '停用'}</button></div>)}</section>;
}

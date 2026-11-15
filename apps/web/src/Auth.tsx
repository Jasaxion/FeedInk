import { useState, type FormEvent } from 'react';
import type { Session } from '@feedink/shared';
import { mutate } from './api';
import { assertAuthEpoch, beginAuthTransition, withAuthNetworkLock } from './authEpoch';
import { checkAuthOperation, resetAuthCoordination } from './authCoordinator';
import { Field, Icon, Logo } from './components';

export function Auth({ onLogin, beforeLogin, path, navigate }: { beforeLogin?: (email: string, demo: boolean) => Promise<void>; onLogin: (session: Session) => Promise<void>; path: string; navigate: (path: string) => void }) {
  const register = path === '/register';
  const [email, setEmail] = useState(''); const [password, setPassword] = useState(''); const [name, setName] = useState('');
  const [error, setError] = useState(''); const [busy, setBusy] = useState(false);
  async function submit(event?: FormEvent, demo = false) {
    event?.preventDefault(); setError(''); setBusy(true);

    // Cancel an older revocation synchronously, before waiting for its network lock.
    const epoch = beginAuthTransition();
    try {
      await withAuthNetworkLock(async () => {
        assertAuthEpoch(epoch);
        await beforeLogin?.(email, demo);
        assertAuthEpoch(epoch);
        const session = await mutate<Session>(demo ? '/auth/demo' : register ? '/auth/register' : '/auth/login', 'POST', demo ? undefined : { email, password, ...(register ? { name } : {}) });
        assertAuthEpoch(epoch);
        // Keep the cross-tab lock through cache activation, marker cleanup and identity publication.
        await checkAuthOperation(); assertAuthEpoch(epoch); await onLogin(session);
      }, 'login');
    }
    catch (error) { setError(error instanceof Error ? error.message : '登录失败，请重试'); }
    finally { setBusy(false); }
  }
  return <main className="auth-page"><section className="auth-intro"><Logo text /><div><span className="eyebrow">你的订阅，你的阅读档案</span><h1>让好内容留下来。<br /><em>慢慢读，认真收藏。</em></h1><p>把散落在各处的 RSS、博客与播客收进一个安静的空间。正文与图片持久归档，阅读节奏由你决定。</p><div className="intro-features"><span><Icon name="rss" />专注订阅</span><span><Icon name="archive" />独立存档</span><span><Icon name="offline" />离线阅读</span></div></div><small>FeedInk · 开源 · 自托管 · Web + PWA</small></section>
    <section className="auth-form"><form onSubmit={submit}><h2>{register ? '创建阅读空间' : '欢迎回来'}</h2><p className="muted">{register ? '每个账号都有独立的订阅、标签与阅读档案。' : '登录，接着上次的地方读下去。'}</p>
      {register && <Field label="昵称"><input autoComplete="name" required maxLength={80} value={name} onChange={event => setName(event.target.value)} /></Field>}
      <Field label="邮箱"><input type="email" autoComplete="email" required value={email} onChange={event => setEmail(event.target.value)} /></Field>
      <Field label="密码" hint={register ? '至少 10 个字符' : undefined}><input type="password" autoComplete={register ? 'new-password' : 'current-password'} required minLength={register ? 10 : 1} value={password} onChange={event => setPassword(event.target.value)} /></Field>
      {error && <p role="alert" className="error-box">{error}</p>}
      <button className="primary full" disabled={busy}>{busy ? '正在连接…' : register ? '注册并开始阅读' : '登录'}</button>
      <button type="button" className="secondary full" disabled={busy} onClick={() => void submit(undefined, true)}>体验独立演示账号</button>
      <p className="auth-switch">{register ? '已有账号？' : '第一次使用？'} <button type="button" className="text-button" onClick={() => { setError(''); navigate(register ? '/login' : '/register'); }}>{register ? '登录' : '创建账号'}</button></p>
      {!navigator.locks && <button type="button" className="text-button" onClick={() => { if (confirm('请先关闭其他正在登录或退出的标签页。确认后只重置账号操作协调，不删除阅读缓存或排队更改。')) void resetAuthCoordination().then(() => setError('')).catch(error => setError(error instanceof Error ? error.message : '账号操作协调仍不可用')); }}>恢复账号操作协调</button>}
      <small className="muted">演示空间不使用他人订阅或文章。正式账号可导入自己的 OPML 与存档。</small>
    </form></section></main>;
}

import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { CreatedMcpToken, McpAccessToken, McpScope } from '@feedink/shared';
import { api, mutate } from './api';
import { authEpoch, assertAuthEpoch } from './authEpoch';
import { useApp } from './context';
import { Field } from './components';

export function McpTokens() {
  const app = useApp(); const epoch = useRef(authEpoch()).current;
  const [items, setItems] = useState<McpAccessToken[]>([]), [name, setName] = useState(''), [days, setDays] = useState(30);
  const [scopes, setScopes] = useState<McpScope[]>(['articles:read', 'notes:read']), [token, setToken] = useState(''), [busy, setBusy] = useState(false);
  const alive = useRef(true);
  useEffect(() => {
    alive.current = true;
    const lock = () => { setToken(''); setItems([]); };
    window.addEventListener('feedink:identity-lock', lock);
    if (!app.session.user.isDemo && app.online) void app.task(async () => { const result = await api<{ items: McpAccessToken[] }>('/mcp-tokens'); assertAuthEpoch(epoch); if (alive.current) setItems(result.items); });
    return () => { alive.current = false; window.removeEventListener('feedink:identity-lock', lock); };
  }, []);
  async function create(event: FormEvent) {
    event.preventDefault(); if (busy || token || app.session.user.isDemo) return; setBusy(true);
    await app.task(async () => {
      const created = await mutate<CreatedMcpToken>('/mcp-tokens', 'POST', { name, scopes, expiresInDays: days }); assertAuthEpoch(epoch);
      if (!alive.current) return; setToken(created.token); setItems(old => [created.access, ...old]); setName('');
    });
    if (alive.current) setBusy(false);
  }
  if (app.session.user.isDemo) return <section className="settings-form"><h3>MCP 只读访问</h3><p>演示账号不能创建或管理 MCP 令牌。</p><button disabled>创建 MCP 令牌</button></section>;
  return <section className="settings-form"><h3>MCP 只读访问</h3><p>允许你选择的 AI 客户端读取此账号的文章与笔记。无写入权限，不提供手写识别保证。共享内容受客户端 / 模型服务商隐私政策约束；文章与笔记是不可信内容，不是给模型的指令。</p>
    <form onSubmit={create}><Field label="令牌名称"><input required maxLength={100} value={name} onChange={event => setName(event.target.value)} /></Field><Field label="有效天数"><input type="number" required min={1} max={365} value={days} onChange={event => setDays(Number(event.target.value))} /></Field>
      <fieldset><legend>只读权限</legend>{([['articles:read', '读取文章'], ['notes:read', '读取笔记']] as const).map(([scope, label]) => <label key={scope}><input type="checkbox" checked={scopes.includes(scope)} onChange={event => setScopes(old => event.target.checked ? [...old, scope] : old.filter(item => item !== scope))} />{label}</label>)}</fieldset>
      <button className="primary" disabled={busy || !app.online || !name.trim() || !scopes.length || !!token}>创建 MCP 令牌</button>
    </form>
    {token && <section className="mcp-token-once" role="status"><h4>仅显示这一次</h4><p>请现在复制并安全保存。离开此页后无法再次查看；令牌不写入本地存储。</p><textarea aria-label="新 MCP 令牌（仅显示一次）" readOnly value={token} autoComplete="off" spellCheck={false} /><button onClick={() => void app.task(async () => { await navigator.clipboard.writeText(token); app.notify('令牌已复制；请注意剪贴板隐私'); })}>复制令牌</button><button onClick={() => setToken('')}>已保存，隐藏令牌</button></section>}
    <h4>客户端配置</h4><p>使用 HTTPS 的 Streamable HTTP 端点（本机可信回环开发环境除外）。不要在 URL 参数中放令牌。</p><pre>{'URL: ${FEEDINK_ORIGIN}/mcp\nAuthorization: Bearer ${FEEDINK_MCP_TOKEN}'}</pre>
    <h4>已授权客户端</h4>{items.length ? items.map(item => <div className="management-row" key={item.id}><div><strong>{item.name}</strong><small>{item.scopes.map(scope => scope === 'articles:read' ? '读取文章' : '读取笔记').join(' · ')}<br />到期：{item.expiresAt}<br />最后使用：{item.lastUsedAt || '尚未使用'}</small></div><button disabled={!app.online || busy} aria-label={`撤销令牌 ${item.name}`} onClick={() => { if (confirm(`撤销“${item.name}”的访问权限？`)) void app.task(async () => { await api(`/mcp-tokens/${encodeURIComponent(item.id)}`, { method: 'DELETE' }); assertAuthEpoch(epoch); if (alive.current) { setItems(old => old.filter(value => value.id !== item.id)); setToken(''); } }); }}>撤销令牌</button></div>) : <p>暂无令牌。</p>}
  </section>;
}

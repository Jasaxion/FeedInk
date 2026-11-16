import { useEffect, useRef, useState, type FormEvent } from 'react';
import type { AiConfig, AiLanguage } from '@feedink/shared';
import { api } from './api';
import { useApp } from './context';
import { authEpoch } from './authEpoch';
import { Field, Toggle } from './components';
import { aiRequestError, useAiIdentity } from './aiIdentity';
import { AiResults } from './AiResults';
import { publishAiConfigChange } from './aiConfigSync';
import './ai.css';

export const AI_LANGUAGES: ReadonlyArray<readonly [AiLanguage, string]> = [
  ['zh-CN', '简体中文'], ['en', 'English'], ['ja', '日本語'], ['ko', '한국어'], ['fr', 'Français'], ['de', 'Deutsch'], ['es', 'Español'],
];
export function AiLanguageOptions() { return <>{AI_LANGUAGES.map(([value, label]) => <option key={value} value={value}>{label}</option>)}</>; }

export function AiSettings() {
  const app = useApp();
  return <AiSettingsSession key={`${app.session.user.id}:${authEpoch()}`} />;
}
function AiSettingsSession() {
  const app = useApp();
  const { locked, isCurrent } = useAiIdentity(app.session.user.id);
  const [config, setConfig] = useState<AiConfig | null>(null);
  const [enabled, setEnabled] = useState(false), [baseUrl, setBaseUrl] = useState(''), [model, setModel] = useState('');
  const [targetLanguage, setTargetLanguage] = useState<AiLanguage>('zh-CN');
  const [apiKey, setApiKey] = useState(''), [clearKey, setClearKey] = useState(false);
  const [busy, setBusy] = useState(false), [error, setError] = useState(''), [message, setMessage] = useState('');
  const request = useRef<AbortController | null>(null);
  const available = app.online && !app.session.user.isDemo;
  const canRequest = useRef(available); canRequest.current = available;
  function adopt(next: AiConfig) {
    setConfig(next); setEnabled(next.enabled); setBaseUrl(next.baseUrl); setModel(next.model); setTargetLanguage(next.targetLanguage || 'zh-CN');
  }
  async function run(action: (signal: AbortSignal) => Promise<void>) {
    if (!isCurrent() || !canRequest.current || request.current) return;
    const controller = new AbortController(); request.current = controller;
    const timeout = setTimeout(() => controller.abort(), 20_000);
    setBusy(true); setError(''); setMessage('');
    try { await action(controller.signal); }
    catch (reason) { if (isCurrent()) setError(aiRequestError(reason)); }
    finally { clearTimeout(timeout); if (request.current === controller) request.current = null; if (isCurrent()) setBusy(false); }
  }
  const load = () => run(async signal => { const next = await api<AiConfig>('/ai/config', { signal }); if (isCurrent()) adopt(next); });
  useEffect(() => {
    if (available && !config) void load();
    return () => { request.current?.abort(); };
  }, [available]);
  useEffect(() => { if (locked) { request.current?.abort(); setApiKey(''); setConfig(null); } }, [locked]);
  async function save(event: FormEvent) {
    event.preventDefault();
    await run(async signal => {
      const next = await api<AiConfig>('/ai/config', { method: 'PUT', signal, body: JSON.stringify({ enabled, baseUrl: baseUrl.trim(), model: model.trim(), targetLanguage, ...(clearKey ? { apiKey: null } : apiKey ? { apiKey } : {}) }) });
      if (!isCurrent()) return;
      adopt(next); setApiKey(''); setClearKey(false); setMessage('AI 配置已保存；密钥不会回传。');
      publishAiConfigChange(app.session.user.id, next.revision);
    });
  }
  if (locked || !isCurrent()) return null;
  return <section className="settings-form ai-settings"><form onSubmit={save} aria-label="AI 模型设置">
    <h3>可选 AI 阅读</h3>
    <p className="muted">仅在明确请求时处理所选正文，不自动处理文章库。服务端保存每账号独立配置，密钥保存后不再显示。</p>
    {app.session.user.isDemo ? <p role="status">演示账号不能配置密钥或调用 AI。</p> : !app.online && <p role="status">离线时无法读取或保存 AI 配置。未保存的输入仍保留在此页。</p>}
    {error && <p role="alert">{error}</p>}{message && <p role="status">{message}</p>}
    {!config ? <button type="button" className="secondary" disabled={busy || !available} onClick={() => void load()}>{busy ? '正在读取配置…' : '读取 AI 配置'}</button> : <>
      <fieldset disabled={busy || !available}>
        <Toggle label="启用 AI 阅读" checked={enabled} onChange={setEnabled} />
        <Field label="OpenAI 兼容服务地址" hint="使用受信任的 HTTPS API 地址；网络例外只能由管理员配置。"><input type="url" required={enabled} value={baseUrl} onChange={event => setBaseUrl(event.target.value)} autoComplete="off" spellCheck={false} /></Field>
        <Field label="模型名称"><input required={enabled} value={model} onChange={event => setModel(event.target.value)} autoComplete="off" spellCheck={false} /></Field>
        <Field label="默认目标语言"><select value={targetLanguage} onChange={event => setTargetLanguage(event.target.value as AiLanguage)}><AiLanguageOptions /></select></Field>
        <p data-testid="ai-key-status">{config.hasKey ? '已保存密钥（不可读取）' : '尚未保存密钥'}</p>
        <Field label="替换 API 密钥" hint="留空保留现有密钥。只在此页输入新密钥，不存入浏览器缓存。"><input type="password" value={apiKey} disabled={clearKey} onChange={event => setApiKey(event.target.value)} autoComplete="new-password" spellCheck={false} /></Field>
        <Toggle label="清除已保存密钥（保存后生效）" checked={clearKey} onChange={setClearKey} />
      </fieldset>
      <div className="button-row"><button className="primary" disabled={busy || !available}>{busy ? '处理中…' : '保存 AI 配置'}</button>
        <button type="button" className="secondary" disabled={busy || !available || !config.enabled || !config.hasKey} onClick={() => void run(async signal => { await api('/ai/config/test', { method: 'POST', signal }); if (isCurrent()) setMessage('已保存配置的连接测试成功。'); })}>测试已保存配置（会发送请求）</button></div>
      <p className="muted small">测试使用已保存配置，不使用未保存的输入；会向模型服务发送一次最小请求，可能产生费用。</p>
    </>}
  </form><AiResults /></section>;
}

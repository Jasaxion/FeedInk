import { useCallback, useEffect, useRef, useState } from 'react';
import { authEpoch, getApiSession } from './authEpoch';
import { HttpError } from './api';

/** AI state is ephemeral: never persist configuration drafts, credentials or results in IDB. */
export function useAiIdentity(owner: string) {
  const [epoch] = useState(authEpoch);
  const [locked, setLocked] = useState(false);
  const alive = useRef(true), retired = useRef(false);
  useEffect(() => {
    alive.current = true;
    const lock = () => { retired.current = true; setLocked(true); };
    window.addEventListener('feedink:identity-lock', lock);
    return () => { alive.current = false; window.removeEventListener('feedink:identity-lock', lock); };
  }, []);
  const isCurrent = useCallback(() => alive.current && !retired.current && authEpoch() === epoch && getApiSession()?.user.id === owner, [owner, epoch]);
  return { locked, isCurrent };
}

// Never echo a provider body, URL or secret through an arbitrary exception message.
export function aiRequestError(error: unknown): string {
  if (error instanceof Error && ['AI_SOURCE_CHANGED', 'AI_DISPLAY_CHANGED'].includes(error.message)) return '正文已变更，请返回最新正文并重新打开文章后使用 AI；未发送模型请求。';
  if (error instanceof Error && ['AI_JOB_CONTEXT', 'AI_JOB_COVERAGE', 'AI_JOB_SOURCE', 'AI_JOB_INCOMPLETE'].includes(error.message)) return '返回的结果与所选正文不匹配或覆盖不完整，已拒绝显示；未自动重试。';
  if (error instanceof HttpError) {
    if (error.status === 401 || error.status === 403) return '当前账号无法使用 AI，请检查登录状态。';
    if (error.status === 409) return '正文或配置已变更，请重新打开 AI 操作；未自动重试。';
    if (error.status === 429) return '请求过于频繁，请稍后手动重试。';
    if (error.status === 400 || error.status === 422) return '配置或请求不可用，请检查模型、地址与密钥。';
  }
  return '请求未完成，请检查网络或服务配置后手动重试；输入已保留。';
}

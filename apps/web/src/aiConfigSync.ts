export const AI_CONFIG_CHANGE_EVENT = 'feedink:ai-config-changed';
const channelName = 'feedink-ai-config';
export interface AiConfigChange { owner: string; revision: number }

export function isNewAiConfigRevision(value: unknown, owner: string, revision: number): value is AiConfigChange {
  if (!value || typeof value !== 'object') return false;
  const change = value as AiConfigChange;
  return change.owner === owner && Number.isSafeInteger(change.revision) && change.revision > revision;
}

/** Invalidation only: no keys, provider metadata, source content or persistent AI storage. */
export function publishAiConfigChange(owner: string, revision: number): void {
  const detail: AiConfigChange = { owner, revision };
  window.dispatchEvent(new CustomEvent<AiConfigChange>(AI_CONFIG_CHANGE_EVENT, { detail }));
  if ('BroadcastChannel' in window) {
    const channel = new BroadcastChannel(channelName);
    channel.postMessage(detail); channel.close();
  }
}
export function subscribeAiConfigChange(receive: (change: unknown) => void): () => void {
  const local = (event: Event) => receive((event as CustomEvent<unknown>).detail);
  const channel = 'BroadcastChannel' in window ? new BroadcastChannel(channelName) : null;
  if (channel) channel.onmessage = event => receive(event.data);
  window.addEventListener(AI_CONFIG_CHANGE_EVENT, local);
  return () => { channel?.close(); window.removeEventListener(AI_CONFIG_CHANGE_EVENT, local); };
}

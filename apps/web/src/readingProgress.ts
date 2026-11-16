import { progressAt } from './logic';

export interface TransientReadingBlock { top: number; height: number }

/** Collapse just the scrolled portion of transient content, not its entire height. */
export function originalProgressAt(scrollTop: number, scrollHeight: number, clientHeight: number, block: TransientReadingBlock): number {
  const removed = Math.min(block.height, Math.max(0, scrollTop - block.top));
  return progressAt(scrollTop - removed, scrollHeight - block.height, clientHeight);
}
export function originalScrollTop(progress: number, scrollHeight: number, clientHeight: number, block: TransientReadingBlock): number {
  const top = progress * Math.max(0, scrollHeight - block.height - clientHeight);
  return top > block.top ? top + block.height : top;
}
function transientReadingBlock(element: HTMLElement): TransientReadingBlock {
  // Inside the plain metadata wrapper, the host contains only added card content
  // and its pre-card spacing. The wrapper's original bottom margin still collapses
  // with the first source block whether AI is open or not; it is not transient.
  const host = element.querySelector<HTMLElement>('[data-reading-transient]');
  const rect = host?.getBoundingClientRect();
  return rect?.height ? { top: rect.top - element.getBoundingClientRect().top - element.clientTop + element.scrollTop, height: rect.height } : { top: 0, height: 0 };
}
export function originalReadingProgress(element: HTMLElement): number {
  return originalProgressAt(element.scrollTop, element.scrollHeight, element.clientHeight, transientReadingBlock(element));
}
export function restoreOriginalReadingProgress(element: HTMLElement, progress: number): void {
  element.scrollTop = originalScrollTop(progress, element.scrollHeight, element.clientHeight, transientReadingBlock(element));
}

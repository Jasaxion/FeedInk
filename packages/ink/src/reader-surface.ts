/** FeedInk modifications (Apache-2.0): explicit current-article input/paint surface.
 * Original body identity stays separate from viewport gutters and application UI.
 * Adapted from WebInk; see packages/ink/LICENSE and repository NOTICE. */
export class ReaderInkSurface {
  constructor(readonly content: HTMLElement, readonly title: HTMLElement, readonly viewport: HTMLElement) {
    if (content.ownerDocument !== title.ownerDocument || !viewport.contains(content) || !viewport.contains(title)) throw new Error('Ink surface must belong to one reader');
  }
  private readonly excluded = '[data-annotation-ui],[data-reading-transient],input,textarea,select,button,form,[contenteditable],dialog';
  bounds(): { left: number; top: number; right: number; bottom: number } {
    const clip = this.viewport.getBoundingClientRect(), title = this.title.getBoundingClientRect(), body = this.content.getBoundingClientRect();
    return { left: clip.left + this.viewport.clientLeft, right: clip.left + this.viewport.clientLeft + this.viewport.clientWidth,
      top: Math.max(clip.top, title.top), bottom: Math.min(clip.bottom, body.bottom) };
  }
  accepts(target: Element, x: number, y: number): boolean {
    const box = this.bounds();
    return this.content.isConnected && this.title.isConnected && this.viewport.contains(target) && !target.closest(this.excluded) &&
      x >= box.left && x <= box.right && y >= box.top && y <= box.bottom &&
      (this.content.contains(target) || this.title.contains(target) || target.contains(this.content));
  }
  targetAt(x: number, y: number): HTMLElement | null {
    const hit = this.content.ownerDocument.elementFromPoint(x, y);
    if (!hit || !this.accepts(hit, x, y)) return null;
    return y < this.content.getBoundingClientRect().top ? this.title : this.content;
  }
  /** Subtract temporary UI even when an existing stroke crosses its future position. */
  clip(context: CanvasRenderingContext2D, offsetX: number, offsetY: number): void {
    const box = this.bounds();
    context.beginPath(); context.rect(box.left - offsetX, box.top - offsetY, Math.max(0, box.right - box.left), Math.max(0, box.bottom - box.top)); context.clip();
    for (const element of this.viewport.querySelectorAll(this.excluded)) {
      const r = element.getBoundingClientRect();
      if (!r.width || !r.height) continue;
      context.beginPath(); context.rect(box.left - offsetX, box.top - offsetY, Math.max(0, box.right - box.left), Math.max(0, box.bottom - box.top));
      context.rect(r.left - offsetX, r.top - offsetY, r.width, r.height); context.clip('evenodd');
    }
  }
}

import { engineWork } from './work.ts';
import type { Page, Stroke } from './types.ts';
import { encodedBytes, LIMITS, validatePage, validateStroke } from './validation.ts';

interface Entry { index: number; stroke: Stroke }
interface Action { added: Entry[]; removed: Entry[]; points: number }
function immutable<T>(value: T): T {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    for (const child of Object.values(value)) immutable(child);
    Object.freeze(value);
  }
  return value;
}
const copy = <T>(value: T): T => JSON.parse(JSON.stringify(value)) as T;

/** Single-page committed data. Active gestures stay outside this store, so cancel is lossless. */
export class InkDocument {
  private page: Page;
  private past: Action[] = [];
  private future: Action[] = [];
  private historyPoints = 0;
  private pointCount = 0;
  private strokeBytes = 0;
  private ids = new Set<string>();
  private sizes = new WeakMap<Stroke, number>();

  constructor(url: string, title: string, layoutWidth: number) {
    this.page = { version: 1, url, title: title.slice(0, LIMITS.titleLength), updatedAt: 0, layoutWidth, strokes: [] };
  }
  get strokes(): readonly Stroke[] { return this.page.strokes; }
  get url(): string { return this.page.url; }
  get layoutWidth(): number { return this.page.layoutWidth; }
  get canUndo(): boolean { return this.past.length > 0; }
  get canRedo(): boolean { return this.future.length > 0; }
  get totalPoints(): number { return this.pointCount; }
  snapshot(): Page { return copy(this.page); }
  metadata(): Omit<Page, 'strokes'> {
    const { strokes: _strokes, ...metadata } = this.page;
    return metadata;
  }
  setTitle(title: string): void {
    const next = title.slice(0, LIMITS.titleLength);
    if (next === this.page.title) return;
    if (this.strokeBytes + Math.max(0, this.page.strokes.length - 1) +
      encodedBytes({ ...this.page, title: next, strokes: [] }) > LIMITS.pageBytes) throw new Error('Ink storage capacity reached');
    this.page.title = next;
  }

  restore(value: unknown): void {
    const next = value === null ? { ...this.page, updatedAt: 0, strokes: [] } : validatePage(value, this.page.url);
    Object.freeze(next.strokes);
    this.page = next;
    this.past = [];
    this.future = [];
    this.historyPoints = 0;
    this.recount();
  }
  add(value: Stroke): void {
    const stroke = immutable(validateStroke(value));
    if (this.ids.has(stroke.id)) throw new Error('Duplicate stroke id');
    if (this.page.strokes.length >= LIMITS.strokes || this.pointCount + stroke.points.length > LIMITS.totalPoints) {
      throw new Error('Ink capacity reached; export or erase strokes before drawing more');
    }
    // Budget a complete page, including UTF-8 metadata and array separators, before mutating.
    const nextBytes = this.strokeBytes + this.size(stroke) + this.page.strokes.length +
      encodedBytes({ ...this.page, strokes: [], updatedAt: Date.now() });
    if (nextBytes > LIMITS.pageBytes) throw new Error('Ink storage capacity reached');
    this.commit({ added: [{ index: this.page.strokes.length, stroke }], removed: [], points: stroke.points.length });
  }
  erase(ids: ReadonlySet<string>): boolean {
    const removed: Entry[] = [];
    this.page.strokes.forEach((stroke, index) => { if (ids.has(stroke.id)) removed.push({ index, stroke }); });
    if (!removed.length) return false;
    this.commit({ added: [], removed, points: removed.reduce((sum, entry) => sum + entry.stroke.points.length, 0) });
    return true;
  }
  undo(): boolean {
    const action = this.past.pop();
    if (!action) return false;
    this.apply(action.added, action.removed);
    this.future.push(action);
    return true;
  }
  redo(): boolean {
    const action = this.future.pop();
    if (!action) return false;
    this.apply(action.removed, action.added);
    this.past.push(action);
    return true;
  }
  private commit(action: Action): void {
    this.apply(action.removed, action.added);
    this.historyPoints -= this.future.reduce((sum, item) => sum + item.points, 0);
    this.future = [];
    this.past.push(action);
    this.historyPoints += action.points;
    while (this.past.length > LIMITS.historyActions || this.historyPoints > LIMITS.historyPoints) {
      this.historyPoints -= this.past.shift()!.points;
    }
  }
  private apply(remove: Entry[], insert: Entry[]): void {
    const ids = new Set(remove.map(entry => entry.stroke.id));
    const strokes = this.page.strokes.filter(stroke => !ids.has(stroke.id));
    for (const entry of insert) strokes.splice(entry.index, 0, entry.stroke);
    Object.freeze(strokes);
    this.page = { ...this.page, strokes, updatedAt: Date.now() };
    for (const entry of remove) {
      this.ids.delete(entry.stroke.id);
      this.pointCount -= entry.stroke.points.length;
      this.strokeBytes -= this.size(entry.stroke);
    }
    for (const entry of insert) {
      this.ids.add(entry.stroke.id);
      this.pointCount += entry.stroke.points.length;
      this.strokeBytes += this.size(entry.stroke);
    }
  }
  private size(stroke: Stroke): number {
    let bytes = this.sizes.get(stroke);
    if (bytes === undefined) { engineWork.encodedStrokes++; bytes = encodedBytes(stroke); this.sizes.set(stroke, bytes); }
    return bytes;
  }
  private recount(): void {
    this.pointCount = 0;
    this.strokeBytes = 0;
    this.ids.clear();
    for (const stroke of this.page.strokes) {
      immutable(stroke);
      this.ids.add(stroke.id);
      this.pointCount += stroke.points.length;
      this.strokeBytes += this.size(stroke);
    }
  }
}

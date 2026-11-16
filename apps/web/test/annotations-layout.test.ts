import test from 'node:test';
import assert from 'node:assert/strict';
import { annotationBounds, placeAnnotation } from '../src/AnnotationFloat';
import { observeAnnotationLayout } from '../src/annotationLayout';

test('annotationBounds intersects reader with zoomed visual viewport and keyboard inset', () => {
  assert.deepEqual(annotationBounds({ left: 600, top: 60, right: 1280, bottom: 900 }, { left: 500, top: 180, right: 1000, bottom: 620 }), { left: 608, top: 188, right: 992, bottom: 612 });
});
test('placeAnnotation flips beneath top-edge selection and clamps horizontal overflow', () => {
  const bounds = { left: 8, top: 70, right: 382, bottom: 830 };
  assert.deepEqual(placeAnnotation(bounds, { width: 300, height: 44 }, { left: 12, top: 76, right: 50, bottom: 98 }), { left: 8, top: 106 });
  assert.deepEqual(placeAnnotation(bounds, { width: 300, height: 44 }, { left: 360, top: 800, right: 380, bottom: 820 }), { left: 82, top: 748 });
});
test('placeAnnotation remains bounded when keyboard leaves less room than the editor', () => {
  assert.deepEqual(placeAnnotation({ left: 8, top: 160, right: 312, bottom: 360 }, { width: 340, height: 400 }, { left: 250, top: 300, right: 310, bottom: 330 }), { left: 8, top: 160 });
});
test('observeAnnotationLayout coalesces offset-only ancestor changes and disconnects pending refreshes', () => {
  const names = ['ResizeObserver', 'MutationObserver', 'requestAnimationFrame', 'cancelAnimationFrame'] as const;
  const descriptors = names.map(name => Object.getOwnPropertyDescriptor(globalThis, name));
  const frames = new Map<number, FrameRequestCallback>(), observed: Element[] = [];
  let resize = () => {}, mutate = () => {}, serial = 0, disconnected = 0, refreshes = 0;
  const article = {} as Element;
  let box = { left: 10, top: 20, width: 400, height: 600 };
  const root = { closest: (selector: string) => { assert.equal(selector, '.article-document'); return article; }, getBoundingClientRect: () => box } as unknown as HTMLElement;
  try {
    globalThis.ResizeObserver = class {
      constructor(callback: ResizeObserverCallback) { resize = () => callback([], this as unknown as ResizeObserver); }
      observe(target: Element) { observed.push(target); }
      disconnect() { disconnected++; }
    } as unknown as typeof ResizeObserver;
    globalThis.MutationObserver = class {
      constructor(callback: MutationCallback) { mutate = () => callback([], this as unknown as MutationObserver); }
      observe(target: Node, options: MutationObserverInit) { assert.equal(target, article); assert.deepEqual(options, { childList: true }); }
      disconnect() { disconnected++; }
    } as unknown as typeof MutationObserver;
    globalThis.requestAnimationFrame = callback => { frames.set(++serial, callback); return serial; };
    globalThis.cancelAnimationFrame = id => { frames.delete(id); };
    const paint = () => { const pending = [...frames.values()]; frames.clear(); for (const callback of pending) callback(0); };
    const stop = observeAnnotationLayout(root, () => { refreshes++; });
    assert.deepEqual(observed, [article, root]);
    resize(); paint(); assert.equal(refreshes, 0, 'initial unchanged layout is not a refresh');
    box = { ...box, top: 110 }; resize(); mutate(); resize();
    assert.equal(frames.size, 1); paint(); assert.equal(refreshes, 1, 'same-sized body follows its ancestor offset');
    mutate(); paint(); assert.equal(refreshes, 1, 'unrelated sibling mutation does not redraw ink');
    box = { ...box, top: 20 }; mutate(); paint(); assert.equal(refreshes, 2);
    box = { ...box, width: 390 }; resize(); stop(); paint();
    assert.equal(refreshes, 2); assert.equal(disconnected, 2); assert.equal(frames.size, 0);
  } finally {
    names.forEach((name, index) => { const descriptor = descriptors[index]; if (descriptor) Object.defineProperty(globalThis, name, descriptor); else Reflect.deleteProperty(globalThis, name); });
  }
});

/** Sibling cards can move an unchanged reader root without resizing the viewport. */
export function observeAnnotationLayout(root: HTMLElement, refresh: () => void) {
  const article = root.closest('.article-document');
  if (!article) return () => {};
  let frame = 0, previous = root.getBoundingClientRect();
  const schedule = () => {
    if (frame) return;
    frame = requestAnimationFrame(() => {
      frame = 0;
      const next = root.getBoundingClientRect();
      if (next.left !== previous.left || next.top !== previous.top || next.width !== previous.width || next.height !== previous.height) {
        previous = next; refresh();
      }
    });
  };
  const resize = new ResizeObserver(schedule); resize.observe(article); resize.observe(root);
  // Direct sibling replacement can preserve total article height while moving the body.
  const mutation = new MutationObserver(schedule); mutation.observe(article, { childList: true });
  return () => { resize.disconnect(); mutation.disconnect(); cancelAnimationFrame(frame); };
}

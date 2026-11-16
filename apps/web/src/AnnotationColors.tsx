import type { CSSProperties } from 'react';
import { Check } from 'lucide-react';
import type { MarkColor } from '@feedink/shared';
import { markColors } from './annotationData';

const colorLabels: Record<MarkColor, string> = { yellow: '黄色', green: '绿色', blue: '蓝色', lilac: '淡紫' };
const colors = Object.keys(markColors) as MarkColor[];

/** Roving radio buttons preserve the article selection and textarea caret on pointer use. */
export function AnnotationColors({ value, onChange, disabled, label = '批注颜色' }: { value: MarkColor; onChange: (color: MarkColor) => void; disabled?: boolean; label?: string }) {
  return <div className="annotation-colors" role="radiogroup" aria-label={label}>
    {colors.map((color, index) => <button key={color} type="button" className="annotation-swatch" role="radio" aria-checked={color === value} aria-label={colorLabels[color]} title={colorLabels[color]} tabIndex={color === value ? 0 : -1} disabled={disabled}
      onPointerDown={event => event.preventDefault()} onClick={() => onChange(color)}
      onKeyDown={event => {
        let next: number;
        if (event.key === 'ArrowRight' || event.key === 'ArrowDown') next = (index + 1) % colors.length;
        else if (event.key === 'ArrowLeft' || event.key === 'ArrowUp') next = (index + colors.length - 1) % colors.length;
        else if (event.key === 'Home') next = 0;
        else if (event.key === 'End') next = colors.length - 1;
        else return;
        event.preventDefault(); onChange(colors[next]);
        event.currentTarget.parentElement?.querySelectorAll<HTMLButtonElement>('[role=radio]')[next]?.focus({ preventScroll: true });
      }}>
      <span className="annotation-swatch-chip" data-color={color} style={{ '--swatch-color': markColors[color] } as CSSProperties}>{color === value && <Check size={16} strokeWidth={3} aria-hidden="true" />}</span>
    </button>)}
  </div>;
}

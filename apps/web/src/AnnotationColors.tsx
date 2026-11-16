import type { CSSProperties } from 'react';
import { Check } from 'lucide-react';
import type { MarkColor } from '@feedink/shared';
import { markColors } from './annotationData';

type InkColor = MarkColor | 'black';
const colorLabels: Record<InkColor, string> = { black: '黑色', yellow: '黄色', green: '绿色', blue: '蓝色', lilac: '淡紫' };
type ColorProps = { disabled?: boolean; label?: string } & (
  { includeBlack: true; value: InkColor; onChange: (color: InkColor) => void } |
  { includeBlack?: false; value: MarkColor; onChange: (color: MarkColor) => void }
);

/** Roving radio buttons preserve the article selection and textarea caret on pointer use. */
export function AnnotationColors(props: ColorProps) {
  const { value, disabled, label = '批注颜色' } = props;
  const colors: InkColor[] = [...(props.includeBlack ? ['black' as const] : []), ...Object.keys(markColors) as MarkColor[]];
  const onChange = (color: InkColor) => { if (props.includeBlack) props.onChange(color); else if (color !== 'black') props.onChange(color); };
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
      <span className="annotation-swatch-chip" data-color={color} style={{ '--swatch-color': color === 'black' ? '#000000' : markColors[color] } as CSSProperties}>{color === value && <Check size={16} strokeWidth={3} aria-hidden="true" />}</span>
    </button>)}
  </div>;
}

import type { NativePointer, NativePointerBatch, NativeSample } from './types.ts';
import { finite, record } from './validation.ts';

export const NATIVE_LIMITS = Object.freeze({ samples: 256, pendingPresentations: 32 });
export function nativeInteger(value: unknown, label: string): number {
  const result = finite(value, 0, Number.MAX_SAFE_INTEGER, label);
  if (!Number.isSafeInteger(result)) throw new Error(`Invalid ${label}`);
  return result;
}
/** Validate the whole MotionEvent before applying any of its history. No truncation. */
export function validateNativeBatch(value: unknown): NativePointerBatch {
  const batch = record(value, 'native batch');
  if (batch.version !== 1) throw new Error('Unsupported native batch version');
  const epoch = nativeInteger(batch.epoch, 'native epoch');
  const basis = nativeInteger(batch.basis, 'native basis');
  const gesture = nativeInteger(batch.gesture, 'native gesture');
  const sequence = nativeInteger(batch.sequence, 'native sequence');
  if (!Array.isArray(batch.samples) || !batch.samples.length || batch.samples.length > NATIVE_LIMITS.samples) {
    throw new Error('Native sample batch exceeds capacity');
  }
  let previousTime = -1, pointerId = -1;
  const samples: NativeSample[] = batch.samples.map((value, index, values) => {
    const sample = record(value, 'native sample');
    const id = nativeInteger(sample.id, 'pointer id');
    const type = sample.type as NativePointer['type'];
    if (!['down', 'move', 'up', 'cancel'].includes(type) || (type === 'down' && index !== 0) ||
      ((type === 'up' || type === 'cancel') && index !== values.length - 1) ||
      (index && id !== pointerId)) throw new Error('Invalid native sample order');
    const time = finite(sample.time, 0, Number.MAX_SAFE_INTEGER, 'native sample time');
    if (time < previousTime) throw new Error('Native sample time went backwards');
    previousTime = time; pointerId = id;
    if (sample.eraser !== undefined && typeof sample.eraser !== 'boolean') throw new Error('Invalid eraser flag');
    return { type, id, time, x: finite(sample.x, 0, 1, 'normalized pointer x'),
      y: finite(sample.y, 0, 1, 'normalized pointer y'), pressure: finite(sample.pressure, 0, 1, 'pointer pressure'),
      ...(sample.eraser === undefined ? {} : { eraser: sample.eraser }) };
  });
  return { version: 1, epoch, basis, gesture, sequence, samples };
}

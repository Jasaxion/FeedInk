import { MAX_IMAGE_BYTES, RASTER_IMAGE_MIME } from './logic';

/** Local raster bytes only. Data URLs render offline even where WebKit routes blob: loads through its offline network process. */
export function rasterImageSource(type: string, payload: ArrayBuffer | Uint8Array): string {
  const bytes = payload instanceof Uint8Array ? payload : new Uint8Array(payload);
  if (!RASTER_IMAGE_MIME.test(type) || bytes.byteLength > MAX_IMAGE_BYTES) throw new Error('无效的缓存图片');
  const chunks: string[] = [];
  for (let offset = 0; offset < bytes.length; offset += 32768) chunks.push(String.fromCharCode(...bytes.subarray(offset, offset + 32768)));
  return `data:${type};base64,${btoa(chunks.join(''))}`;
}

export function cachedImageSource(blob: Blob): Promise<string> {
  if (!RASTER_IMAGE_MIME.test(blob.type) || blob.size > MAX_IMAGE_BYTES) return Promise.reject(new Error('无效的缓存图片'));
  return new Promise((resolve, reject) => {
    const reader = new FileReader();
    reader.onload = () => typeof reader.result === 'string' ? resolve(reader.result) : reject(new Error('无法读取缓存图片'));
    reader.onerror = () => reject(reader.error || new Error('无法读取缓存图片'));
    reader.readAsDataURL(blob);
  });
}

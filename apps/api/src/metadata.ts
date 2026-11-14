import type { Enclosure } from "@feedink/shared";
export const xmlCharacters = (value: string) =>
  value.replace(
    /[^\u0009\u000a\u000d\u0020-\ud7ff\ue000-\ufffd\u{10000}-\u{10ffff}]/gu,
    "",
  );
export const boundedText = (value: unknown, limit: number) =>
  xmlCharacters(String(value ?? "").slice(0, limit));
export function normalizeEnclosures(
  input: unknown,
  baseUrl: string,
): Enclosure[] {
  if (!Array.isArray(input)) return [];
  return input.slice(0, 10).flatMap((item) => {
    if (!item || typeof item.url !== "string") return [];
    try {
      const url = new URL(item.url, baseUrl);
      if (
        !["http:", "https:"].includes(url.protocol) ||
        url.username ||
        url.password ||
        url.href.length > 4096
      )
        return [];
      const length = Number(item.length ?? item.size_in_bytes);
      return [
        {
          url: url.href,
          type: boundedText(
            item.type || item.mime_type || "application/octet-stream",
            200,
          ),
          ...(Number.isSafeInteger(length) && length >= 0 ? { length } : {}),
        },
      ];
    } catch {
      return [];
    }
  });
}

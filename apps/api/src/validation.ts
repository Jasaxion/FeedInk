import { xmlCharacters } from "./metadata.js";
import { z } from "zod";
import { DEFAULT_SETTINGS } from "@feedink/shared";
export const uuid = z.uuid();
export const name = z
  .string()
  .transform(xmlCharacters)
  .pipe(z.string().trim().min(1).max(160));
export const url = z.string().trim().min(1).max(4096);
export const color = z.string().regex(/^#[0-9a-fA-F]{6}$/);
export const preferences = z
  .object({
    view: z.enum(["magazine", "list", "grid"]).optional(),
    sort: z.enum(["newest", "oldest"]).optional(),
    unreadOnly: z.boolean().optional(),
    articleMode: z.enum(["feed", "fulltext", "webpage"]).optional(),
    pinned: z.boolean().optional(),
    muted: z.boolean().optional(),
  })
  .strict();
export const settingsPatch = z
  .object({
    theme: z.enum(["system", "light", "dark", "sepia", "eink"]),
    accent: color,
    fontFamily: z.enum(["system", "serif", "sans"]),
    fontSize: z.number().min(12).max(40),
    lineHeight: z.number().min(1).max(3),
    contentWidth: z.number().int().min(320).max(1600),
    view: z.enum(["magazine", "list", "grid"]),
    mobileView: z.enum(["magazine", "list", "grid"]),
    sort: z.enum(["newest", "oldest"]),
    unreadOnly: z.boolean(),
    showFeedIcons: z.boolean(),
    showThumbnails: z.boolean(),
    hideReadFeeds: z.boolean(),
    markReadOnScroll: z.boolean(),
    autoFulltext: z.boolean(),
    lazyImages: z.boolean(),
    hideToolbar: z.boolean(),
    tapToPage: z.boolean(),
    wrapCode: z.boolean(),
    // Custom CSS is declaration-only: no selectors, URLs, at-rules or DOM overlays.
    customCss: z
      .string()
      .max(2000)
      .refine(
        (s) =>
          !s ||
          s
            .split(";")
            .filter((s) => s.trim())
            .every(
              (s) =>
                /^\s*(color|background-color|font-size|font-family|font-weight|line-height|letter-spacing|text-align|text-indent|word-spacing)\s*:\s*[#\w\s.,%()'"-]+\s*$/i.test(
                  s,
                ) && !/(url|expression|var)\s*\(/i.test(s),
            ),
        "Only safe typography declarations are accepted",
      ),
    sidebarWidth: z.number().min(180).max(400),
    listWidth: z.number().min(240).max(800),
    speechRate: z.number().min(0.5).max(3),
    speechVoice: z.string().max(200),
    language: z.enum(["zh-CN", "en"]),
    offlineEnabled: z.boolean(),
    ebookEmail: z.union([z.email().max(254), z.literal("")]),
    ebookAutoSend: z.boolean(),
    ebookIntervalDays: z.number().int().min(1).max(365),
    ebookHour: z.number().int().min(0).max(23),
    ebookMinArticles: z.number().int().min(1).max(100),
    ebookMaxArticles: z.number().int().min(1).max(100),
    ebookLanguage: z.string().regex(/^[a-zA-Z]{2,8}(-[a-zA-Z0-9]{1,8})*$/),
    ebookKeepLinks: z.boolean(),
  })
  .partial()
  .strict();
export function validateSettings(existing: object, input: unknown) {
  const result = {
    ...DEFAULT_SETTINGS,
    ...existing,
    ...settingsPatch.parse(input),
  };
  if (result.ebookMinArticles > result.ebookMaxArticles)
    throw new z.ZodError([
      {
        code: "custom",
        path: ["ebookMinArticles"],
        message: "Minimum cannot exceed maximum",
      },
    ]);
  return result;
}
export const articleQuery = z
  .object({
    scope: z.enum(["all", "unread", "saved", "archive"]).default("all"),
    subscriptionId: uuid.optional(),
    folderId: uuid.optional(),
    tagId: uuid.optional(),
    q: z.string().max(200).optional(),
    sort: z.enum(["newest", "oldest"]).default("newest"),
    cursor: z.string().max(512).optional(),
    limit: z.coerce.number().int().min(1).max(100).default(50),
    before: z.iso.datetime().optional(),
    after: z.iso.datetime().optional(),
  })
  .strict();
export const statePatch = z
  .object({
    read: z.boolean().optional(),
    saved: z.boolean().optional(),
    tagIds: z.array(uuid).max(100).optional(),
    progress: z.number().min(0).max(1).optional(),
  })
  .strict();

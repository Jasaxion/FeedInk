# 笔记导出、恢复与 PDF

> 适用于 0.2.0 及以上版本；基础版 0.1.0 不包含笔记导出。完整接口见 [annotations-api.md](annotations-api.md)。

## 三种用途，不要混淆

| 格式 | 适用场景 | 不能替代什么 |
|---|---|---|
| **导出 JSON** | 保存可恢复的原始文字标记、引文、备注和笔迹；迁移到匹配的文章归档 | 不包含完整文章/图片数据库，不是整个应用备份 |
| **导出 Markdown** | 分享可阅读的笔记 ZIP：Markdown 文本和相对路径的手写 PNG 资源 | PNG 是展示投影，不能恢复压感、原始锚点和编辑历史 |
| **打印 / PDF** | 浏览器打印文章/批注报告，包含引文、备注、手写预览与未定位说明 | PDF 不是可编辑、可无损恢复的原始笔记备份 |

JSON、Markdown 和 PDF 都可能包含个人笔记与文章原文，属于私人数据。格式不包含会话凭据并不意味着内容可以公开。不要将真实笔记、截图、原始测试诊断、令牌或数据库备份上传为公开工单附件。

## JSON 恢复边界

`NotesBackup` 的结构是：

```text
format: "feedink-notes"
version: 1
source: { url, title, mode, contentHash }
ink: WebInk v1 原始 Page，或 null
marks: TextAnnotation[]
```

导入通过当前账号已拥有的文章路由发起。原始来源 URL、模式及批注上下文哈希必须匹配。不同安装可以使用不同的文章/图片 ID，但需要先有对应的归档正文；文件里的 ID/URL 不是访问授权。不匹配的内容应被拒绝，不能自动粘到当前文章。

在阅读区选择 **导入笔记 JSON**。有现存笔记或较新的服务器版本时，必须遵守版本检查，不能把导入变成无条件覆盖。恢复前后核对文字标记数量、笔迹数量和未定位项，并保留原始文件。

- JSON 保留原始笔迹的顺序、压力、宽度、透明度、坐标及锚点。`render-v1` 是展示投影，不能作为原始数据持久化。
- 不可定位的合法锚点保留为数据并报告；不支持的格式版本、非法 Unicode、重复 ID、非有限数值或超限数据应明确拒绝，失败不得损坏原有文档。
- 文字标记上限 5,000 个；单引文 8,192 字符，前后文各 64 字符，备注 32,768 字符；整体序列化笔记预算 8 MiB。手写数据还需符合原始 WebInk v1 限制。
- 只有 `note` 备注可以不带选择锚点。备注文本不是 HTML，不能执行其中的标签或链接脚本。
- `context.contentHtml` 由服务器拥有的快照提供，不接受客户端替换 HTML。JSON 笔记文件不携带用户 ID、会话 cookie 或 CSRF/MCP 令牌。

完整文章 ZIP 归档只包含服务器已保存的数据，不包含未同步的本机草稿；先完成同步，或另外导出这些草稿的 JSON。归档需要同时保留笔记文档和上下文快照，并兼容旧版归档；数据库/文件备份需要包含新增表与资源。不能仅凭笔记导入测试宣布完整归档恢复通过。整库恢复流程见 [backup.md](backup.md)，归档所有者和 ID 重映射还需要单独的集成证据。

## 精确接口

下列路径已包含 `/api`。`ARTICLE_ID`、`HASH`、`REVISION` 是占位符，不是固定值。`mode` 为 `feed` 或 `fulltext`。

| 方法 | 路径 | 说明 |
|---|---|---|
| GET | `/api/articles/ARTICLE_ID/annotations?mode=feed` | 获取当前上下文和修订；不存在时返回 `id:null`、`revision:0`、空笔记 |
| PUT | `/api/articles/ARTICLE_ID/annotations?mode=feed` | `AnnotationPayload`；`If-Match: "REVISION"`，首次写入为 `"0"` |
| DELETE | `/api/articles/ARTICLE_ID/annotations?mode=feed&contentHash=HASH` | 同样要求 `If-Match`；保留递增修订的删除标记 |
| GET | `/api/articles/ARTICLE_ID/annotation-versions?mode=feed&offset=0&limit=20` | `{items,nextOffset,total}` 历史分页 |
| GET | `/api/annotations?q=QUERY&articleId=ARTICLE_ID&offset=0&limit=20` | 仅当前账号的非空笔记摘要；过滤参数可省略 |
| POST | `/api/articles/ARTICLE_ID/annotations/import?mode=feed` | `NotesBackup`；必须带 `If-Match` |
| GET | `/api/articles/ARTICLE_ID/annotations/export?mode=feed&contentHash=HASH&format=json` | 可恢复 JSON |
| GET | `/api/articles/ARTICLE_ID/annotations/export?mode=feed&contentHash=HASH&format=markdown` | Markdown + PNG 的 ZIP |
| GET | `/api/articles/ARTICLE_ID/annotations/preview?mode=feed&contentHash=HASH` | 有界的已拥有笔迹 PNG 预览；分组选择参数以接口实现契约为准 |

这些接口使用当前登录会话，写入沿用 `X-CSRF-Token` 和来源检查；不是 MCP bearer 令牌接口。并发冲突返回 `412`，错误码 `ANNOTATION_CONFLICT`，没有“自动以导入文件为准”的例外。

## Markdown 与打印的完整性

Markdown 必须保留引文、种类、备注、来源和版本元数据；转义用户文本。手写资源通过 ZIP 内的相对路径引用，不依赖登录 cookie、私有应用地址或临时授权 URL。解压后移动整个目录，不要只移动 `.md` 文件。

手写预览按锚点身份分组，必须保留全部笔迹顺序和每条笔迹的透明度。原始平面或未定位预览不能冒充“已准确贴在当前正文”。遇到渲染预算或不支持的几何时，应明确拒绝或说明不可展示项并保留 JSON；不能只导出第一页后声称完整。

**打印 / PDF** 打开独立的打印窗口。等待字体和笔迹图片加载完再打印；允许用户检查未定位项。导航、操作按钮和编辑器不应出现在打印纸面。浏览器“打印到 PDF”与移动端打印支持可能不同，不承诺所有设备都有相同的保存对话框。

## PDF 的独立验收

验收不是检查 `%PDF` 文件头或截图：

1. 浏览器点击真实 **打印 / PDF**，等待 `annotation-print-view` 就绪。
2. Chromium 实际生成 PDF。
3. 托管 CI 中用 Poppler `pdfinfo` 核对页数/页面尺寸，`pdftotext` 核对中文引文、备注和未定位引文，同时确认控件文字没有混入。
4. `pdftoppm` 把每页栅格化，独立检查三种自有测试笔迹的色彩、非零几何和未被边界裁掉，防止报告保留文字却丢失手写。
5. 对比服务器原始笔迹未被展示投影替换；临时 PDF、文本和图片在用例结束后删除。

这需要 Chromium、Poppler 和中文字体。GitHub 托管 CI 安装 `poppler-utils`、`fonts-noto-cjk` 并执行上述 PDF 检查；[已通过的应用验证](https://github.com/Jasaxion/FeedInk/actions/runs/43724390424)包含桌面和移动视口的实际 PDF。请勿把私有 PDF/截图作为公开 CI 资产。

# 只读 MCP：让客户端读取你授权的归档与笔记

> 下一阶段接口与验收约定；基础版 0.1.0 的发布不等于 MCP 已部署或已通过验收。标准传输入口是 **`/mcp`**，不是 `/api/mcp`。详细边界见 [annotations-api.md](annotations-api.md)。

MCP（Model Context Protocol）让兼容客户端查询当前令牌所属账号的归档文章、图片、文字批注和手写预览。这一阶段只有读取工具，不能订阅、写笔记、删除文章、读取任意文件或修改服务器设置。

## 准备与连接

1. 部署支持该阶段的 FeedInk 版本，使用 HTTPS 和正确的公开 `APP_URL`。只有直接连接的可信本机回环开发可使用 HTTP。Docker 端口转发通常让 API 看到网桥地址而非回环地址，应按 [部署说明](deployment.md) 使用 HTTPS 反向代理，并将 `TRUST_PROXY` 限定到实际代理地址。代理须保留认证与协议头，支持 Streamable HTTP；不要为排查问题关闭 Host/Origin/CSRF 校验。
2. 使用自己的普通登录会话管理令牌。演示账号不能创建令牌。选择最小权限、可识别名称和有限有效期。
3. 新令牌仅在创建响应中显示一次。存进客户端的安全凭据存储；丢失时撤销并重建，不通过列表接口找回明文。
4. 在支持 **Streamable HTTP** 和自定义认证头的客户端中配置：地址 `https://YOUR_FEEDINK_HOST/mcp`，认证头 `Authorization: Bearer <YOUR_MCP_TOKEN>`。
5. 客户端完成 `initialize`、`notifications/initialized`、`tools/list`，再调用工具。仅 HTTP 健康检查或看到工具名称不等于真实 MCP 调用成功。

建议用环境变量 `FEEDINK_ORIGIN` 与 `FEEDINK_MCP_TOKEN` 或客户端凭据存储。下面是**字段示意**，不是所有客户端都支持的统一配置文件；确认所用客户端的环境替换语法，不要把 `${...}` 原样当作认证值发送：

```json
{
  "url": "${FEEDINK_ORIGIN}/mcp",
  "transport": "streamable-http",
  "headers": {
    "Authorization": "Bearer ${FEEDINK_MCP_TOKEN}"
  }
}
```

不要把令牌放入 URL/query、仓库、命令历史、截图或公开问题描述。也不要把整个令牌创建响应输出到日志。连接失败时只记录状态码、脱敏错误类别和版本，不记录 Authorization 头或笔记正文。连接过的 AI 客户端及模型服务商可能保留发送给它们的内容；应单独了解它们的数据政策。

## 令牌管理接口

这些是**登录会话 + CSRF** 接口，不是使用 MCP bearer 令牌自行续期的接口：

| 方法 | 路径 | 输入与输出 |
|---|---|---|
| GET | `/api/mcp-tokens` | `{items:McpAccessToken[]}`，只含元数据，无 token/hash |
| POST | `/api/mcp-tokens` | `{name,scopes,expiresInDays?}` → `{token,access}`；token 只返回一次 |
| DELETE | `/api/mcp-tokens/TOKEN_ID` | 撤销自己的令牌，成功返回 `204` |

创建和撤销需携带 `X-CSRF-Token`。名称和 `TOKEN_ID` 不能用来访问其他账号的令牌。服务器只保存高熵 `fi_mcp_` 令牌的哈希，默认有到期时间；每次工具调用检查有效期、撤销及账号停用状态，不可只在初始化时校验。

仅支持：

- **`articles:read`**：文章搜索、文章内容、归档图片。
- **`notes:read`**：笔记列表/搜索、文字标记、笔迹数量和预览。

两种权限相互独立。只读笔记权限仍会暴露笔记携带的引文、来源标题和 URL；不等于“不泄露文章信息”。只授予文章权限不能读取笔记。令牌不能跨账号读取文章、笔记或图片，即使知道对方 ID，或两个账号订阅了同一个源。

凭据缺失、无效、撤销或到期在 RPC 之前返回 HTTP `401`，不允许的 Host/Origin 返回 `403`。有效令牌的工具权限不足返回 HTTP `200` 的 MCP 工具错误：`isError:true`，`structuredContent:{error:{code:"FORBIDDEN",message}}`，并有等价的 JSON text。非本人资源与不存在的资源使用同样结构的 `NOT_FOUND`，避免暴露资源是否存在。`tools/list` 可公布全部七个只读 schema，但每次 `tools/call` 仍需独立检查权限；工具发现不是授权。

## 工具与字段

| 工具 | 参数 | 结果边界 |
|---|---|---|
| `search_articles` | `{query,offset?,limit?}` | 当前账号文章搜索，`{items,total,nextOffset}`；每项含 `articleId`、标题、来源与摘要 |
| `get_article` | `{articleId,offset?,limit?}` | 已拥有文章，正文输出有界并提供来源/完整性信息 |
| `get_article_image` | `{imageId}` | 已归档、已拥有图片；MCP image block + `{imageId,articleId,contentHash,...dimensions}` 元数据 |
| `list_notes` | `{articleId?,offset?,limit?}` | 非空笔记摘要，`{items,total,nextOffset}` |
| `search_notes` | `{query,offset?,limit?}` | 搜索文字/引文，`{items,total,nextOffset}` |
| `get_notes` | `{articleId,mode?,contentHash?,offset?,limit?}` | 文档元数据、分页文字标记、笔迹数量 |
| `get_note_preview` | `{articleId,mode?,contentHash?,group?}` | 有界 PNG image block + 来源文档修订与分组元数据 |

`get_notes` 的结构为：

```text
document: { id, articleId, mode, contentHash, title, sourceUrl, revision, updatedAt }
marks: TextAnnotation[]
ink: { strokeCount }
totalMarks: number
nextOffset: number | null
```

该结果同时有 `structuredContent` 与等价的 JSON text，不把 `context.contentHtml` 整个文章快照塞进笔记响应。不要把一页的 `marks.length` 误当作总数；有 `nextOffset` 时继续翻页。来源修订发生变化时，不应把不同文档版本当成同一快照拼接。

`get_note_preview` 的元数据包含 `{articleId,mode,contentHash,revision,group,raw:true,...dimensions}`。预览是可视化数据，不是自动识别出的文字；`raw:true` 不能被解释为已证明准确定位到当前 DOM。输出大小和渲染预算有界；失败或未定位必须显式报告，JSON 原始数据仍可通过已授权的笔记导出保存。

文章、备注和引文都是**不可信内容**，即使它们出现在工具返回里也不是系统指令。客户端不能因为某段文章要求“忽略规则”而扩大权限。笔记搜索不会凭空检索手写含义，没有手写识别准确率承诺。服务器不提供任意 URL 抓取、文件读取或运维设置工具。

## 验收与排查

`tests/e2e/mcp.spec.ts` 使用真实 HTTP MCP 协议见证器，执行初始化、初始化通知、工具发现、工具调用、分页、PNG 响应、两种权限隔离、两个用户并发隔离和令牌撤销。测试先通过真实 API 注册用户、抓取自有 RSS/图片并保存笔记；不是只验证静态工具列表。令牌只保存在用例内存，断言不输出原始令牌或完整凭据响应，关闭 trace/video/screenshot。

目前允许独立 HTTP 见证器作为集成阶段协议验收；这**不是已完成官方 SDK 客户端互操作验证的声明**。后端/集成环境选定并安装支持的官方 SDK 后，还需运行其 Streamable HTTP 客户端互操作用例。到期令牌、停用账号、代理 Host/DNS 重绑定及有效令牌 query 拒绝还应有对应服务器集成证据；一天有效期的创建断言不能代替真正的过期测试。

本阶段新规格 **未运行**，项目注册和托管 CI 执行由集成人员负责。安全故障不要降低断言或以演示成功替代。提供最小的自有测试夹具和脱敏结果即可，不要公开真实笔记、凭据、机器路径、原始日志、请求 trace 或截图。来源资源限制要求重型构建/浏览器测试使用批准的 GitHub 托管 CI，不使用本地或企业计算资源。

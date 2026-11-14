import sharp from "sharp";
import {
  type DB,
  type Config,
  type Row,
  type Store,
  id,
  hash,
  withConnection,
} from "./core.js";
import { countWords, htmlText } from "./content.js";
export async function seedDemo(
  pool: DB,
  store: Store,
  config: Config,
  user: Row,
) {
  return withConnection(pool, (db) =>
    store.writeTransaction(db, async (put) => {
      const groups = [
        { name: "每日阅读", feeds: ["FeedInk 手记", "开放网络"] },
        { name: "技术与生活", feeds: ["构建与思考", "慢生活实验室"] },
      ];
      const topics = [
        [
          "欢迎来到你的阅读空间",
          "这是一篇由 FeedInk 创作的示例文章。订阅、阅读状态、标签和图片都属于当前演示账号，其他读者不会看到你的更改。试着标记稍后阅读，再切换到收藏列表。",
        ],
        [
          "把值得保存的内容留在身边",
          "阅读不应受限于信息流的窗口。FeedInk 把已抓取的文章正文与图片保存在自己的服务器上。取消订阅只会停止新内容更新，不会抹去过去收藏的文字。",
        ],
        [
          "清晨的十分钟，留给阅读",
          "关掉通知，泡一杯茶。短暂而专注的阅读可以给一天带来新的想法。你可以调整字体与行距，选择适合自己的浅色、深色或墨水屏主题。",
        ],
        [
          "小屏幕上的大世界",
          "在手机上打开一篇文章，正文会成为阅读的中心。离线缓存使已保存的内容在断网时仍然可用；重新联网后，阅读状态会继续同步。",
        ],
        [
          "开放协议连接不同的声音",
          "RSS、Atom 和 JSON Feed 是开放的信息发布格式。一个阅读器就能整理不同网站的更新，而不必依赖某个社交平台的推荐算法。",
        ],
      ];
      let index = 0;
      for (const group of groups) {
        const folderId = id();
        await db`INSERT INTO folders(id,user_id,name,position) VALUES(${folderId},${user.id},${group.name},${index})`;
        for (const feedTitle of group.feeds) {
          const feedId = id(),
            subscriptionId = id();
          await db`INSERT INTO feeds(id,user_id,url,title,site_url,status,last_fetched_at,next_fetch_at) VALUES(${feedId},${user.id},${`${config.appUrl}/demo/${feedId}.xml`},${feedTitle},${config.appUrl},'ok',now(),'infinity')`;
          await db`INSERT INTO subscriptions(id,user_id,feed_id,title,folder_id,position) VALUES(${subscriptionId},${user.id},${feedId},${feedTitle},${folderId},${index})`;
          for (const [topic, paragraph] of topics) {
            const articleId = id(),
              imageId = id(),
              bytes = await sharp({
                create: {
                  width: 960,
                  height: 480,
                  channels: 3,
                  background: {
                    r: 110 + ((index * 17) % 100),
                    g: 150 + ((index * 11) % 80),
                    b: 190 + ((index * 7) % 60),
                  },
                },
              })
                .png()
                .toBuffer(),
              key = await put(bytes);
            const title = `${topic}${index > 4 ? " · " + feedTitle : ""}`,
              url = `${config.appUrl}/?article=${articleId}`;
            const html = `<h2>${topic}</h2><p>${paragraph}</p><figure><img src="/api/assets/${imageId}" alt="FeedInk 生成的柔和彩色画布"/><figcaption>本地生成的原创演示图片，不依赖第三方代理。</figcaption></figure><p>你可以用 J 和 K 在文章之间移动，用 Y 标记稍后阅读，用 M 切换已读状态。阅读器的每个动作都保存到这个独立账号中。</p><h3>慢下来，认真阅读</h3><p>这里没有复制其他服务的文章。每段示例文字都是为 FeedInk 编写的，用来展示真实的阅读与归档流程。</p>`;
            const text = htmlText(html);
            await db`INSERT INTO articles(id,user_id,feed_id,guid,feed_title,title,url,author,published_at,summary,content_html,content_text,content_hash,word_count,read,saved) VALUES(${articleId},${user.id},${feedId},${articleId},${feedTitle},${title},${url},'FeedInk',${new Date(Date.now() - index * 3600000)},${paragraph},${html},${text},${hash(html)},${countWords(text)},${index % 5 === 4},${index % 7 === 0})`;
            await db`INSERT INTO images(id,article_id,original_url,status,content_type,file_key,content_hash,captured_at) VALUES(${imageId},${articleId},${`${config.appUrl}/api/assets/${imageId}`},'cached','image/png',${key},${hash(bytes)},now())`;
            index++;
          }
        }
      }
      const tagId = id();
      await db`INSERT INTO tags(id,user_id,name,color) VALUES(${tagId},${user.id},'值得重读','#861dd4')`;
      await db`INSERT INTO article_tags(article_id,tag_id) SELECT id,${tagId} FROM articles WHERE user_id=${user.id} AND saved`;
    }),
  );
}

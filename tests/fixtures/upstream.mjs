import http from 'node:http';
import { pathToFileURL } from 'node:url';

export const PNG = Buffer.from('iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAIAAACQd1PeAAAADElEQVR4nGOos9oKAAKnAW7tJb1IAAAAAElFTkSuQmCC', 'base64');
export const WAV = Buffer.alloc(44 + 16000);
WAV.write('RIFF', 0); WAV.writeUInt32LE(WAV.length - 8, 4); WAV.write('WAVEfmt ', 8);
WAV.writeUInt32LE(16, 16); WAV.writeUInt16LE(1, 20); WAV.writeUInt16LE(1, 22);
WAV.writeUInt32LE(8000, 24); WAV.writeUInt32LE(16000, 28); WAV.writeUInt16LE(2, 32);
WAV.writeUInt16LE(16, 34); WAV.write('data', 36); WAV.writeUInt32LE(16000, 40);
const escapeXml = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;');

export function createUpstream() {
  let offline = false;
  let version = 1;
  const requests = [];
  return http.createServer(async (req, res) => {
    const url = new URL(req.url, `http://${req.headers.host}`);
    const base = url.origin;
    const send = (status, type, body, headers = {}) => {
      res.writeHead(status, { 'Content-Type': type, ...headers });
      res.end(body);
    };
    if (url.pathname === '/__health') return send(200, 'text/plain', 'ok');
    if (url.pathname === '/__control' && req.method === 'POST') {
      let body = '';
      for await (const chunk of req) { body += chunk; if (body.length > 1024) { req.destroy(); return; } }
      try {
        const value = JSON.parse(body);
        offline = value.offline ?? false;
        version = value.version ?? 1;
        if (value.reset) requests.length = 0;
        return send(200, 'application/json', JSON.stringify({ offline, version }));
      } catch { return send(400, 'text/plain', 'invalid control'); }
    }
    if (url.pathname === '/__requests') return send(200, 'application/json', JSON.stringify(requests));
    requests.push({ path: url.pathname, referer: req.headers.referer ?? null, conditional: req.headers['if-none-match'] ?? null });
    if (offline) return send(503, 'text/plain', 'Fixture origin is offline');
    const content = `<p>持久存档应该保留正文与图片，即使订阅源后来删除了旧文章。FeedInk 阅读测试。</p><p><img src="${base}/image.png" alt="归档图片" /></p><p><img data-src="${base}/protected-image.png" alt="防盗链图片" /></p><p><img srcset="${base}/image.png 1x, ${base}/image.png?large=1 2x" src="${base}/image.png" alt="响应式图片" /></p><script>window.__feedinkXss = true</script><img src="${base}/image.png" onerror="window.__feedinkXss=true"><a href="javascript:alert(1)">不可信链接</a>`;
    if (url.pathname === '/feed.xml') {
      const etag = `"fixture-${version}"`;
      if (req.headers['if-none-match'] === etag) return send(304, 'application/rss+xml', '', { ETag: etag });
      const items = version === 1 ? `<item><guid>quiet-reading-1</guid><title>墨水屏上的安静阅读</title><link>${base}/article/one</link><pubDate>Sat, 14 Nov 2026 09:00:00 GMT</pubDate><description><![CDATA[${content}]]></description><enclosure url="${base}/podcast.wav" type="audio/wav" length="${WAV.length}" /></item><item><guid>quiet-reading-2</guid><title>第二篇：慢慢读</title><link>${base}/article/two</link><pubDate>Fri, 13 Nov 2026 09:00:00 GMT</pubDate><description>一篇用于排序、未读和标签测试的独立文章。</description></item>` : `<item><guid>quiet-reading-3</guid><title>新一期的订阅</title><link>${base}/article/three</link><pubDate>Sun, 15 Nov 2026 09:00:00 GMT</pubDate><description>旧文章已经从这个RSS窗口消失，但不应从用户存档中消失。</description></item>`;
      return send(200, 'application/rss+xml; charset=utf-8', `<?xml version="1.0"?><rss version="2.0"><channel><title>FeedInk 本地阅读夹具</title><link>${base}</link><description>可控、安全的测试内容</description>${items}</channel></rss>`, { ETag: etag });
    }
    if (url.pathname === '/atom.xml') return send(200, 'application/atom+xml', `<?xml version="1.0"?><feed xmlns="http://www.w3.org/2005/Atom"><id>urn:feedink:atom</id><title>Atom 阅读测试</title><updated>2026-11-14T09:00:00Z</updated><link href="${base}"/><entry><id>urn:feedink:atom:one</id><title>Atom 文章</title><link href="${base}/article/atom"/><updated>2026-11-14T09:00:00Z</updated><content type="html">${escapeXml('<p>Atom 正文也要被保留。</p>')}</content></entry></feed>`);
    if (url.pathname === '/feed.json') return send(200, 'application/feed+json', JSON.stringify({ version: 'https://jsonfeed.org/version/1.1', title: 'JSON Feed 测试', home_page_url: base, feed_url: `${base}/feed.json`, items: [{ id: 'json-1', url: `${base}/article/json`, title: 'JSON Feed 文章', content_html: '<p>JSON Feed 也能长期保存。</p>', date_published: '2026-11-14T09:00:00Z' }] }));
    if (url.pathname === '/discover') return send(200, 'text/html', `<html><head><title>可发现的订阅站点</title><link rel="alternate" type="application/rss+xml" title="本地RSS" href="/feed.xml"></head><body>发现订阅</body></html>`);
    if (url.pathname === '/image.png') return send(200, 'image/png', PNG);
    if (url.pathname === '/podcast.wav') return send(200, 'audio/wav', WAV);
    if (url.pathname === '/protected-image.png') {
      if (req.headers.referer !== `${base}/article/one` || !req.headers['user-agent']) return send(403, 'text/plain', 'Referer required');
      return send(200, 'image/png', PNG);
    }
    if (url.pathname === '/evil-image.svg') return send(200, 'image/svg+xml', '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>');
    if (url.pathname === '/redirect-private') return send(302, 'text/plain', '', { Location: 'http://169.254.169.254/latest/meta-data/' });
    if (url.pathname === '/malformed.xml') return send(200, 'application/rss+xml', '<rss><channel><item>');
    if (url.pathname === '/xxe.xml') return send(200, 'application/rss+xml', '<!DOCTYPE rss [<!ENTITY xxe SYSTEM "file:///etc/passwd">]><rss><channel><title>&xxe;</title></channel></rss>');
    if (url.pathname.startsWith('/article/')) {
      const paragraphs = Array.from({ length: 10 }, (_, i) => `<p>第${i + 1}段。阅读不是追逐更新的速度，而是保存值得再次打开的文字。这个独立测试页面为全文提取提供足够正文，确保得到的不是导航、广告或者只剩链接的占位内容。</p>`).join('');
      return send(200, 'text/html; charset=utf-8', `<!doctype html><html lang="zh-CN"><head><title>完整的安静阅读文章</title></head><body><nav>这是不应混入正文的导航</nav><main><article><h1>完整的安静阅读文章</h1>${paragraphs}${content}</article></main></body></html>`);
    }
    return send(404, 'text/plain', 'Fixture not found');
  });
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  const server = createUpstream();
  server.listen(Number(process.env.FEEDINK_FIXTURE_PORT || 8899), '127.0.0.1', () => console.log('FeedInk test upstream ready'));
  for (const signal of ['SIGINT', 'SIGTERM']) process.on(signal, () => server.close(() => process.exit(0)));
}

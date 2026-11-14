import { test } from "node:test";
import assert from "node:assert/strict";
import { createServer } from "node:http";
import { once } from "node:events";
import { publicAddress, SafeFetcher } from "../src/network.js";
import { cleanHtml, raster } from "../src/content.js";
import { parseFeed, rejectXmlEntities } from "../src/feeds.js";
import { passwordHash, passwordMatches } from "../src/auth.js";
import { makeZip, readZip } from "../src/zip.js";
import { validateSettings } from "../src/validation.js";

test("network denies private, mapped, metadata and transition IP ranges", () => {
  for (const ip of [
    "127.0.0.1",
    "10.0.0.1",
    "172.16.0.2",
    "192.168.1.1",
    "169.254.169.254",
    "100.64.0.1",
    "0.0.0.0",
    "255.255.255.255",
    "::1",
    "::",
    "fc00::1",
    "fe80::1",
    "::ffff:127.0.0.1",
    "2002:7f00:1::",
    "2001:db8::1",
  ])
    assert.equal(publicAddress(ip), false, ip);
  for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700:4700::1111"])
    assert.equal(publicAddress(ip), true, ip);
});
test("network validates credentials, scheme, ports and every redirect", async () => {
  const safe = new SafeFetcher();
  for (const value of [
    "file:///etc/passwd",
    "http://u:p@example.com",
    "http://example.com:22",
    "gopher://example.com",
  ])
    assert.throws(() => safe.validate(value));
  await assert.rejects(safe.fetch("http://127.0.0.1/"), /not permitted/);
  const server = createServer((_request, response) => {
    response
      .writeHead(302, { Location: "http://169.254.169.254/latest/meta-data/" })
      .end();
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const port = (server.address() as any).port;
    await assert.rejects(
      new SafeFetcher(["127.0.0.1"]).fetch(`http://127.0.0.1:${port}/`),
      /not permitted/,
    );
  } finally {
    server.close();
    await once(server, "close");
  }
});
test("network enforces body and total request timeout", async () => {
  const server = createServer((request, response) => {
    if (request.url === "/slow") setTimeout(() => response.end("ok"), 100);
    else response.end("a".repeat(4096));
  });
  server.listen(0, "127.0.0.1");
  await once(server, "listening");
  try {
    const base = `http://127.0.0.1:${(server.address() as any).port}`,
      fetcher = new SafeFetcher(["127.0.0.1"]);
    await assert.rejects(fetcher.fetch(base, { maxBytes: 100 }), /large|limit/);
    await assert.rejects(
      fetcher.fetch(base + "/slow", { timeoutMs: 10 }),
      /timed out/,
    );
  } finally {
    server.closeAllConnections();
    server.close();
    await once(server, "close");
  }
});
test("sanitization removes active content, remote images, dangerous CSS and URL schemes", () => {
  const html = cleanHtml(
    '<script>alert(1)</script><iframe src="https://x.test"></iframe><p onclick="evil()" style="position:fixed">safe</p><img src="https://x.test/a.png" onerror="evil()"><a href="javascript:alert(1)">bad</a><img src="/api/assets/12345678-1234-1234-1234-123456789abc" alt="ok">',
  );
  assert.match(html, /safe/);
  assert.match(html, /\/api\/assets\//);
  for (const forbidden of [
    "script",
    "iframe",
    "onclick",
    "onerror",
    "javascript:",
    "style=",
    "https://x.test",
  ])
    assert.ok(!html.includes(forbidden), html);
  assert.throws(() =>
    validateSettings(
      {},
      { customCss: "background-image:url(https://attacker.invalid)" },
    ),
  );
  assert.throws(() => validateSettings({}, { customCss: "position: fixed" }));
  assert.equal(
    validateSettings({}, { customCss: "font-size: 20px; color: #123456" })
      .fontSize,
    18,
  );
});
test("raster decoder rejects SVG and HTML, including spoofed MIME payloads", async () => {
  await assert.rejects(
    raster(
      Buffer.from(
        '<svg xmlns="http://www.w3.org/2000/svg"><script>alert(1)</script></svg>',
      ),
    ),
    /unsupported|invalid/,
  );
  await assert.rejects(
    raster(Buffer.from("<html>not an image</html>")),
    /unsupported|invalid/,
  );
});
test("RSS, Atom and JSON Feed parsing preserves Unicode and rejects XXE", async () => {
  assert.throws(
    () =>
      rejectXmlEntities(
        '<!DOCTYPE x [<!ENTITY x SYSTEM "file:///etc/passwd">]><rss/>',
      ),
    /entities/,
  );
  const rss = await parseFeed(
    '<rss version="2.0"><channel><title>中文</title><link>https://example.org</link><item><guid>1</guid><title>你好</title><link>https://example.org/a</link><description><![CDATA[<p>正文</p>]]></description></item></channel></rss>',
    "https://example.org/feed",
  );
  assert.equal(rss.entries[0].title, "你好");
  assert.equal(rss.entries[0].html, "<p>正文</p>");
  const atom = await parseFeed(
    '<feed xmlns="http://www.w3.org/2005/Atom"><title>Atom</title><id>https://example.org</id><entry><id>urn:test:1</id><title>Entry</title><link href="https://example.org/1"/><content type="html">&lt;p&gt;Atom body&lt;/p&gt;</content></entry></feed>',
    "https://example.org/atom",
  );
  assert.equal(atom.entries[0].guid, "urn:test:1");
  assert.match(atom.entries[0].html, /Atom body/);
  const json = await parseFeed(
    JSON.stringify({
      version: "https://jsonfeed.org/version/1.1",
      title: "JSON",
      items: [{ id: "j", content_text: "<script>not markup</script>" }],
    }),
    "https://example.org/json",
  );
  assert.match(json.entries[0].html, /&lt;script&gt;/);
});
test("passwords have independent salts and constant-time verifier semantics", async () => {
  const a = await passwordHash("long-test-password"),
    b = await passwordHash("long-test-password");
  assert.notEqual(a, b);
  assert.equal(await passwordMatches("long-test-password", a), true);
  assert.equal(await passwordMatches("incorrect-password", a), false);
});
test("bounded ZIP reader preserves bytes and rejects unexpected traversal names", async () => {
  const zip = await makeZip([
    { name: "manifest.json", data: Buffer.from('{"version":1}') },
    { name: "images/a.png", data: Buffer.from("image") },
  ]);
  const entries = await readZip(zip);
  assert.equal(entries.get("images/a.png")?.toString(), "image");
  // Mutate a same-length central/local name, avoiding reliance on writer traversal protections.
  const hostile = await makeZip([
    { name: "safe/name", data: Buffer.from("hostile") },
  ]);
  const corrupted = Buffer.from(
    hostile.toString("latin1").replaceAll("safe/name", "../x/name"),
    "latin1",
  );
  await assert.rejects(readZip(corrupted), /ZIP|Unsafe|archive/);
});

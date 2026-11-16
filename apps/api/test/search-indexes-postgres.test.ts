import { test } from 'node:test';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { readFile, readdir } from 'node:fs/promises';
import postgres from 'postgres';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import type { ArticleQuery } from '@feedink/shared';
import { Articles } from '../src/articles.js';
import { createMcpServer } from '../src/mcp.js';
import { hash, iso, migrate, type Store } from '../src/core.js';
import type { Annotations } from '../src/annotations.js';

const hosted = process.env.GITHUB_ACTIONS === 'true' && process.env.RUNNER_ENVIRONMENT === 'github-hosted';
const enabled = hosted && process.env.TEST_DATABASE_URL && process.env.SEARCH_INDEXES_TEST === '1';
const migration = new URL('../migrations/010_search_indexes.sql', import.meta.url);
const prefixMigration = new URL('../migrations/011_search_prefix_index.sql', import.meta.url);
const indexNames = ['articles_content_text_trgm', 'articles_title_trgm', 'articles_url_trgm', 'articles_content_prefix_trgm'];

// Opt-in: needs CREATE DATABASE/CREATEROLE on a disposable hosted PostgreSQL.
// Separate databases test extension placement without moving/dropping a shared extension.
test('010_search_indexes + 011_search_prefix_index: exact API/MCP parity, extension schemas, transactional failure and source/CAS preservation', {
  skip: !enabled, timeout: 180000,
}, async t => {
  const admin = postgres(process.env.TEST_DATABASE_URL!, { max: 1, connection: { statement_timeout: '20000', lock_timeout: '3000' }, onnotice: () => {} });
  const role = `search_restricted_${randomUUID().replaceAll('-', '')}`;
  try {
    await admin.unsafe(`CREATE ROLE ${role} NOLOGIN`);
    for (const layout of ['install-public', 'existing-private'] as const) await t.test(layout, async layoutTest => {
      const database = `search_test_${randomUUID().replaceAll('-', '')}`;
      const schema = 'search_app', extensionSchema = 'search extension';
      const url = new URL(process.env.TEST_DATABASE_URL!); url.pathname = `/${database}`;
      await admin.unsafe(`CREATE DATABASE ${database} TEMPLATE template0`);
      const setup = postgres(url.toString(), { max: 1, onnotice: () => {} });
      const db = postgres(url.toString(), { max: 4, connection: { search_path: schema, statement_timeout: '20000', lock_timeout: '3000' }, onnotice: () => {} });
      const articles = new Articles(db);
      const owner = randomUUID(), other = randomUUID(), feed = randomUUID(), dormant = randomUUID();
      const subscription = randomUUID(), folder = randomUUID(), tag = randomUUID(), foreignTag = randomUUID();
      const clients: Client[] = [], servers: ReturnType<typeof createMcpServer>[] = [];
      try {
        await setup.unsafe(`CREATE SCHEMA ${schema}`);
        await setup.unsafe(`GRANT USAGE ON SCHEMA ${schema} TO ${role}`);
        if (layout === 'existing-private') {
          await setup.unsafe(`CREATE SCHEMA "${extensionSchema}"`);
          await setup.unsafe(`CREATE EXTENSION pg_trgm WITH SCHEMA "${extensionSchema}"`);
        }
        await db`CREATE TABLE schema_migrations(name text PRIMARY KEY,checksum text NOT NULL,applied_at timestamptz NOT NULL DEFAULT now())`;
        const directory = new URL('../migrations/', import.meta.url);
        for (const name of (await readdir(directory)).filter(n => n.endsWith('.sql') && n < '010_search_indexes.sql').sort()) {
          const source = await readFile(new URL(name, directory), 'utf8');
          await db.begin(async sql => {
            await sql.unsafe(source);
            await sql`INSERT INTO schema_migrations(name,checksum) VALUES(${name},${hash(source)})`;
          });
        }
        for (const id of [owner, other]) await db`INSERT INTO users(id,email,name,password_hash) VALUES(${id},${id + '@example.invalid'},'Synthetic','disabled')`;
        await db`INSERT INTO folders(id,user_id,name) VALUES(${folder},${owner},'Synthetic')`;
        for (const id of [feed, dormant]) await db`INSERT INTO feeds(id,user_id,url,title) VALUES(${id},${owner},${'https://example.invalid/' + id},'Synthetic')`;
        await db`INSERT INTO subscriptions(id,user_id,feed_id,folder_id,title) VALUES(${subscription},${owner},${feed},${folder},'Synthetic')`;
        await db`INSERT INTO tags(id,user_id,name) VALUES(${tag},${owner},'Synthetic'),(${foreignTag},${other},'Foreign')`;
        const fixture = [
          ['TitleNeedle', 'neutral', 'plain'],
          ['neutral', 'BodyNeedle', 'plain'],
          ['orbit', 'distant launch', 'plain'], // FTS-only: no contiguous "orbit launch".
          ['中文語 école Ελληνικά', 'x', 'plain'],
          ['literal %', 'neutral', 'plain'],
          ['literal _', 'neutral', 'plain'],
          ['literal \\', 'neutral', 'plain'],
          ['neutral', 'neutral', 'urlneedle%_\\'],
          ['literal decoy', '100ABZ aXb', 'plain'],
          ['100%_\\ a%b a_b', 'neutral', 'plain'],
          ['TitleNeedle', 'BodyNeedle', 'plain'],
          ['', '', 'plain'],
        ];
        const ids: string[][] = [];
        for (const [account, userId] of [owner, other].entries()) {
          ids[account] = [];
          for (const [i, [title, body, urlPart]] of fixture.entries()) {
            const id = randomUUID(); ids[account].push(id);
            await db`INSERT INTO articles(id,user_id,feed_id,guid,feed_title,title,url,published_at,content_html,content_text,content_hash,read,saved)
              VALUES(${id},${userId},${account || i % 3 === 0 ? null : i % 3 === 1 ? feed : dormant},${id},'Synthetic',${title},${'https://example.invalid/' + urlPart},
                '2026-01-01'::timestamptz + ${i % 3} * interval '1 microsecond',${'<p>' + body + '</p>'},${body},${hash(body)},${i % 2 === 0},${i % 3 === 0})`;
            if (!account && i % 2 === 0) await db`INSERT INTO article_tags(article_id,tag_id) VALUES(${id},${tag})`;
          }
        }
        const tools = new Map<string, Client>();
        for (const userId of [owner, other]) {
          const server = createMcpServer(db, {} as Store, {} as Annotations, { userId, tokenId: randomUUID(), scopes: ['articles:read'] });
          const client = new Client({ name: 'search-index-parity', version: '1.0.0' });
          servers.push(server); clients.push(client);
          const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
          await server.connect(serverTransport); await client.connect(clientTransport); tools.set(userId, client);
        }
        const mcpPage = async (userId: string, query: string, offset = 0, limit = 2) => {
          const result = await tools.get(userId)!.callTool({ name: 'search_articles', arguments: { query, offset, limit } });
          assert.ok(!result.isError);
          return result.structuredContent as { total: number; items: { articleId: string; sourceUrl: string }[]; nextOffset: number | null };
        };
        const queries = ['', ' ', 'titleneedle', 'BodyNeedle', 'orbit launch', '中文', '文', 'école', 'Ελληνικά', 'x', '%', '_', '\\', '100%_\\', 'a%b', 'a_b', 'urlneedle', 'never-occurs'];
        const snapshot = async () => {
          const results: unknown[] = [];
          for (const userId of [owner, other]) for (const q of queries) {
            for (const sort of ['newest', 'oldest'] as const) {
              const query: ArticleQuery = { scope: 'archive', q, sort, limit: 2 };
              const seen: string[] = [], pages = []; let cursor: string | undefined;
              const complete = await articles.page(userId, { ...query, limit: 100 });
              do {
                const page = await articles.page(userId, { ...query, cursor });
                assert.equal(page.total, complete.total);
                seen.push(...page.items.map(a => a.id)); pages.push(page);
                assert.ok(pages.length <= fixture.length + 1, 'cursor must terminate');
                cursor = page.nextCursor || undefined;
              } while (cursor);
              assert.deepEqual(seen, complete.items.map(a => a.id));
              assert.equal(new Set(seen).size, complete.total);
              assert.ok(seen.every(id => ids[userId === owner ? 0 : 1].includes(id)));
              results.push(pages);
            }
            const complete = await mcpPage(userId, q, 0, 100), pages = [], seen: string[] = [];
            let offset: number | null = 0;
            do {
              const page = await mcpPage(userId, q, offset);
              assert.equal(page.total, complete.total); pages.push(page); seen.push(...page.items.map(a => a.articleId));
              assert.ok(pages.length <= fixture.length + 1, 'offset must terminate'); offset = page.nextOffset;
            } while (offset !== null);
            assert.deepEqual(seen, complete.items.map(a => a.articleId));
            assert.equal(new Set(seen).size, complete.total);
            assert.ok(seen.every(id => ids[userId === owner ? 0 : 1].includes(id)));
            results.push(pages);
          }
          for (const scope of ['archive', 'all', 'unread', 'saved'] as const) for (const filter of [{}, { subscriptionId: subscription }, { folderId: folder }, { tagId: tag }, { tagId: foreignTag }, { after: '2026-01-01T00:00:00Z' }, { before: '2026-01-02T00:00:00Z' }]) {
            results.push(await articles.page(owner, { scope, ...filter, q: 'TitleNeedle' }));
            assert.equal((await articles.page(other, { scope, ...filter, subscriptionId: subscription, q: 'TitleNeedle' })).total, 0);
          }
          // Hand-checked cases supplement parity: escaping must not act as wildcards;
          // API retains FTS union semantics, while MCP remains literal + source URL only.
          for (const [q, expected] of [['%', [4, 9]], ['_', [5, 9]], ['\\', [6, 9]], ['orbit launch', [2]], ['urlneedle', []]] as const) {
            const page = await articles.page(owner, { scope: 'archive', q });
            assert.deepEqual(page.items.map(a => a.id).sort(), expected.map(i => ids[0][i]).sort());
          }
          assert.equal((await mcpPage(owner, 'orbit launch')).total, 0);
          assert.deepEqual((await mcpPage(owner, 'urlneedle')).items.map(a => a.articleId), [ids[0][7]]);
          return results;
        };
        const before = await snapshot();
        const sources = await db`SELECT row_to_json(a)::text AS source,ctid::text,xmin::text FROM articles a ORDER BY id`;
        const [{ relfilenode }] = await db`SELECT relfilenode FROM pg_class WHERE oid='articles'::regclass`;
        const source = await readFile(migration, 'utf8');
        await assert.rejects(db.begin(async sql => {
          await sql.unsafe(`SET LOCAL ROLE ${role}`);
          await sql.unsafe(source);
        }), (error: any) => error.code === '42501' && /pg_trgm/.test(error.message));
        assert.equal((await db`SELECT 1 FROM schema_migrations WHERE name='010_search_indexes.sql'`).length, 0);
        if (layout === 'install-public') {
          // An actual conflicting writer lock must time out and leave no partial DDL/checksum.
          await setup`BEGIN`;
          try {
            await setup.unsafe(`LOCK TABLE ${schema}.articles IN ROW EXCLUSIVE MODE`);
            await assert.rejects(migrate(db), (error: any) => error.code === '55P03');
          } finally { await setup`ROLLBACK`; }
          assert.equal((await db`SELECT 1 FROM schema_migrations WHERE name='010_search_indexes.sql'`).length, 0);
          assert.equal((await db`SELECT 1 FROM pg_indexes WHERE schemaname=${schema} AND indexname IN ${db(indexNames)}`).length, 0);
        } else {
          // Fail on the third build: the preceding two indexes must roll back,
          // not leave a partially indexed schema or trust an unrelated namesake.
          await db`CREATE INDEX articles_url_trgm ON articles(id)`;
          await assert.rejects(migrate(db), (error: any) => error.code === '42P07');
          assert.equal((await db`SELECT 1 FROM schema_migrations WHERE name='010_search_indexes.sql'`).length, 0);
          const remaining = await db`SELECT indexname FROM pg_indexes WHERE schemaname=${schema} AND indexname IN ${db(indexNames)}`;
          assert.deepEqual(remaining.map(i => i.indexname), ['articles_url_trgm']);
          await db`DROP INDEX articles_url_trgm`;
        }
        // Apply 010, then fail 011 on a conflicting index name. The checksum
        // runner commits each migration separately; 010 must survive 011 failure.
        await db`CREATE INDEX articles_content_prefix_trgm ON articles(id)`;
        await assert.rejects(migrate(db), (error: any) => error.code === '42P07');
        assert.equal((await db`SELECT 1 FROM schema_migrations WHERE name='010_search_indexes.sql'`).length, 1);
        assert.equal((await db`SELECT 1 FROM schema_migrations WHERE name='011_search_prefix_index.sql'`).length, 0);
        assert.equal((await db`SELECT indexname FROM pg_indexes WHERE schemaname=${schema} AND indexname IN ${db(indexNames)}`).length, 4);
        await db`DROP INDEX articles_content_prefix_trgm`;
        await migrate(db);
        const prefixSource = await readFile(prefixMigration, 'utf8');
        const prefixApplied = await db`SELECT * FROM schema_migrations WHERE name='011_search_prefix_index.sql'`;
        assert.equal(prefixApplied[0].checksum, hash(prefixSource));
        const applied = await db`SELECT * FROM schema_migrations WHERE name='010_search_indexes.sql'`;
        assert.equal(applied[0].checksum, hash(source));
        await migrate(db); // checksum runner idempotence, not IF NOT EXISTS masking a bad index.
        assert.deepEqual(await db`SELECT * FROM schema_migrations WHERE name='010_search_indexes.sql'`, applied);
        assert.deepEqual(await db`SELECT * FROM schema_migrations WHERE name='011_search_prefix_index.sql'`, prefixApplied);
        assert.equal((await db`SHOW search_path`)[0].search_path, schema);
        const [extension] = await db`SELECT n.nspname FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_trgm'`;
        assert.equal(extension.nspname, layout === 'install-public' ? 'public' : extensionSchema);
        const indexes = await db`SELECT c.relname,i.indisvalid,i.indisready FROM pg_index i JOIN pg_class c ON c.oid=i.indexrelid WHERE i.indrelid='articles'::regclass AND c.relname IN ${db([...indexNames, 'articles_search'])} ORDER BY c.relname`;
        assert.equal(indexes.length, 5); assert.ok(indexes.every(i => i.indisvalid && i.indisready));
        assert.equal((await db`SELECT relfilenode FROM pg_class WHERE oid='articles'::regclass`)[0].relfilenode, relfilenode);
        assert.deepEqual(await db`SELECT row_to_json(a)::text AS source,ctid::text,xmin::text FROM articles a ORDER BY id`, sources, 'no source tuple rewrite');
        await db`ANALYZE articles`;
        assert.deepEqual(await snapshot(), before, 'exact ordered API/MCP pages and totals before/after');
        // Indexability only, NOT a default-planner or latency assertion on a tiny fixture.
        for (const [column, index] of [['title', 'articles_title_trgm'], ['content_text', 'articles_content_text_trgm'], ['url', 'articles_url_trgm'], ['left(content_text,256)', 'articles_content_prefix_trgm']]) {
          const plan = await db.begin(async sql => {
            await sql`SET LOCAL enable_seqscan=off`;
            return sql.unsafe(`EXPLAIN (FORMAT JSON) SELECT id FROM articles WHERE ${column} ILIKE '%needle%'`);
          });
          assert.ok(JSON.stringify(plan).includes(index));
        }
        if (layout === 'install-public') await layoutTest.test('article-search: bounded prefix, full late/cross-boundary fallback and caseless parity', async () => {
          const witnessIds: string[][] = [[], []];
          const bodies = [
            'prefixwitness ÉCOLE İΣß %_\\[] ' + 'z'.repeat(32768),
            'z'.repeat(32768) + ' latewitness ÉCOLE İΣß %_\\[]',
            'z'.repeat(250) + 'boundarywitness',
          ];
          try {
            for (const [account, userId] of [owner, other].entries()) for (const body of bodies) {
              const id = randomUUID(); witnessIds[account].push(id);
              await db`INSERT INTO articles(id,user_id,guid,feed_title,title,url,published_at,content_html,content_text,content_hash)
                VALUES(${id},${userId},${id},'Synthetic','neutral','https://example.invalid/witness','2026-01-01',${'<p>' + body + '</p>'},${body},${hash(body)})`;
            }
            const cases: [string, number[]][] = [
              ['prefixwitness', [0]], ['latewitness', [1]], ['boundarywitness', [2]],
              ['absentwitness', []], ['%_\\[]', [0, 1]], ['é', [0, 1]],
            ];
            for (const [account, userId] of [owner, other].entries()) for (const [query, expected] of cases) {
              const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
              const apiExpected = await db`SELECT id FROM articles WHERE user_id=${userId} AND (to_tsvector('simple',title || ' ' || content_text) @@ plainto_tsquery('simple',${query}) OR title ILIKE ${pattern} OR content_text ILIKE ${pattern}) ORDER BY published_at DESC,id DESC`;
              const mcpExpected = await db`SELECT id FROM articles WHERE user_id=${userId} AND (title ILIKE ${pattern} OR url ILIKE ${pattern} OR content_text ILIKE ${pattern}) ORDER BY published_at DESC,id`;
              // scale-benchmark's independent full-content literal oracle.
              const regex = query.replace(/[\\^$.*+?()[\]{}|]/g, '\\$&');
              const bytes = db`(strpos(title,${query})>0 OR strpos(url,${query})>0 OR strpos(content_text,${query})>0)`;
              const folded = db`(title ~* ${regex} OR url ~* ${regex} OR content_text ~* ${regex})`;
              const referenceMatch = /^[\x20-\x40\x5b-\x60\x7b-\x7e]+$/.test(query) ? bytes : query.length < 3 ? db`(${bytes} OR ${folded})` : folded;
              const reference = await db`SELECT id FROM articles WHERE user_id=${userId} AND ${referenceMatch} ORDER BY published_at DESC,id`;
              assert.deepEqual(reference, mcpExpected);
              const api = await articles.page(userId, { scope: 'archive', q: query, limit: 100 });
              const mcp = await mcpPage(userId, query, 0, 100);
              assert.equal(api.total, apiExpected.length); assert.equal(mcp.total, mcpExpected.length);
              assert.deepEqual(api.items.map(a => a.id), apiExpected.map(a => a.id));
              assert.deepEqual(mcp.items.map(a => a.articleId), mcpExpected.map(a => a.id));
              for (const actual of [api.items.map(a => a.id), mcp.items.map(a => a.articleId)]) {
                assert.deepEqual(actual.filter(id => witnessIds[account].includes(id)).sort(), expected.map(i => witnessIds[account][i]).sort());
                assert.ok(actual.every(id => !witnessIds[1 - account].includes(id)), 'foreign prefix/late witnesses stay excluded');
              }
            }
            for (const query of ['%_', '\\']) {
              assert.equal((await db`SELECT numnode(plainto_tsquery('simple',${query})) AS nodes`)[0].nodes, 0);
              const { condition } = articles.selection(owner, { scope: 'archive', q: query }, false);
              const plan = await db`EXPLAIN (FORMAT JSON) SELECT a.id FROM articles a WHERE ${condition}`;
              assert.ok(!JSON.stringify(plan).includes('to_tsvector'), 'zero-node constant guard removes vector construction');
            }
          } finally { await db`DELETE FROM articles WHERE id IN ${db(witnessIds.flat())}`; }
        });
        if (layout === 'install-public') await layoutTest.test('contextual ICU case folding cannot turn a truncated prefix into a false match', async () => {
          const [original] = await db`SELECT n.nspname,c.collname FROM pg_attribute a JOIN pg_collation c ON c.oid=a.attcollation JOIN pg_namespace n ON n.oid=c.collnamespace WHERE a.attrelid='articles'::regclass AND a.attname='content_text'`;
          await db`CREATE COLLATION contextual_case (provider=icu,locale='und',deterministic=true)`;
          const witness = randomUUID();
          try {
            await db`ALTER TABLE articles ALTER COLUMN content_text TYPE text COLLATE contextual_case USING content_text`;
            const text = 'x'.repeat(255) + 'ΣΑ';
            await db`INSERT INTO articles(id,user_id,guid,feed_title,title,url,published_at,content_html,content_text,content_hash) VALUES(${witness},${owner},${witness},'Synthetic','neutral','https://example.invalid/contextual-case','2026-01-01',${'<p>' + text + '</p>'},${text},${hash(text)})`;
            const [demonstration] = await db`SELECT left(content_text,256) ILIKE '%ς%' AS prefix,content_text ILIKE '%ς%' AS complete FROM articles WHERE id=${witness}`;
            assert.equal(demonstration.prefix, true); assert.equal(demonstration.complete, false);
            for (const query of ['ς', 'σ', '%_']) {
              const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
              const expectedApi = await db`SELECT id FROM articles WHERE user_id=${owner} AND (title ILIKE ${pattern} OR content_text ILIKE ${pattern} OR to_tsvector('simple',title || ' ' || content_text) @@ plainto_tsquery('simple',${query})) ORDER BY published_at DESC,id DESC`;
              const expectedMcp = await db`SELECT id FROM articles WHERE user_id=${owner} AND (title ILIKE ${pattern} OR url ILIKE ${pattern} OR content_text ILIKE ${pattern}) ORDER BY published_at DESC,id`;
              const page = await articles.page(owner, { scope: 'archive', q: query, limit: 100 }), mcp = await mcpPage(owner, query, 0, 100);
              assert.equal(page.total, expectedApi.length); assert.equal(mcp.total, expectedMcp.length);
              assert.deepEqual(page.items.map(item => item.id), expectedApi.map(item => item.id));
              assert.deepEqual(mcp.items.map(item => item.articleId), expectedMcp.map(item => item.id));
            }
          } finally {
            await db`DELETE FROM articles WHERE id=${witness}`;
            const [restore] = await db`SELECT format('ALTER TABLE articles ALTER COLUMN content_text TYPE text COLLATE %I.%I USING content_text',${original.nspname},${original.collname}) AS statement`;
            await db.unsafe(restore.statement); await db`DROP COLLATION contextual_case`;
          }
        });
        if (layout === 'install-public') await layoutTest.test('articles.selection literal-first and mcp.search_articles split shapes retain legacy exact results after repeated callbacks', async () => {
          const statements: string[] = [];
          const callbackDb = postgres(url.toString(), { max: 1, connection: { search_path: schema, statement_timeout: '20000' }, onnotice: () => {}, debug: (_id, query) => { statements.push(query); } });
          const current = new Articles(callbackDb);
          const server = createMcpServer(callbackDb, {} as Store, {} as Annotations, { userId: owner, tokenId: randomUUID(), scopes: ['articles:read'] });
          const client = new Client({ name: 'search-query-regression', version: '1.0.0' });
          try {
            // One small witness set, not another traversal/filter matrix. The
            // original OR order is an independent query-shape parity reference.
            const witnesses: ArticleQuery[] = [
              { q: 'TitleNeedle', scope: 'all', folderId: folder, tagId: tag, after: '2025-01-01T00:00:00Z' },
              { q: 'orbit launch', scope: 'archive' }, { q: '文', scope: 'archive' },
              { q: '%', scope: 'saved' }, { q: '\\', scope: 'archive' },
            ];
            for (const query of witnesses) {
              const { condition } = articles.selection(owner, { ...query, q: undefined }, false);
              const pattern = `%${query.q!.replace(/[\\%_]/g, '\\$&')}%`;
              const legacy = await db`SELECT a.id FROM articles a WHERE ${condition} AND (to_tsvector('simple',a.title || ' ' || a.content_text) @@ plainto_tsquery('simple',${query.q!}) OR a.title ILIKE ${pattern} OR a.content_text ILIKE ${pattern}) ORDER BY a.published_at DESC,a.id DESC`;
              statements.length = 0;
              const page = await current.page(owner, { ...query, limit: 100 });
              assert.equal(page.total, legacy.length);
              assert.deepEqual(page.items.map(a => a.id), legacy.map(a => a.id));
              const count = statements.find(q => q.startsWith('SELECT count(*)') && q.includes('to_tsvector'))!;
              assert.ok(count && count.indexOf('left(a.content_text,256)') < count.indexOf('to_tsvector'), 'bounded literal checks precede FTS in emitted SQL');
            }
            const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
            await server.connect(serverTransport); await client.connect(clientTransport);
            const shapes = new Map<boolean, Set<string>>(), executions = new Map<string, number>();
            for (const query of ['', ...Array<string>(6).fill('TitleNeedle'), '%', 'urlneedle', ' ', '']) {
              const pattern = `%${query.replace(/[\\%_]/g, '\\$&')}%`;
              const where = db`user_id=${owner} AND (${query}='' OR title ILIKE ${pattern} OR url ILIKE ${pattern} OR content_text ILIKE ${pattern})`;
              const [{ total }] = await db`SELECT count(*)::integer AS total FROM articles WHERE ${where}`;
              const rows = await db`SELECT id,title,url,left(summary,400) AS summary,published_at FROM articles WHERE ${where} ORDER BY published_at DESC,id OFFSET 1 LIMIT 2`;
              statements.length = 0;
              const result = await client.callTool({ name: 'search_articles', arguments: { query, offset: 1, limit: 2 } });
              assert.ok(!result.isError);
              assert.deepEqual(result.structuredContent, { items: rows.map(r => ({ articleId: r.id, title: r.title, sourceUrl: r.url, summary: r.summary, publishedAt: iso(r.published_at) })), total, nextOffset: 1 + rows.length < total ? 1 + rows.length : null });
              assert.equal(statements.length, 2, 'actual callback emits count and page');
              assert.ok(statements.every(q => !q.includes("=''")));
              assert.ok(statements.every(q => / I?LIKE /.test(q) === (query !== '')));
              statements.forEach(q => executions.set(q, (executions.get(q) || 0) + 1));
              const set = shapes.get(query !== '') || new Set<string>();
              statements.forEach(q => set.add(q)); shapes.set(query !== '', set);
            }
            assert.equal(shapes.get(false)!.size, 2); assert.equal(shapes.get(true)!.size, 4);
            // max:1 keeps these actual callbacks on the backend queried here.
            const prepared = await callbackDb`SELECT statement,generic_plans::integer + custom_plans::integer AS executions FROM pg_prepared_statements`;
            for (const statement of shapes.get(true)!)
              assert.ok(prepared.some(p => p.statement === statement && p.executions >= executions.get(statement)!), 'actual nonempty callback statement execution count');
            assert.ok([...executions].some(([statement, count]) => statement.includes(' ILIKE ') && count >= 6), 'cased shape crosses custom-plan sampling window');
          } finally { await client.close(); await server.close(); await callbackDb.end({ timeout: 5 }); }
        });
        const changed = await articles.patch(owner, ids[0][0], { read: false, saved: true }, 0);
        assert.equal(changed.stateVersion, 1);
        await assert.rejects(articles.patch(owner, ids[0][0], { read: true }, 0), (e: any) => e.code === 'STATE_CONFLICT');
        await assert.rejects(articles.patch(other, ids[0][0], { read: true }), (e: any) => e.code === 'NOT_FOUND');
        const total = (await articles.page(owner, { scope: 'archive', q: 'TitleNeedle' })).total;
        assert.equal((await articles.bulk(owner, true, undefined, { scope: 'archive', q: 'TitleNeedle' })).updated, total);
        assert.equal((await db`SELECT scale_audit_counts()::integer AS drift`)[0].drift, 0);
      } finally {
        await Promise.all(clients.map(c => c.close()));
        await Promise.all(servers.map(s => s.close()));
        await db.end({ timeout: 5 }); await setup.end({ timeout: 5 });
        await admin.unsafe(`DROP DATABASE ${database} WITH (FORCE)`);
      }
    });
  } finally {
    await admin.unsafe(`DROP ROLE IF EXISTS ${role}`);
    await admin.end({ timeout: 5 });
  }
});

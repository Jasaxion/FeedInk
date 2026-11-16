// Synthetic hosted-only rehearsal, not a production capacity/SLA assertion.
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { readFile, mkdir, writeFile } from 'node:fs/promises';
import { cpus, totalmem, platform, release } from 'node:os';
import { join } from 'node:path';
import { performance } from 'node:perf_hooks';
import postgres from 'postgres';
import { Articles } from '../apps/api/dist/articles.js';
import { uuid } from '../apps/api/dist/validation.js';
import { articleWrite } from '../apps/api/dist/scale-counts.js';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createMcpServer } from '../apps/api/dist/mcp.js';

if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
  throw new Error('Scale workloads require approved GitHub-hosted infrastructure');
const tier = Number(process.env.SCALE_ARTICLES || '10000');
if (![10000, 100000, 1000000].includes(tier) || !process.env.TEST_DATABASE_URL || !process.env.RUNNER_TEMP)
  throw new Error('Require an allowed tier and the disposable hosted test database');
const searchMode = process.env.SCALE_SEARCH_INDEXES || 'before';
if (!['before', 'compare'].includes(searchMode) || (searchMode === 'compare' && tier !== 10000))
  throw new Error('SCALE_SEARCH_INDEXES accepts before or compare; compare is restricted to the approved 10k tier');
const compareSearch = searchMode === 'compare';
const output = join(process.env.RUNNER_TEMP, `scale-evidence-${tier}`);
await mkdir(output, { recursive: true });
const started = performance.now(), deadline = started + 30 * 60_000;
const budgets = { wallSeconds: 1800, statementMs: 10000, seedBatchMs: 120000, maintenanceMs: 900000, rssBytes: 768 * 1024 ** 2, databaseBytes: 16 * 1024 ** 3, writeSeconds: 120 };
const report = {
  formatVersion: 2, status: 'running', tier, budgets, searchMode,
  hardware: { platform: platform(), release: release(), cpu: cpus()[0]?.model, logicalCpus: cpus().length, ramBytes: totalmem(), node: process.version },
  dataset: { seed: 'scale-v2-uuid8', primaryOwnerArticles: tier, isolationOwners: 10, isolationArticlesEach: Math.min(10000, tier / 10), feeds: 100, tags: 100, folders: 20, timestampGroupSize: 100, microsecondSubgroups: 3, unreadPercent: 5, savedPercent: 2, body: '95% ~2KiB, 5% ~32KiB deterministic HIGHLY COMPRESSIBLE text; not a realistic media or storage benchmark', images: Math.min(200000, tier), contexts: 0 },
  phases: {}, reads: [], plans: [], limitations: [], peakRssBytes: 0,
};
report.postgresResources = { containerCpuLimit: 2, containerMemoryBytes: 6 * 1024 ** 3 };
const sampler = setInterval(() => { report.peakRssBytes = Math.max(report.peakRssBytes, process.memoryUsage().rss); }, 250);
sampler.unref();
const schema = `scale_bench_${randomUUID().replaceAll('-', '')}`;
const admin = postgres(process.env.TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
let captured = null;
const db = postgres(process.env.TEST_DATABASE_URL, {
  max: 8, onnotice: () => {},
  connection: { search_path: schema, statement_timeout: String(budgets.statementMs), lock_timeout: '3000', application_name: 'feedink-synthetic-scale' },
  debug: (_connection, query, parameters) => {
    if (captured && /^SELECT /i.test(query) && captured.length < 12) captured.push({ query, parameters: [...parameters] });
  },
});
const articles = new Articles(db);
const uid = (n) => `10000000-0000-4000-8000-${String(n).padStart(12, '0')}`;
const owner = uid(1), folder = uid(2000), commonTag = uid(3000), rareTag = uid(3099);
const guard = async () => {
  report.peakRssBytes = Math.max(report.peakRssBytes, process.memoryUsage().rss);
  if (performance.now() > deadline) throw Object.assign(new Error('Wall budget'), { code: 'WALL_BUDGET' });
  if (report.peakRssBytes > budgets.rssBytes) throw Object.assign(new Error('RSS budget'), { code: 'RSS_BUDGET' });
  const [{ bytes }] = await db`SELECT COALESCE(sum(pg_total_relation_size(c.oid)),0)::text AS bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${schema} AND c.relkind='r'`;
  if (Number(bytes) > budgets.databaseBytes) throw Object.assign(new Error('Database budget'), { code: 'DATABASE_BUDGET' });
};
const phase = async (name, task) => {
  const begin = performance.now();
  try { return await task(); } finally { report.phases[name] = Math.round(performance.now() - begin); }
};
const audit = async () => {
  const [row] = await db.begin(async (sql) => {
    await sql`SET LOCAL statement_timeout='180s'`;
    return sql`SELECT scale_audit_counts()::integer AS drift`;
  });
  assert.equal(row.drift, 0, 'Counter drift');
};
const percentiles = (values) => {
  const sorted = values.toSorted((a, b) => a - b);
  return { samples: sorted.length, p50Ms: sorted[Math.floor((sorted.length - 1) * .5)], p95Ms: sorted[Math.ceil((sorted.length - 1) * .95)] };
};
const explain = async (label, query, parameters = []) => {
  await guard();
  try {
    const rows = await db.begin('read only', async (sql) => sql.unsafe(`EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON) ${query}`, parameters, { prepare: false }));
    report.plans.push({ label, provenance: 'unprepared-replay', sql: query, plan: rows[0]['QUERY PLAN'] });
  } catch (error) { report.plans.push({ label, provenance: 'unprepared-replay', errorCode: error.code || 'ERROR' }); report.limitations.push(`${label}: plan exceeded budget or failed (${error.code || 'ERROR'})`); }
};
// Compare the entire ordered response, including exact total and cursor. Only
// digests/counts are exported; no new corpus/secret capture is needed.
const digest = value => createHash('sha256').update(JSON.stringify(value)).digest('hex');
const searchPages = new Map();
const parity = (stage, key, page) => {
  const current = { total: page.total, rows: page.items.length, digest: digest(page) };
  if (stage === 'before') searchPages.set(key, current);
  else {
    const expected = searchPages.get(key);
    assert.deepEqual(current, expected, `Search index response parity: ${key}`);
    report.searchIndexes.parity.push({ key, expected, actual: current });
  }
};
const relationSnapshot = async () => ({
  relations: [...await db`SELECT c.relname AS relation,pg_relation_size(c.oid)::text AS heap_bytes,pg_indexes_size(c.oid)::text AS index_bytes,CASE WHEN c.reltoastrelid=0 THEN '0' ELSE pg_total_relation_size(c.reltoastrelid)::text END AS toast_bytes,pg_total_relation_size(c.oid)::text AS total_bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${schema} AND c.relkind='r' ORDER BY c.relname`],
  indexes: [...await db`SELECT indexrelname,pg_relation_size(indexrelid)::text AS bytes FROM pg_stat_user_indexes WHERE schemaname=${schema} ORDER BY indexrelname`],
  databaseBytes: (await db`SELECT pg_database_size(current_database())::text AS bytes`)[0].bytes,
});
// Bounded, identical INSERT/content+URL UPDATE/DELETE work before and after.
// Roll back so the read comparison corpus remains unchanged. This produces dead
// tuples/index work, not sustained committed-ingestion throughput or WAL proof.
const searchWriteCost = async () => {
  const insert = [], update = [], remove = [];
  const rollback = new Error('synthetic write-cost rollback');
  try {
    await db.begin(async sql => {
      for (let i = 0; i < 20; i++) {
        await guard();
        const id = randomUUID(), text = `Synthetic ${'abcdef0123456789'.repeat(i % 20 === 0 ? 2048 : 128)}`;
        let begin = performance.now();
        await sql`INSERT INTO articles(id,user_id,guid,feed_title,title,url,published_at,content_html,content_text,content_hash)
          VALUES(${id},${owner},${id},'Synthetic','Write cost','https://example.invalid/write-cost',now(),${'<p>' + text + '</p>'},${text},'synthetic')`;
        insert.push(performance.now() - begin); begin = performance.now();
        await sql`UPDATE articles SET title='Updated write cost',content_text=${text + ' changed'},url='https://example.invalid/updated-write-cost' WHERE id=${id}`;
        update.push(performance.now() - begin); begin = performance.now();
        await sql`DELETE FROM articles WHERE id=${id}`;
        remove.push(performance.now() - begin);
      }
      throw rollback;
    });
  } catch (error) { if (error !== rollback) throw error; }
  return { rows: 20, rolledBack: true, insert: percentiles(insert), indexedContentUpdate: percentiles(update), delete: percentiles(remove) };
};
try {
  await admin.unsafe(`CREATE SCHEMA ${schema}`);
  report.postgres = (await db`SELECT version() AS version,current_setting('shared_buffers') AS shared_buffers,current_setting('work_mem') AS work_mem,current_setting('max_parallel_workers_per_gather') AS max_parallel_workers_per_gather`)[0];
  await phase('seedIdCursorPreflightMs', async () => {
    await db.unsafe(await readFile(new URL('./scale-seed-ids.sql', import.meta.url), 'utf8'));
    const samples = [...new Set([1, 2, 99, 100, 997, Math.floor(tier * .9), tier])];
    let validated = 0;
    for (const account of [1, 2, 11]) for (const i of samples) {
      const [row] = await db`SELECT scale_seed_uuid(${`article-${account}-${i}`}) AS article_id,scale_seed_uuid(${`image-${i}`}) AS image_id`;
      for (const value of [row.article_id, row.image_id, uid(account), uid(1000 + i%100), uid(2000 + i%20), uid(3000 + i%100)]) uuid.parse(value);
      const cursor = Buffer.from(JSON.stringify({ id: row.article_id, date: '2026-01-01T00:00:00.000123Z' })).toString('base64url');
      for (const sort of ['oldest', 'newest']) articles.selection(owner, { scope: 'archive', cursor, sort });
      validated++;
    }
    report.seedIdCursorPreflight = { validated, version: 8, variant: '10xx' };
  });
  await phase('schemaThrough006Ms', async () => {
    for (const name of ['001_initial', '002_demo_usage', '003_audit_safety', '004_state_version', '005_annotations_mcp', '006_annotation_context_retention'])
      await db.unsafe(await readFile(new URL(`../apps/api/migrations/${name}.sql`, import.meta.url), 'utf8'));
  });
  await phase('seedMs', async () => {
    for (let i = 1; i <= 11; i++) await db`INSERT INTO users(id,email,name,password_hash) VALUES(${uid(i)},${`synthetic-${i}@example.invalid`},'Synthetic','not-a-password')`;
    for (let i = 0; i < 20; i++) await db`INSERT INTO folders(id,user_id,name) VALUES(${uid(2000 + i)},${owner},${`Folder ${i}`})`;
    for (let i = 0; i < 100; i++) {
      await db`INSERT INTO feeds(id,user_id,url,title) VALUES(${uid(1000 + i)},${owner},${`https://example.invalid/feed/${i}`},${`Feed ${i}`})`;
      if (i < 90) await db`INSERT INTO subscriptions(id,user_id,feed_id,folder_id,title) VALUES(${uid(4000 + i)},${owner},${uid(1000 + i)},${uid(2000 + i % 20)},${`Feed ${i}`})`;
      await db`INSERT INTO tags(id,user_id,name) VALUES(${uid(3000 + i)},${owner},${`Tag ${i}`})`;
    }
    // 5k rows per statement bounds client memory (SQL generates bodies); the
    // whole fixture is disposable. Counter migration is applied AFTER seeding.
    for (let account = 1; account <= 11; account++) {
      const count = account === 1 ? tier : report.dataset.isolationArticlesEach;
      for (let start = 1; start <= count; start += 5000) {
        await guard();
        await db.begin(async (sql) => {
          await sql`SET LOCAL statement_timeout='120s'`;
          await sql`INSERT INTO articles(id,user_id,feed_id,guid,feed_title,title,url,published_at,content_html,content_text,content_hash,summary,read,saved)
            SELECT scale_seed_uuid(${`article-${account}-`} || i),${uid(account)},
              CASE WHEN ${account}<>1 OR i%20=0 THEN NULL ELSE ('10000000-0000-4000-8000-' || lpad((1000+CASE WHEN i%2=0 THEN 0 ELSE 1+i%99 END)::text,12,'0'))::uuid END,
              i::text,'Synthetic','Synthetic 中文 ' || CASE WHEN i%997=0 THEN 'needle-rare ' ELSE '' END || i,
              'https://example.invalid/article/' || i,
              '2026-01-01'::timestamptz + (i/100)*interval '1 second' + (i%3)*interval '1 microsecond',
              '<p>' || repeat(md5(i::text),CASE WHEN i%20=0 THEN 1024 ELSE 64 END) || '</p>',
              'Synthetic 中文 literal %_ ' || repeat(md5(i::text),CASE WHEN i%20=0 THEN 1024 ELSE 64 END),
              md5(i::text),'Synthetic bounded summary',(i/7)%20<>0,(i/11)%50=0
            FROM generate_series(${start}::integer,${Math.min(start + 4999, count)}::integer) i`;
        });
      }
    }
    for (let start = 1; start <= tier; start += 5000) {
      await guard();
      await db.begin(async (sql) => {
        await sql`SET LOCAL statement_timeout='120s'`;
        await sql`INSERT INTO article_tags(article_id,tag_id) SELECT scale_seed_uuid('article-1-' || i),${commonTag} FROM generate_series(${start}::integer,${Math.min(start + 4999, tier)}::integer) i WHERE i%2=0`;
        await sql`INSERT INTO article_tags(article_id,tag_id) SELECT scale_seed_uuid('article-1-' || i),('10000000-0000-4000-8000-' || lpad((3001+i%99)::text,12,'0'))::uuid FROM generate_series(${start}::integer,${Math.min(start + 4999, tier)}::integer) i WHERE i%7=0`;
      });
    }
    for (let start = 1; start <= report.dataset.images; start += 5000) {
      await guard();
      await db`INSERT INTO images(id,article_id,original_url,status,file_key)
        SELECT scale_seed_uuid('image-' || i),scale_seed_uuid('article-1-' || i),'https://example.invalid/image/' || i,
          CASE WHEN i<=10 THEN 'pending' ELSE 'cached' END,CASE WHEN i<=10 THEN NULL ELSE repeat(md5(i::text),2) END
        FROM generate_series(${start}::integer,${Math.min(start+4999,report.dataset.images)}::integer) i`;
    }
  });
  await phase('migration007IncludingIndexesAndBackfillMs', () => db.begin(async (sql) => {
    await sql.unsafe(await readFile(new URL('../apps/api/migrations/007_scale_queries.sql', import.meta.url), 'utf8'));
  }));
  await phase('analyzeMs', () => db.begin(async (sql) => { await sql`SET LOCAL statement_timeout='120s'`; await sql.unsafe('ANALYZE'); }));
  await phase('initialAuditMs', audit);
  const sizes = await db`SELECT c.relname AS relation,pg_relation_size(c.oid)::text AS heap_bytes,pg_indexes_size(c.oid)::text AS index_bytes,CASE WHEN c.reltoastrelid=0 THEN '0' ELSE pg_total_relation_size(c.reltoastrelid)::text END AS toast_bytes,pg_total_relation_size(c.oid)::text AS total_bytes FROM pg_class c JOIN pg_namespace n ON n.oid=c.relnamespace WHERE n.nspname=${schema} AND c.relkind='r' ORDER BY c.relname`;
  report.relationSizes = [...sizes];
  report.indexSizes = [...await db`SELECT indexrelname,pg_relation_size(indexrelid)::text AS bytes FROM pg_stat_user_indexes WHERE schemaname=${schema} ORDER BY indexrelname`];
  report.databaseBytes = (await db`SELECT pg_database_size(current_database())::text AS bytes`)[0].bytes;
  const shapes = [
    ['archive', { scope: 'archive' }], ['all', { scope: 'all' }], ['unread', { scope: 'unread' }], ['saved', { scope: 'saved' }],
    ['heavy-feed', { subscriptionId: uid(4000) }], ['rare-feed', { subscriptionId: uid(4001) }], ['folder', { folderId: folder }],
    ['common-tag', { tagId: commonTag }], ['rare-tag', { scope: 'archive', tagId: rareTag }], ['saved-tag', { scope: 'saved', tagId: commonTag }],
    ['date', { scope: 'archive', after: '2026-01-01T00:00:10Z' }],
    ['search-common', { scope: 'archive', q: 'Synthetic' }], ['search-rare', { scope: 'archive', q: 'needle-rare' }],
    ['search-multilingual', { scope: 'archive', q: '中文' }], ['search-short', { scope: 'archive', q: '文' }],
    ['search-literal', { scope: 'archive', q: '%_' }], ['search-absent', { scope: 'archive', q: 'never-occurs-in-fixture' }],
  ];
  if (compareSearch) {
    report.searchIndexes = {
      method: 'Same committed 10k corpus before/after 010; warm bounded-page parity, not a full traversal. Rolled-back write probes leave physical work/dead tuples. No WAL, cold-cache, sustained GIN maintenance or realistic TOAST measurement.',
      parity: [], before: await relationSnapshot(),
    };
    shapes.push(['search-backslash', { scope: 'archive', q: '\\' }], ['search-short-ascii', { scope: 'archive', q: 'a' }]);
  }
  const readMatrix = async (stage) => {
    const planLabel = label => stage === 'before' ? label : `${stage}/${label}`;
    for (const [label, query] of shapes) {
      const paths = [{ label: 'first', cursor: undefined }];
      try {
        // Authoritative reference count is measured separately from hot-path time.
        const { condition } = articles.selection(owner, query, false);
        const begin = performance.now();
        const [{ total }] = await db`SELECT count(*)::integer AS total FROM articles a WHERE ${condition}`;
        const referenceCountMs = performance.now() - begin;
        if (['archive', 'all', 'unread', 'saved', 'common-tag'].includes(label) && total > 100) {
          const [boundary] = await db`SELECT a.id,to_char(a.published_at AT TIME ZONE 'UTC','YYYY-MM-DD"T"HH24:MI:SS.US"Z"') AS date FROM articles a WHERE ${condition} ORDER BY a.published_at DESC,a.id DESC OFFSET ${Math.floor(total*.9)} LIMIT 1`;
          uuid.parse(boundary.id);
          const cursor = Buffer.from(JSON.stringify(boundary)).toString('base64url');
          articles.selection(owner, { ...query, cursor });
          paths.push({ label: 'deep-90-percent', cursor });
        }
        for (const path of paths) for (const limit of [20, 100]) {
          await guard();
          const durations = []; let bytes = 0;
          for (let sample = 0; sample < 4; sample++) {
            captured = sample === 1 && limit === 20 ? [] : null;
            const begin = performance.now();
            const page = await articles.page(owner, { ...query, cursor: path.cursor, limit });
            if (sample) durations.push(performance.now() - begin); // One warmup; no cold-cache claim.
            assert.equal(page.total, total); assert.ok(page.items.length <= limit);
            if (compareSearch && sample === 0) parity(stage, `api/${label}/${path.label}/${limit}`, page);
            bytes = Buffer.byteLength(JSON.stringify(page));
            const queries = captured; captured = null;
            if (queries) for (const [index, statement] of queries.entries())
              await explain(planLabel(`${label}/${path.label}/statement-${index}`), statement.query, statement.parameters);
          }
          report.reads.push({ stage, label, path: path.label, limit, referenceCountMs, responseBytes: bytes, ...percentiles(durations) });
        }
        // Actual authoritative count plan including literal fallback; no estimate.
        captured = [];
        await db`SELECT count(*)::integer AS total FROM articles a WHERE ${condition}`;
        const statement = captured[0]; captured = null;
        if (statement) await explain(planLabel(`${label}/authoritative-count`), statement.query, statement.parameters);
      } catch (error) {
        captured = null;
        report.reads.push({ stage, label, errorCode: error.code || 'ASSERTION' });
        if (!['57014', '55P03'].includes(error.code)) throw error;
        report.limitations.push(`${stage}/${label}: exceeded a statement/lock budget; incomplete samples`);
      }
    }
  };
  // Actual MCP SDK callback SQL, including URL OR and its distinct tie ordering.
  // No HTTP/auth/storage timing is claimed by this in-memory transport.
  const mcpReadMatrix = async stage => {
    for (const account of [1, 2]) {
      const client = new Client({ name: 'synthetic-scale-search', version: '1.0.0' });
      const server = createMcpServer(db, null, null, { userId: uid(account), tokenId: uid(9000), scopes: ['articles:read'] });
      try {
        const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
        await server.connect(serverTransport); await client.connect(clientTransport);
        for (const [label, query] of [...shapes.filter(([label]) => label.startsWith('search-')), ['search-url', { q: 'example.invalid/article/997' }]]) {
          const durations = []; let page;
          for (let sample = 0; sample < 4; sample++) {
            await guard(); captured = sample === 1 ? [] : null;
            const begin = performance.now();
            const result = await client.callTool({ name: 'search_articles', arguments: { query: query.q, limit: 20 } });
            if (sample) durations.push(performance.now() - begin);
            if (result.isError) {
              const errorCode = result.structuredContent?.error?.code || 'MCP_OPERATION_FAILED';
              report.reads.push({ stage, label: `mcp/owner-${account}/${label}`, errorCode });
              throw Object.assign(new Error('MCP search failed'), { code: errorCode });
            }
            page = result.structuredContent;
            if (!sample) parity(stage, `mcp/owner-${account}/${label}`, page);
            const statements = captured; captured = null;
            if (statements) for (const [index, statement] of statements.entries())
              await explain(`${stage}/mcp/owner-${account}/${label}/statement-${index}`, statement.query, statement.parameters);
          }
          report.reads.push({ stage, label: `mcp/owner-${account}/${label}`, limit: 20, total: page.total, responseBytes: Buffer.byteLength(JSON.stringify(page)), ...percentiles(durations) });
          // Independent literal reference (not LIKE, so wildcard escaping cannot
          // make both the callback and its oracle wrong in the same way).
          const [{ total }] = await db`SELECT count(*)::integer AS total FROM articles WHERE user_id=${uid(account)} AND (strpos(lower(title),lower(${query.q}))>0 OR strpos(lower(url),lower(${query.q}))>0 OR strpos(lower(content_text),lower(${query.q}))>0)`;
          assert.equal(page.total, total);
          for (const item of page.items) await articles.owned(uid(account), item.articleId);
        }
      } finally { captured = null; await client.close(); await server.close(); }
    }
  };
  await phase('readMatrixMs', () => readMatrix('before'));
  if (compareSearch) {
    await phase('mcpBeforeMs', () => mcpReadMatrix('before'));
    report.searchIndexes.beforeWriteCost = await phase('searchWritesBeforeMs', searchWriteCost);
    await phase('migration010IndexesMs', () => db.begin(async sql => {
      await sql.unsafe(await readFile(new URL('../apps/api/migrations/010_search_indexes.sql', import.meta.url), 'utf8'));
    }));
    await phase('analyzeAfter010Ms', () => db.begin(async sql => { await sql`SET LOCAL statement_timeout='120s'`; await sql.unsafe('ANALYZE'); }));
    report.searchIndexes.afterBuild = await relationSnapshot();
    report.searchIndexes.extension = (await db`SELECT e.extversion,n.nspname AS schema FROM pg_extension e JOIN pg_namespace n ON n.oid=e.extnamespace WHERE e.extname='pg_trgm'`)[0];
    await phase('readMatrixAfter010Ms', () => readMatrix('after'));
    await phase('mcpAfterMs', () => mcpReadMatrix('after'));
    assert.equal(report.searchIndexes.parity.length, searchPages.size, 'every before page has an after comparison');
    report.searchIndexes.afterWriteCost = await phase('searchWritesAfterMs', searchWriteCost);
    report.searchIndexes.afterWriteProbe = await relationSnapshot();
  }
  await phase('pendingAndBlobPlansMs', async () => {
    await explain('pending-global-sparse', "SELECT i.id,a.url FROM images i JOIN articles a ON a.id=i.article_id JOIN users u ON u.id=a.user_id WHERE i.status='pending' AND NOT u.disabled AND NOT u.is_demo ORDER BY i.article_id,i.id LIMIT 20");
    await explain('pending-feed-sparse', "SELECT i.id,a.url FROM images i JOIN articles a ON a.id=i.article_id WHERE a.feed_id=$1 AND i.status='pending' ORDER BY i.article_id,i.id LIMIT 50", [uid(1000)]);
    await db`UPDATE images SET status='cached' WHERE status='pending'`;
    await explain('pending-global-empty', "SELECT i.id FROM images i WHERE i.status='pending' ORDER BY i.article_id,i.id LIMIT 20");
    await explain('blob-reference-miss', 'SELECT EXISTS(SELECT 1 FROM images WHERE file_key=$1 UNION ALL SELECT 1 FROM ebooks WHERE file_key=$1 UNION ALL SELECT 1 FROM feeds WHERE icon_file_key=$1)', ['f'.repeat(64)]);
  });
  await phase('concurrentWritesAndReadersMs', async () => {
    const writeDeadline = Math.min(deadline, performance.now() + budgets.writeSeconds * 1000);
    const samples = [], readSamples = [], ingestionSamples = []; let writes = 0, retries = 0;
    const retry = async (task) => {
      for (let attempt = 0; ; attempt++) try { return await task(); } catch (error) {
        if (attempt >= 2 || !['40P01', '40001'].includes(error.code)) throw error;
        retries++;
      }
    };
    const targets = await db`SELECT id FROM articles WHERE user_id=${owner} ORDER BY id LIMIT 200`;
    await Promise.all([
      ...Array.from({ length: 4 }, (_, worker) => (async () => {
        for (let i = worker; i < targets.length && performance.now() < writeDeadline; i += 4) {
          const begin = performance.now();
          await retry(() => articles.patch(owner, targets[i].id, { read: i%2===0, saved: i%3===0, progress: .5 }));
          samples.push(performance.now()-begin); writes++;
        }
      })()),
      ...Array.from({ length: 4 }, () => (async () => {
        for (let i = 0; i < 25 && performance.now() < writeDeadline; i++) {
          const begin = performance.now();
          const page = await articles.page(owner, { scope: 'archive', limit: 20 });
          assert.ok(page.total >= tier); readSamples.push(performance.now()-begin);
        }
      })()),
      ...Array.from({ length: 2 }, (_, worker) => (async () => {
        for (let i = 0; i < 50 && performance.now() < writeDeadline; i++) {
          const begin = performance.now();
          await retry(() => articleWrite(db, owner, (sql) => sql`INSERT INTO articles(id,user_id,guid,feed_title,title,url,published_at,content_html,content_text,content_hash)
            VALUES(${randomUUID()},${owner},${`write-${worker}-${i}`},'Synthetic','New synthetic','https://example.invalid/new',now(),'<p>New synthetic</p>','New synthetic','synthetic')`));
          ingestionSamples.push(performance.now() - begin);
        }
      })()),
    ]);
    report.concurrent = { writers: 4, readers: 4, ingestionWriters: 2, ingestionRows: ingestionSamples.length, ingestion: percentiles(ingestionSamples), stateWrites: writes, transientRetries: retries, state: percentiles(samples), reads: percentiles(readSamples) };
    // Atomic bulk semantics remain; explicitly bounded to <=10k, never silently
    // chunk the public API. EXPLAIN of UPDATE is deliberately not replayed.
    const bulkIds = await db`SELECT id FROM articles WHERE user_id=${owner} ORDER BY id LIMIT 10000`;
    const begin = performance.now();
    const bulk = await articles.bulk(owner, true, bulkIds.map((r) => r.id));
    assert.equal(bulk.updated, bulkIds.length);
    report.bulk = { rows: bulk.updated, milliseconds: performance.now()-begin };
  });
  if (compareSearch) report.searchIndexes.afterConcurrentWrites = await relationSnapshot();
  await phase('finalAuditMs', audit);
  await phase('isolationMs', async () => {
    for (let i = 2; i <= 11; i++) {
      const page = await articles.page(uid(i), { scope: 'archive' });
      assert.equal(page.total, report.dataset.isolationArticlesEach);
      assert.equal((await articles.page(uid(i), { scope: 'archive', tagId: commonTag })).total, 0);
      assert.equal((await articles.page(uid(i), { subscriptionId: uid(4000) })).total, 0);
      await assert.rejects(articles.owned(owner, page.items[0].id), (error) => error.code === 'NOT_FOUND');
    }
  });
  await guard();
  report.status = report.limitations.length ? 'completed-with-limits' : 'completed';
} catch (error) {
  report.status = 'failed'; report.errorCode = error.code || 'ASSERTION'; process.exitCode = 1;
} finally {
  captured = null;
  clearInterval(sampler);
  report.nodeResourceUsage = process.resourceUsage();
  report.elapsedMs = Math.round(performance.now() - started);
  report.peakRssBytes = Math.max(report.peakRssBytes, process.memoryUsage().rss);
  report.limitations.push('Warm synthetic service-method timings, not end-to-end HTTP; three samples are descriptive, not a tail-latency guarantee. No real blobs, annotation load, MCP/notes offsets, network, browser or storage durability measured. Counter contention and exact literal search remain workload-dependent.');
  await writeFile(join(output, 'report.json'), JSON.stringify(report, null, 2) + '\n');
  if (process.env.GITHUB_STEP_SUMMARY)
    await writeFile(process.env.GITHUB_STEP_SUMMARY, `\n### Synthetic scale ${tier}\nStatus: ${report.status}; elapsed ${report.elapsedMs}ms; peak Node RSS ${report.peakRssBytes} bytes. ${report.limitations.length} limitations; see opt-in structured evidence. No universal SLA.\n`, { flag: 'a' });
  await db.end({ timeout: 5 });
  await admin.unsafe(`DROP SCHEMA IF EXISTS ${schema} CASCADE`);
  await admin.end({ timeout: 5 });
}

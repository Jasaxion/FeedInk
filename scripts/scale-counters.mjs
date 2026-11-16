import postgres from 'postgres';

// This lane authorizes execution only on GitHub-hosted synthetic databases.
// Production operator SQL is documented separately and needs its own approval.
if (process.env.GITHUB_ACTIONS !== 'true' || process.env.RUNNER_ENVIRONMENT !== 'github-hosted')
  throw new Error('Counter maintenance requires approved GitHub-hosted infrastructure');
const action = process.argv[2];
if (!['audit', 'rebuild', 'invalidate'].includes(action) || !process.env.TEST_DATABASE_URL)
  throw new Error('Usage: scale-counters.mjs audit|rebuild|invalidate with TEST_DATABASE_URL');
const db = postgres(process.env.TEST_DATABASE_URL, { max: 1, onnotice: () => {} });
try {
  const result = await db.begin(async (sql) => {
    await sql`SET LOCAL lock_timeout='5s'`;
    await sql`SET LOCAL statement_timeout='15min'`;
    if (action === 'invalidate') {
      await sql`LOCK TABLE users, feeds, subscriptions, tags, articles, article_tags, article_counts, article_count_state IN ACCESS EXCLUSIVE MODE`;
      await sql`UPDATE article_count_state SET valid=false`;
      return { invalidated: true };
    }
    if (action === 'rebuild') await sql`SELECT scale_rebuild_counts()`;
    const [{ drift }] = await sql`SELECT scale_audit_counts()::integer AS drift`;
    return { drift };
  });
  // Print only bounded, non-identifying metadata; never raw errors/connection data.
  console.log(JSON.stringify({ action, ...result }));
  if (result.drift) process.exitCode = 1;
} catch (error) {
  console.error(JSON.stringify({ action, errorCode: error.code || 'ERROR' }));
  process.exitCode = 1;
} finally { await db.end({ timeout: 5 }); }

import { execFileSync } from 'node:child_process';
import { pathToFileURL } from 'node:url';

const rules = [
  ['machine-path', /\/(?:Users|home)\/(?!(?:runner|node|app)(?:\/|$))[^\s/"'<>]+\/|\/mnt\/(?:public|shared|private)\//],
  ['github-token', /(?:gh[pousr]_[A-Za-z0-9]{20,}|github_pat_[A-Za-z0-9_]{20,})/],
  ['provider-token', /\bsk-[A-Za-z0-9_-]{20,}\b/],
  ['feedink-access-token', /\bfi_mcp_[A-Za-z0-9_-]{40,}\b/],
  ['cloud-access-key', /\bAKIA[0-9A-Z]{16}\b/],
  ['private-key', /-----BEGIN (?:RSA |EC |OPENSSH |DSA )?PRIVATE KEY-----/],
  ['private-analysis-reference', /\bev_[a-f0-9]{64}\b/],
];

/** Report locations and rule names only, never the matched data. */
export function inspectPublicText(file, text) {
  const findings = [];
  for (const [index, line] of text.split('\n').entries()) {
    for (const [rule, pattern] of rules) if (pattern.test(line)) findings.push({ file, line: index + 1, rule });
  }
  if (/(^|\/)\.env(?:\.|$)/.test(file) && !file.endsWith('.env.example')) findings.push({ file, line: 0, rule: 'private-environment-file' });
  return findings;
}

export function checkIndex() {
  // Read Git blobs, not filesystem symlinks or ignored local credentials.
  const files = execFileSync('git', ['ls-files', '-z'], { encoding: 'utf8' }).split('\0').filter(Boolean);
  const findings = [];
  for (const file of files) {
    const bytes = execFileSync('git', ['show', `:${file}`], { maxBuffer: 20 * 1024 * 1024 });
    if (!bytes.includes(0)) findings.push(...inspectPublicText(file, bytes.toString('utf8')));
  }
  for (const finding of findings) console.error(`${finding.file}:${finding.line}: ${finding.rule}`);
  if (findings.length) throw new Error(`Public-content check rejected ${findings.length} finding(s); inspect privately.`);
  console.log(`Public-content check passed for ${files.length} tracked files. Review remains required; pattern checks cannot detect every secret.`);
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  try { checkIndex(); } catch (error) { console.error(error.message); process.exitCode = 1; }
}

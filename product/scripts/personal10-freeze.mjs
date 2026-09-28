/** Read-only product fingerprint for a local, synthetic, code-frozen evaluation. */
import { createHash } from 'node:crypto';
import { execFileSync } from 'node:child_process';
import { readFileSync, readdirSync, statSync, writeFileSync } from 'node:fs';
import { relative, resolve, sep } from 'node:path';

const product = resolve(import.meta.dirname, '..');
const root = resolve(product, '..');
const hash = value => createHash('sha256').update(value).digest('hex');
const requiredFiles = [
  'product/package.json', 'product/package-lock.json', 'product/next.config.ts',
  'product/tsconfig.json', 'product/integrations/rag-api/app.py',
  'product/integrations/rag-api/retriever.py',
];
const runtimeDirs = [
  'product/src', 'product/prompts', 'product/integrations/rag-api/config',
  'product/integrations/rag-api/knowledge',
  'product/integrations/rag-api/data/labor_law_db', 'db/migrations',
];
const skipped = new Set(['.git', '.venv', '.cache', '.runtime', 'node_modules', '__pycache__']);
const files = [];
function visit(path) {
  for (const entry of readdirSync(path, { withFileTypes: true })) {
    if (skipped.has(entry.name)) continue;
    const target = resolve(path, entry.name);
    if (entry.isDirectory()) visit(target);
    else if (entry.isFile()) files.push(target);
  }
}
for (const dir of runtimeDirs) visit(resolve(root, dir));
for (const file of requiredFiles) files.push(resolve(root, file));
const perFile = Object.fromEntries([...new Set(files)].sort().map(path => {
  if (!statSync(path).isFile()) throw new Error('SOURCE_FILE_MISSING');
  return [relative(root, path).split(sep).join('/'), hash(readFileSync(path))];
}));
const sourceDigest = hash(JSON.stringify(perFile));
const git = (...args) => execFileSync('git', args, { cwd: root, encoding: 'utf8' }).trim();
const productStatus = git('status', '--porcelain=v1', '--untracked-files=all', '--',
  'product/src', 'product/prompts', 'product/integrations/rag-api', 'product/package.json',
  'product/package-lock.json', 'product/next.config.ts', 'product/tsconfig.json', 'db/migrations');
const manifest = {
  schema: 'personal10-freeze.v1', at: new Date().toISOString(),
  head: git('rev-parse', 'HEAD'), branch: git('branch', '--show-current'),
  product_status: productStatus || 'clean', source_digest_sha256: sourceDigest,
  file_count: Object.keys(perFile).length, per_file_sha256: perFile,
};
const verifyIndex = process.argv.indexOf('--verify');
if (verifyIndex >= 0) {
  const expected = JSON.parse(readFileSync(resolve(process.argv[verifyIndex + 1]), 'utf8'));
  if (expected.source_digest_sha256 !== sourceDigest || expected.head !== manifest.head) {
    console.error(JSON.stringify({ verified: false, reason: 'CANDIDATE_CHANGED',
      expected_digest: expected.source_digest_sha256, actual_digest: sourceDigest }));
    process.exitCode = 2;
  } else console.log(JSON.stringify({ verified: true, head: manifest.head, source_digest_sha256: sourceDigest }));
} else {
  const outputIndex = process.argv.indexOf('--output');
  if (outputIndex >= 0) writeFileSync(resolve(process.argv[outputIndex + 1]), JSON.stringify(manifest, null, 2) + '\n');
  console.log(JSON.stringify({ head: manifest.head, branch: manifest.branch,
    product_status: manifest.product_status, source_digest_sha256: sourceDigest,
    file_count: manifest.file_count, manifest_written: outputIndex >= 0 }));
}

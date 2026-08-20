#!/usr/bin/env node
/**
 * Rewrites the Live metrics block in PROGRESS.md from the real repo state.
 * Never edits anything outside the METRICS markers, so hand-written status
 * tables above and below are safe.
 *
 *   npm run progress
 */
import { execSync } from 'node:child_process';
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, resolve } from 'node:path';

const root = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const run = (cmd) => {
  try {
    return execSync(cmd, { cwd: root, encoding: 'utf8', stdio: ['ignore', 'pipe', 'pipe'] });
  } catch (err) {
    // vitest exits non-zero on failure but still prints its summary
    return `${err.stdout ?? ''}${err.stderr ?? ''}`;
  }
};

const countTests = (out) => {
  const m = out.match(/Tests\s+(\d+)\s+passed(?:\s*\|\s*(\d+)\s+skipped)?/);
  if (!m) return 'unknown';
  const failed = out.match(/(\d+)\s+failed/);
  const parts = [`${m[1]} passing`];
  if (failed) parts.unshift(`${failed[1]} FAILING`);
  if (m[2]) parts.push(`${m[2]} skipped`);
  return parts.join(', ');
};

const commits = run('git rev-list --count HEAD').trim();
const backend = countTests(run('npx vitest run --exclude "app/**"'));
const app = countTests(run('npm --prefix app run test'));
const typecheckOut = run('npm run typecheck');
const typecheck = /error TS\d+/.test(typecheckOut) ? 'ERRORS' : 'clean';

const block = `| Metric | Value |
|---|---|
| Commits | ${commits} |
| Backend tests | ${backend} |
| App tests | ${app} |
| Typecheck | ${typecheck} |
| Backend suite | \`npx vitest run --exclude "app/**"\` |
| App suite | \`npm --prefix app run test\` |`;

const path = resolve(root, 'PROGRESS.md');
const before = readFileSync(path, 'utf8');
const after = before.replace(
  /<!-- METRICS:START -->[\s\S]*?<!-- METRICS:END -->/,
  `<!-- METRICS:START -->\n${block}\n<!-- METRICS:END -->`,
);
const stamped = after.replace(
  /\*\*Last updated:\*\* \d{4}-\d{2}-\d{2}/,
  `**Last updated:** ${new Date().toISOString().slice(0, 10)}`,
);
writeFileSync(path, stamped);

console.log(block);
console.log(`\nPROGRESS.md updated.`);

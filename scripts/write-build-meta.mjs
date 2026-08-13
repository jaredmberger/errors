import { execSync } from 'node:child_process';
import { mkdirSync, writeFileSync } from 'node:fs';

function git(command) {
  try { return execSync(command, { encoding: 'utf8', stdio: ['ignore', 'pipe', 'ignore'] }).trim(); }
  catch { return ''; }
}

const commit = process.env.WORKERS_CI_COMMIT_SHA || git('git rev-parse HEAD') || null;
const branch = process.env.WORKERS_CI_BRANCH || git('git branch --show-current') || null;
const buildUuid = process.env.WORKERS_CI_BUILD_UUID || null;
const source = process.env.WORKERS_CI_COMMIT_SHA ? 'workers-builds' : (commit ? 'git' : 'unavailable');

mkdirSync('src', { recursive: true });
writeFileSync('src/build-meta.generated.js', `export const BUILD_META = Object.freeze(${JSON.stringify({ commit, branch, buildUuid, source }, null, 2)});\n`);
console.log(`[build-meta] ${commit || 'unknown'} ${branch || ''}`.trim());

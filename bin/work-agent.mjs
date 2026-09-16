#!/usr/bin/env node
// Real entry point behind the `work-agent` command CLAUDE.md tells fresh
// sessions to run. Just execs the same `tsx src/cli.ts` the "cli" npm
// script already runs, from this package's own directory regardless of
// the caller's cwd — so `work-agent exec-start KEY` works verbatim once
// this package is linked (`npm link` from this repo, once).
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const packageRoot = path.dirname(path.dirname(fileURLToPath(import.meta.url)));
const cliPath = path.join(packageRoot, 'src', 'cli.ts');
const tsxBin = path.join(packageRoot, 'node_modules', '.bin', 'tsx');

const result = spawnSync(tsxBin, [cliPath, ...process.argv.slice(2)], {
  stdio: 'inherit',
  cwd: packageRoot,
});
process.exit(result.status ?? 1);

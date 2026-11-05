// Gathers real, observable facts about a mapped project — never a guess —
// for the dashboard's per-project tab: what's actually in its
// package.json, whether its dev server is actually reachable right now,
// and whether a matching Docker container is actually running. Each piece
// degrades independently and silently (no package.json, no docker binary,
// nothing listening on the port) rather than failing the whole dashboard
// render — this is a "nice to have" overview, never load-bearing.

import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import net from 'node:net';
import { exec } from 'node:child_process';
import { promisify } from 'node:util';
import type { WorkAgentConfig } from '../config/index.js';

const execAsync = promisify(exec);

export interface DockerContainer {
  name: string;
  status: string;
}

export interface ProjectOverview {
  repo: string;
  localPath?: string;
  techStack: string[];
  backendDescription?: string;
  localUrl?: string;
  localUrlLive: boolean;
  dockerContainers: DockerContainer[];
}

// Curated from real package names, not inferred/fuzzy-matched — a label
// only ever appears here because that exact dependency is actually
// installed. Extend this list as new stacks show up in practice; an
// unlisted dependency just doesn't contribute a badge, it never breaks
// anything.
const TECH_LABELS: Record<string, string> = {
  next: 'Next.js',
  react: 'React',
  vue: 'Vue',
  '@angular/core': 'Angular',
  svelte: 'Svelte',
  express: 'Express',
  fastify: 'Fastify',
  '@nestjs/core': 'NestJS',
  'drizzle-orm': 'Drizzle ORM',
  prisma: 'Prisma',
  mongoose: 'Mongoose',
  sequelize: 'Sequelize',
  typeorm: 'TypeORM',
  typescript: 'TypeScript',
  tailwindcss: 'Tailwind CSS',
  graphql: 'GraphQL',
  vitest: 'Vitest',
  jest: 'Jest',
  playwright: 'Playwright',
};

/** Reads real dependency names out of the repo's own package.json — no
 * version/semver logic, just presence. Returns [] (never throws) when
 * there's no package.json, or it isn't valid JSON. */
export function detectTechStack(repoLocalPath: string): string[] {
  const pkgPath = path.join(repoLocalPath, 'package.json');
  if (!existsSync(pkgPath)) return [];
  try {
    const pkg = JSON.parse(readFileSync(pkgPath, 'utf-8')) as {
      dependencies?: Record<string, string>;
      devDependencies?: Record<string, string>;
    };
    const deps = { ...pkg.dependencies, ...pkg.devDependencies };
    return Object.entries(TECH_LABELS)
      .filter(([dep]) => deps[dep])
      .map(([, label]) => label);
  } catch {
    return [];
  }
}

/** A real TCP connect attempt, not a guess from config — "the port is
 * configured" and "something is actually listening on it right now" are
 * different facts, and only the second one means the dev server is live. */
export function probePort(port: number, host = '127.0.0.1', timeoutMs = 400): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = net.createConnection({ port, host });
    const finish = (result: boolean) => {
      socket.destroy();
      resolve(result);
    };
    socket.setTimeout(timeoutMs);
    socket.once('connect', () => finish(true));
    socket.once('timeout', () => finish(false));
    socket.once('error', () => finish(false));
  });
}

/** One shell call for the whole dashboard render, not one per project —
 * matched against each project's own repo path afterward. Returns []
 * (never throws) when Docker isn't installed, isn't running, or this
 * user can't talk to its socket — all of which are completely normal on a
 * machine with no Docker-based project at all. */
export async function listDockerContainers(): Promise<DockerContainer[]> {
  try {
    const { stdout } = await execAsync('docker ps --format "{{.Names}}\t{{.Status}}"', { timeout: 3000 });
    return stdout
      .split('\n')
      .map((line) => line.trim())
      .filter(Boolean)
      .map((line) => {
        const [name, ...rest] = line.split('\t');
        return { name: name ?? '', status: rest.join('\t').trim() };
      });
  } catch {
    return [];
  }
}

/** Heuristic, best-effort name match (a plain docker-compose project
 * usually names its containers after its own directory) — matched by the
 * given local directory's own name, alphanumeric-only so
 * "LearningSkillsAndDataFE" still matches "learningskillsanddatafe"
 * regardless of case/punctuation differences in how a given tool derives
 * its container names. Imperfect by nature; a project with no match just
 * shows no Docker status here, never a wrong one — see
 * matchDdevContainers below for the exact-match case this misses. */
export function matchDockerContainers(containers: DockerContainer[], localPath: string): DockerContainer[] {
  const needle = path.basename(localPath).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!needle) return [];
  return containers.filter((c) => c.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(needle));
}

/** DDEV always names its own containers "ddev-<project>-<service>" (web,
 * db, etc.) — a stable, documented convention, not a guess — and the
 * project name is whatever ".ddev/config.yaml" declares, which is
 * frequently NOT the same as the checkout's own directory name (exactly
 * the case that motivated this: UNLSD's backend checkout is
 * "drupal-headless-portal-cb5", its DDEV project is "learningskillsdata",
 * and its containers are "ddev-learningskillsdata-*" — matchDockerContainers
 * above, which only ever looks at the directory name, was never going to
 * find these). A minimal line-scan for just the "name:" field rather than
 * pulling in a full YAML parser for one value. */
export function readDdevProjectName(localPath: string): string | null {
  const configPath = path.join(localPath, '.ddev', 'config.yaml');
  if (!existsSync(configPath)) return null;
  try {
    const text = readFileSync(configPath, 'utf-8');
    const match = text.match(/^name:\s*(\S+)\s*$/m);
    return match ? match[1]!.replace(/^['"]|['"]$/g, '') : null;
  } catch {
    return null;
  }
}

export function matchDdevContainers(containers: DockerContainer[], ddevProjectName: string): DockerContainer[] {
  const prefix = `ddev-${ddevProjectName}-`;
  return containers.filter((c) => c.name.startsWith(prefix));
}

export async function buildProjectOverview(repo: string, config: WorkAgentConfig, allContainers: DockerContainer[]): Promise<ProjectOverview> {
  const localPath = config.github.repoLocalPaths[repo];
  const techStack = localPath ? detectTechStack(localPath) : [];
  const backendSync = config.github.backendSync?.[repo];
  const backendDescription = backendSync?.description;
  const recipe = config.github.previewRecipes[repo];
  const port = recipe ? recipe.port : undefined;
  const localUrl = port ? `http://localhost:${port}` : undefined;
  const localUrlLive = port ? await probePort(port) : false;

  // Three independent ways a container can belong to this project — the
  // frontend repo's own directory name, the backend's own directory name
  // (when backendSync.localPath says where that is — a headless setup's
  // backend is almost always a completely separate checkout, nothing to
  // do with repoLocalPaths' frontend path), and, for a DDEV backend
  // specifically, an exact match on its real configured project name
  // rather than a directory-name guess. Deduped by container name, since
  // the same container can legitimately match more than one of these.
  const matchedByName = new Map<string, DockerContainer>();
  for (const c of localPath ? matchDockerContainers(allContainers, localPath) : []) matchedByName.set(c.name, c);
  if (backendSync?.localPath) {
    for (const c of matchDockerContainers(allContainers, backendSync.localPath)) matchedByName.set(c.name, c);
    const ddevName = readDdevProjectName(backendSync.localPath);
    if (ddevName) {
      for (const c of matchDdevContainers(allContainers, ddevName)) matchedByName.set(c.name, c);
    }
  }
  const dockerContainers = [...matchedByName.values()];

  return { repo, localPath, techStack, backendDescription, localUrl, localUrlLive, dockerContainers };
}

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

/** Heuristic, best-effort name match (e.g. DDEV names containers
 * "ddev-<project>-web", a plain docker-compose project usually names them
 * after its own directory) — matched by the repo's own local directory
 * name, alphanumeric-only so "LearningSkillsAndDataFE" still matches
 * "learningskillsanddatafe" regardless of case/punctuation differences in
 * how a given tool derives its container names. Imperfect by nature; a
 * project with no match just shows no Docker status, never a wrong one. */
export function matchDockerContainers(containers: DockerContainer[], repoLocalPath: string): DockerContainer[] {
  const needle = path.basename(repoLocalPath).toLowerCase().replace(/[^a-z0-9]/g, '');
  if (!needle) return [];
  return containers.filter((c) => c.name.toLowerCase().replace(/[^a-z0-9]/g, '').includes(needle));
}

export async function buildProjectOverview(repo: string, config: WorkAgentConfig, allContainers: DockerContainer[]): Promise<ProjectOverview> {
  const localPath = config.github.repoLocalPaths[repo];
  const techStack = localPath ? detectTechStack(localPath) : [];
  const backendDescription = config.github.backendSync?.[repo]?.description;
  const recipe = config.github.previewRecipes[repo];
  const port = recipe ? recipe.port : undefined;
  const localUrl = port ? `http://localhost:${port}` : undefined;
  const localUrlLive = port ? await probePort(port) : false;
  const dockerContainers = localPath ? matchDockerContainers(allContainers, localPath) : [];

  return { repo, localPath, techStack, backendDescription, localUrl, localUrlLive, dockerContainers };
}

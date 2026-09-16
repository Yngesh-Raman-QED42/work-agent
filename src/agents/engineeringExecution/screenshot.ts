import { spawn, type ChildProcess } from 'node:child_process';
import { mkdir, readFile, rm, writeFile } from 'node:fs/promises';
import { existsSync } from 'node:fs';
import { createConnection } from 'node:net';
import path from 'node:path';
import type { WorkAgentConfig } from '../../config/index.js';

export type PreviewRecipeConfig = WorkAgentConfig['github']['previewRecipes'][string];
// The object shape only — `false` (the opt-out marker) never reaches capture().
export type PreviewRecipe = Exclude<PreviewRecipeConfig, false>;

// Written by the implementer itself (see prompt.ts) — a deliberately tiny
// DSL, not a full test script. If the implementer decides the change isn't
// UI-visible, it simply doesn't write this file, and nothing below runs.
export interface ScreenshotStep {
  label: string; // used for the filename and the PR caption
  path: string; // relative URL path to navigate to, e.g. "/reports"
  waitForSelector?: string;
  actions?: Array<{ type: 'click' | 'fill'; selector: string; value?: string }>;
}

export interface CapturedScreenshot {
  label: string;
  relativePath: string; // relative to the worktree root, for git add + PR markdown
}

export interface CaptureResult {
  screenshots: CapturedScreenshot[];
  // Present only when 2+ steps were captured — a single still has nothing
  // to animate between.
  gifPath?: string;
}

export interface ScreenshotCapture {
  capture(worktreePath: string, recipe: PreviewRecipe, steps: ScreenshotStep[]): Promise<CaptureResult>;
}

export const SCREENSHOT_STEPS_PATH = '.work-agent/screenshot-steps.json';
export const SCREENSHOT_OUTPUT_DIR = '.work-agent/screenshots';
export const DEFAULT_PREVIEW_PORT = 3000;

export async function readScreenshotSteps(worktreePath: string): Promise<ScreenshotStep[] | null> {
  const fullPath = path.join(worktreePath, SCREENSHOT_STEPS_PATH);
  if (!existsSync(fullPath)) return null;
  try {
    const raw = await readFile(fullPath, 'utf-8');
    const parsed = JSON.parse(raw);
    if (!Array.isArray(parsed) || parsed.length === 0) return null;
    return parsed as ScreenshotStep[];
  } catch {
    // Malformed output from the implementer is a "skip", not a failure —
    // screenshots are a nice-to-have, never something that should block a PR.
    return null;
  }
}

/** Removes the instruction file so it never ships as part of the diff —
 * it's an input to this step, not something reviewers need to see. */
export async function cleanupScreenshotSteps(worktreePath: string): Promise<void> {
  const fullPath = path.join(worktreePath, SCREENSHOT_STEPS_PATH);
  await rm(fullPath, { force: true });
}

/**
 * Screenshot capture is opt-OUT: any repo Engineering Execution already
 * works in gets a best-effort attempt unless explicitly disabled. With no
 * configured recipe, this reads the repo's own package.json for a "dev" (or
 * "start") script and assumes the conventional default port — genuinely a
 * guess, so it's allowed to fail closed (return null) rather than invent a
 * command that isn't there. A configured `false` always wins over guessing.
 */
export async function resolvePreviewRecipe(
  configured: PreviewRecipeConfig | undefined,
  repoLocalPath: string,
): Promise<PreviewRecipe | null> {
  if (configured === false) return null;
  if (configured) return configured;
  return autoDetectPreviewRecipe(repoLocalPath);
}

export async function autoDetectPreviewRecipe(repoLocalPath: string): Promise<PreviewRecipe | null> {
  try {
    const raw = await readFile(path.join(repoLocalPath, 'package.json'), 'utf-8');
    const pkg = JSON.parse(raw) as { scripts?: Record<string, string> };
    const scriptName = pkg.scripts?.dev ? 'dev' : pkg.scripts?.start ? 'start' : null;
    if (!scriptName) return null;
    return {
      startCommand: ['npm', 'run', scriptName],
      port: DEFAULT_PREVIEW_PORT,
      readyPath: '/',
      readyTimeoutMs: 60_000,
      env: {},
    };
  } catch {
    return null; // no package.json, or unreadable — not enough to guess from
  }
}

/** Something already answering on this port before we've even started our
 * own server means our own `next dev` (or equivalent) either failed to
 * bind it and exited, or silently fell back to a different port entirely
 * (Next.js does this automatically on a conflict) — either way, the
 * generic "did not become ready" timeout that follows is actively
 * misleading about the real cause. Checked once, up front, specifically
 * so that case gets its own clear error instead of a 2-minute wait. */
function isPortInUse(port: number): Promise<boolean> {
  return new Promise((resolve) => {
    const socket = createConnection({ port, host: '127.0.0.1' });
    const done = (inUse: boolean) => {
      socket.removeAllListeners();
      socket.destroy();
      resolve(inUse);
    };
    socket.once('connect', () => done(true));
    socket.once('error', () => done(false));
  });
}

async function waitForServer(url: string, timeoutMs: number, getOutput: () => string): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    try {
      const resp = await fetch(url);
      if (resp.ok || (resp.status >= 200 && resp.status < 500)) return;
    } catch {
      // not up yet
    }
    await new Promise((r) => setTimeout(r, 500));
  }
  // Output was ignored entirely before this fix — a real crash, a port
  // Next.js silently moved off of, a missing env var, all looked
  // identical from the outside: just a timeout, with no way to tell them
  // apart. Whatever the dev server actually printed goes in the error now.
  const output = getOutput().trim();
  throw new Error(
    `dev server at ${url} did not become ready within ${timeoutMs}ms` +
      (output ? `\n--- dev server output (tail) ---\n${output}` : '\n(dev server produced no output at all)'),
  );
}

function slug(label: string): string {
  return label.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/(^-|-$)/g, '') || 'screenshot';
}

/** Assembles a sequence of same-size PNG buffers into one animated GIF —
 * literally the frames the reviewer would see stepping through the PR's own
 * screenshots, just animated, for a "see it in action" preview at the top. */
async function encodeGif(frames: Buffer[], worktreePath: string): Promise<string> {
  const { GIFEncoder, quantize, applyPalette } = await import('gifenc');
  const { PNG } = await import('pngjs');

  const gif = GIFEncoder();
  for (const frame of frames) {
    const png = PNG.sync.read(frame);
    const rgba = new Uint8ClampedArray(png.data.buffer, png.data.byteOffset, png.data.byteLength);
    const palette = quantize(rgba, 256);
    const index = applyPalette(rgba, palette);
    gif.writeFrame(index, png.width, png.height, { palette, delay: 1200 });
  }
  gif.finish();

  const relativePath = path.join(SCREENSHOT_OUTPUT_DIR, 'feature-in-action.gif');
  await writeFile(path.join(worktreePath, relativePath), Buffer.from(gif.bytes()));
  return relativePath;
}

/**
 * Starts the target app's own dev server inside the worktree, drives a
 * headless browser through the implementer's navigation steps, and screenshots
 * each one. The server is always killed afterward, success or failure —
 * this must never leave a process running past this function call.
 */
export class PlaywrightScreenshotCapture implements ScreenshotCapture {
  async capture(worktreePath: string, recipe: PreviewRecipe, steps: ScreenshotStep[]): Promise<CaptureResult> {
    if (await isPortInUse(recipe.port)) {
      throw new Error(
        `port ${recipe.port} is already in use before starting the preview server — ` +
          `is another dev server (yours, or a leftover from a previous run) already running on it? ` +
          `Stop it, or change previewRecipes[...].port in work-agent.config.json.`,
      );
    }
    const { chromium } = await import('playwright');
    const { child: server, getOutput } = await this.startServer(worktreePath, recipe);
    try {
      await waitForServer(`http://localhost:${recipe.port}${recipe.readyPath}`, recipe.readyTimeoutMs, getOutput);

      const outDir = path.join(worktreePath, SCREENSHOT_OUTPUT_DIR);
      await mkdir(outDir, { recursive: true });

      const browser = await chromium.launch();
      try {
        const page = await browser.newPage({ viewport: { width: 1280, height: 800 } });
        const results: CapturedScreenshot[] = [];
        const gifFrames: Buffer[] = [];
        let i = 0;
        for (const step of steps) {
          i += 1;
          // Deliberately NOT 'networkidle': a dev server (Next.js and others)
          // keeps a persistent HMR WebSocket open, so "zero connections for
          // 500ms" can simply never become true — it would silently eat the
          // full timeout on every navigation. 'load' fires reliably regardless.
          await page.goto(`http://localhost:${recipe.port}${step.path}`, { waitUntil: 'load', timeout: 30_000 });
          if (step.waitForSelector) await page.waitForSelector(step.waitForSelector, { timeout: 15_000 });
          const urlBeforeActions = page.url();
          for (const action of step.actions ?? []) {
            if (action.type === 'click') await page.click(action.selector, { timeout: 10_000 });
            else if (action.type === 'fill') await page.fill(action.selector, action.value ?? '', { timeout: 10_000 });
          }
          if (step.actions && step.actions.length > 0) {
            // A click/fill often kicks off an async request (a sign-in call, a
            // save, a redirect) that hasn't resolved the instant the action
            // returns. Rather than guess a fixed delay, wait for the one
            // concrete signal that a redirect actually happened — the URL
            // changing — and then for that new page to finish loading. If
            // nothing navigates (e.g. the action just opens a dropdown), this
            // times out quickly and capture proceeds as normal.
            // Passed as a string (not a closure) so it's evaluated in the
            // page's own browser context — this file has no DOM lib, since
            // everything else here runs in Node.
            // Generous timeout: a cold dev server (Next.js/Turbopack etc.)
            // often compiles the action/route on its very first real hit,
            // which can genuinely take several seconds — this isn't
            // optional slack, it's observed real-world behavior.
            await page
              .waitForFunction(`window.location.href !== ${JSON.stringify(urlBeforeActions)}`, { timeout: 20_000 })
              .then(() => page.waitForLoadState('load', { timeout: 15_000 }))
              .catch(() => {});
            await page.waitForTimeout(500); // brief settle for client-side render after 'load'
          }
          const filename = `${i}-${slug(step.label)}.png`;
          const relativePath = path.join(SCREENSHOT_OUTPUT_DIR, filename);
          await page.screenshot({ path: path.join(worktreePath, relativePath), fullPage: true });
          results.push({ label: step.label, relativePath });

          if (steps.length > 1) {
            // Viewport-only (not fullPage) so every frame is the same size —
            // fullPage height varies per page and a GIF can't mix frame sizes.
            gifFrames.push(await page.screenshot({ fullPage: false }));
          }
        }

        let gifPath: string | undefined;
        if (gifFrames.length > 1) {
          try {
            gifPath = await encodeGif(gifFrames, worktreePath);
          } catch {
            // The stills already succeeded — a GIF-assembly failure is not
            // worth losing them over.
          }
        }

        return { screenshots: results, gifPath };
      } finally {
        await browser.close();
      }
    } finally {
      this.stopServer(server);
    }
  }

  private async startServer(
    worktreePath: string,
    recipe: PreviewRecipe,
  ): Promise<{ child: ChildProcess; getOutput: () => string }> {
    const [bin, ...args] = recipe.startCommand;
    const child = spawn(bin!, args, {
      cwd: worktreePath,
      env: { ...process.env, ...recipe.env, PORT: String(recipe.port) },
      detached: true, // own process group, so stopServer can kill child processes it spawns (e.g. next dev's own children) too
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    // Bounded so a chatty dev server (verbose HMR logging, say) can't grow
    // this without limit over the full readyTimeoutMs wait.
    const OUTPUT_CAP = 8000;
    let output = '';
    const capture = (chunk: Buffer) => {
      output += chunk.toString();
      if (output.length > OUTPUT_CAP) output = output.slice(-OUTPUT_CAP);
    };
    child.stdout?.on('data', capture);
    child.stderr?.on('data', capture);
    return { child, getOutput: () => output };
  }

  private stopServer(child: ChildProcess): void {
    if (child.pid == null) return;
    try {
      process.kill(-child.pid, 'SIGKILL'); // negative pid = whole process group
    } catch {
      // already dead
    }
  }
}

export class MockScreenshotCapture implements ScreenshotCapture {
  calls: Array<{ worktreePath: string; recipe: PreviewRecipe; steps: ScreenshotStep[] }> = [];
  constructor(private fakeResult?: CaptureResult) {}

  async capture(worktreePath: string, recipe: PreviewRecipe, steps: ScreenshotStep[]): Promise<CaptureResult> {
    this.calls.push({ worktreePath, recipe, steps });
    if (this.fakeResult) return this.fakeResult;
    // Write real placeholder files so a real `git add -A` in a test still
    // has something concrete to commit — mirrors what the live path produces.
    const results: CapturedScreenshot[] = [];
    let i = 0;
    for (const step of steps) {
      i += 1;
      const relativePath = path.join(SCREENSHOT_OUTPUT_DIR, `${i}-${slug(step.label)}.png`);
      await mkdir(path.dirname(path.join(worktreePath, relativePath)), { recursive: true });
      await writeFile(path.join(worktreePath, relativePath), Buffer.from([0x89, 0x50, 0x4e, 0x47]));
      results.push({ label: step.label, relativePath });
    }
    let gifPath: string | undefined;
    if (steps.length > 1) {
      gifPath = path.join(SCREENSHOT_OUTPUT_DIR, 'feature-in-action.gif');
      await writeFile(path.join(worktreePath, gifPath), Buffer.from([0x47, 0x49, 0x46, 0x38, 0x39, 0x61]));
    }
    return { screenshots: results, gifPath };
  }
}

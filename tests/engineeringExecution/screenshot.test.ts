import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, mkdirSync, rmSync, writeFileSync, readFileSync, existsSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import {
  readScreenshotSteps,
  cleanupScreenshotSteps,
  MockScreenshotCapture,
  PlaywrightScreenshotCapture,
  SCREENSHOT_STEPS_PATH,
  type PreviewRecipe,
} from '../../src/agents/engineeringExecution/screenshot.js';

const cleanupPaths: string[] = [];
afterEach(() => {
  for (const p of cleanupPaths.splice(0)) rmSync(p, { recursive: true, force: true });
});

function makeWorktree(): string {
  const dir = mkdtempSync(join(tmpdir(), 'screenshot-test-'));
  cleanupPaths.push(dir);
  return dir;
}

describe('readScreenshotSteps', () => {
  it('returns null when the implementer wrote no steps file', async () => {
    const worktree = makeWorktree();
    expect(await readScreenshotSteps(worktree)).toBeNull();
  });

  it('reads a valid steps file', async () => {
    const worktree = makeWorktree();
    const steps = [{ label: 'Home', path: '/' }];
    mkdirSync(join(worktree, '.work-agent'));
    writeFileSync(join(worktree, SCREENSHOT_STEPS_PATH), JSON.stringify(steps));
    expect(await readScreenshotSteps(worktree)).toEqual(steps);
  });

  it('treats malformed JSON as "no steps" rather than throwing', async () => {
    const worktree = makeWorktree();
    mkdirSync(join(worktree, '.work-agent'));
    writeFileSync(join(worktree, SCREENSHOT_STEPS_PATH), '{ not valid json');
    expect(await readScreenshotSteps(worktree)).toBeNull();
  });

  it('treats an empty array as "no steps"', async () => {
    const worktree = makeWorktree();
    mkdirSync(join(worktree, '.work-agent'));
    writeFileSync(join(worktree, SCREENSHOT_STEPS_PATH), '[]');
    expect(await readScreenshotSteps(worktree)).toBeNull();
  });
});

describe('cleanupScreenshotSteps', () => {
  it('removes the steps file so it never ships in the PR diff', async () => {
    const worktree = makeWorktree();
    mkdirSync(join(worktree, '.work-agent'));
    writeFileSync(join(worktree, SCREENSHOT_STEPS_PATH), '[]');
    await cleanupScreenshotSteps(worktree);
    expect(existsSync(join(worktree, SCREENSHOT_STEPS_PATH))).toBe(false);
  });

  it('is a no-op when there is nothing to remove', async () => {
    const worktree = makeWorktree();
    await expect(cleanupScreenshotSteps(worktree)).resolves.not.toThrow();
  });
});

describe('MockScreenshotCapture', () => {
  it('records the call and writes real placeholder files', async () => {
    const worktree = makeWorktree();
    const capture = new MockScreenshotCapture();
    const recipe: PreviewRecipe = { startCommand: ['node'], port: 1, readyPath: '/', readyTimeoutMs: 1000, env: {} };
    const result = await capture.capture(worktree, recipe, [{ label: 'Home Page!', path: '/' }]);
    expect(result.screenshots).toEqual([{ label: 'Home Page!', relativePath: join('.work-agent', 'screenshots', '1-home-page.png') }]);
    expect(existsSync(join(worktree, result.screenshots[0]!.relativePath))).toBe(true);
    expect(result.gifPath).toBeUndefined(); // only one step — nothing to animate
    expect(capture.calls).toHaveLength(1);
  });

  it('also produces a placeholder GIF once there is more than one step', async () => {
    const worktree = makeWorktree();
    const capture = new MockScreenshotCapture();
    const recipe: PreviewRecipe = { startCommand: ['node'], port: 1, readyPath: '/', readyTimeoutMs: 1000, env: {} };
    const result = await capture.capture(worktree, recipe, [
      { label: 'Before', path: '/' },
      { label: 'After', path: '/' },
    ]);
    expect(result.gifPath).toBe(join('.work-agent', 'screenshots', 'feature-in-action.gif'));
    expect(existsSync(join(worktree, result.gifPath!))).toBe(true);
  });

  it('returns a fixed fake result when given one, without touching the filesystem', async () => {
    const worktree = makeWorktree();
    const fake = { screenshots: [{ label: 'X', relativePath: 'x.png' }], gifPath: 'x.gif' };
    const capture = new MockScreenshotCapture(fake);
    const recipe: PreviewRecipe = { startCommand: ['node'], port: 1, readyPath: '/', readyTimeoutMs: 1000, env: {} };
    const result = await capture.capture(worktree, recipe, [{ label: 'Home', path: '/' }]);
    expect(result).toBe(fake);
  });
});

// Real end-to-end proof: a real static file server, a real headless
// Chromium via Playwright, real navigation and a real click action, real
// PNG files written back into the worktree — nothing here is mocked. This
// is the test the "does it actually take correct screenshots" question
// gets answered by, not just a visual spot-check.
describe('PlaywrightScreenshotCapture (real browser, real server)', () => {
  it('captures a real page, reflects a real click action, and always stops the server afterward', async () => {
    const worktree = makeWorktree();
    writeFileSync(
      join(worktree, 'index.html'),
      `<!doctype html><html><body style="background:#101B1B;color:#E7F1F0;font-family:sans-serif;padding:40px">
        <h1 id="marker">Screenshot E2E marker</h1>
        <button id="reveal-btn" onclick="document.getElementById('status').textContent='Revealed!'">Reveal</button>
        <p id="status">Hidden</p>
      </body></html>`,
    );
    writeFileSync(
      join(worktree, 'server.mjs'),
      `import { createServer } from 'node:http';
       import { readFile } from 'node:fs/promises';
       import { join } from 'node:path';
       const port = Number(process.env.PORT);
       createServer(async (req, res) => {
         try {
           const data = await readFile(join(process.cwd(), req.url === '/' ? 'index.html' : req.url.slice(1)));
           res.writeHead(200, { 'Content-Type': 'text/html' });
           res.end(data);
         } catch {
           res.writeHead(404);
           res.end('not found');
         }
       }).listen(port);`,
    );

    const port = 41230 + (process.pid % 500); // spread across parallel test workers
    const recipe: PreviewRecipe = {
      startCommand: ['node', 'server.mjs'],
      port,
      readyPath: '/',
      readyTimeoutMs: 15_000,
      env: {},
    };

    const capture = new PlaywrightScreenshotCapture();
    const result = await capture.capture(worktree, recipe, [
      { label: 'Landing page', path: '/', waitForSelector: '#marker' },
      {
        label: 'After clicking reveal',
        path: '/',
        waitForSelector: '#marker',
        actions: [{ type: 'click', selector: '#reveal-btn' }],
      },
    ]);
    const results = result.screenshots;

    expect(results).toHaveLength(2);
    expect(results[0]!.label).toBe('Landing page');
    expect(results[1]!.label).toBe('After clicking reveal');

    const file1 = join(worktree, results[0]!.relativePath);
    const file2 = join(worktree, results[1]!.relativePath);
    expect(existsSync(file1)).toBe(true);
    expect(existsSync(file2)).toBe(true);

    const bytes1 = readFileSync(file1);
    const bytes2 = readFileSync(file2);
    // Real PNG magic number — proves these are genuine images, not stubs.
    expect(bytes1.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(bytes2.subarray(0, 8).toString('hex')).toBe('89504e470d0a1a0a');
    expect(bytes1.length).toBeGreaterThan(1000);
    // Different visible content (the click actually ran) must produce a different image.
    expect(bytes1.equals(bytes2)).toBe(false);

    // Two steps were captured — a real animated GIF must have been assembled too.
    expect(result.gifPath).toBeDefined();
    const gifFile = join(worktree, result.gifPath!);
    expect(existsSync(gifFile)).toBe(true);
    const gifBytes = readFileSync(gifFile);
    expect(gifBytes.subarray(0, 6).toString('ascii')).toMatch(/^GIF8[79]a$/);
    expect(gifBytes.length).toBeGreaterThan(500);

    // The dev server must not be left running after capture returns.
    await expect(fetch(`http://localhost:${port}/`)).rejects.toThrow();
  }, 45_000);

  it('fails fast with a clear reason when the port is already occupied, instead of the generic timeout', async () => {
    const { createServer } = await import('node:net');
    const port = 41730 + (process.pid % 500);
    const occupier = createServer();
    await new Promise<void>((resolve) => occupier.listen(port, resolve));
    try {
      const worktree = makeWorktree();
      const recipe: PreviewRecipe = {
        startCommand: ['node', '-e', ''],
        port,
        readyPath: '/',
        readyTimeoutMs: 15_000,
        env: {},
      };
      const capture = new PlaywrightScreenshotCapture();
      await expect(capture.capture(worktree, recipe, [{ label: 'x', path: '/' }])).rejects.toThrow(/already in use/);
    } finally {
      await new Promise((resolve) => occupier.close(resolve));
    }
  }, 20_000);

  it('includes the dev server\'s own stdout/stderr in the error when it never becomes ready — no more silent, unexplained timeouts', async () => {
    const worktree = makeWorktree();
    const port = 41930 + (process.pid % 500);
    const recipe: PreviewRecipe = {
      // Never listens on the port — proves the timeout path, not a real
      // server. Prints a distinctive marker so the test can assert the
      // failure surfaces it instead of a bare "did not become ready".
      startCommand: ['node', '-e', "console.error('BOOM: simulated dev server crash reason'); setInterval(() => {}, 1000)"],
      port,
      readyPath: '/',
      readyTimeoutMs: 2_000,
      env: {},
    };
    const capture = new PlaywrightScreenshotCapture();
    await expect(capture.capture(worktree, recipe, [{ label: 'x', path: '/' }])).rejects.toThrow(
      /BOOM: simulated dev server crash reason/,
    );
  }, 20_000);
});

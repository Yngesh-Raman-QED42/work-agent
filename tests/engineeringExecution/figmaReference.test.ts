import { describe, expect, it, afterEach } from 'vitest';
import { mkdtempSync, rmSync, existsSync, readFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createTestDb, type TestDbHandle } from '../../src/test-utils/db.js';
import { AuditLog } from '../../src/pipeline/audit.js';
import { collectFigmaReferences, FIGMA_REFERENCE_DIR } from '../../src/agents/engineeringExecution/figmaReference.js';
import { MockFigmaClient } from '../../src/integrations/figma/client.js';
import type { TaskContext } from '../../src/agents/engineeringExecution/models.js';

function makeTask(overrides: Partial<TaskContext> = {}): TaskContext {
  return {
    key: 'PROJ-1',
    project: 'PROJ',
    summary: 'Build the homepage',
    description: 'A plain description with no design link.',
    issueType: 'Task',
    status: 'To Do',
    priority: 'Medium',
    url: 'http://x/PROJ-1',
    comments: [],
    ...overrides,
  };
}

let handle: TestDbHandle | null = null;
let worktreePath: string;
afterEach(async () => {
  await handle?.close();
  handle = null;
  if (worktreePath) rmSync(worktreePath, { recursive: true, force: true });
});

async function setup() {
  handle = await createTestDb();
  worktreePath = mkdtempSync(join(tmpdir(), 'figma-ref-'));
  return { audit: new AuditLog(handle.db) };
}

describe('collectFigmaReferences', () => {
  it('returns [] and touches nothing on disk when the ticket has no Figma link', async () => {
    const { audit } = await setup();
    const refs = await collectFigmaReferences(makeTask(), worktreePath, audit);
    expect(refs).toEqual([]);
    expect(existsSync(join(worktreePath, FIGMA_REFERENCE_DIR))).toBe(false);
  });

  it('renders a linked frame and saves it inside the worktree, named by its own Figma frame name', async () => {
    const { audit } = await setup();
    const task = makeTask({ description: 'Build this: https://figma.com/design/ABC/x?node-id=1-1' });
    const client = new MockFigmaClient({ 'ABC:1:1': { name: 'Homepage / Desktop', pngBytes: Buffer.from([1, 2, 3]) } });

    const refs = await collectFigmaReferences(task, worktreePath, audit, () => client);

    expect(refs).toHaveLength(1);
    expect(refs[0]!.name).toBe('Homepage / Desktop');
    expect(refs[0]!.savedRelativePath).toMatch(/^\.work-agent\/figma-reference\/figma-1-homepage-desktop\.png$/);
    const saved = readFileSync(join(worktreePath, refs[0]!.savedRelativePath!));
    expect(saved).toEqual(Buffer.from([1, 2, 3]));
  });

  it('keeps a desktop and a mobile reference from the same file as two separately saved images', async () => {
    const { audit } = await setup();
    const task = makeTask({
      description: 'Desktop: https://figma.com/design/ABC/x?node-id=1-1',
      comments: [{ author: 'PM', body: 'Mobile: https://figma.com/design/ABC/x?node-id=2-2' }],
    });
    const client = new MockFigmaClient({
      'ABC:1:1': { name: 'Homepage / Desktop', pngBytes: Buffer.from([1]) },
      'ABC:2:2': { name: 'Homepage / Mobile', pngBytes: Buffer.from([2]) },
    });

    const refs = await collectFigmaReferences(task, worktreePath, audit, () => client);

    expect(refs).toHaveLength(2);
    expect(refs.map((r) => r.name)).toEqual(['Homepage / Desktop', 'Homepage / Mobile']);
    expect(refs[0]!.savedRelativePath).not.toBe(refs[1]!.savedRelativePath);
  });

  it('a whole-file link with no node-id is passed through as a bare URL, never rendered', async () => {
    const { audit } = await setup();
    const task = makeTask({ description: 'See the whole file: https://figma.com/file/ABC/x' });
    const client = new MockFigmaClient();
    const refs = await collectFigmaReferences(task, worktreePath, audit, () => client);
    expect(refs).toEqual([{ url: 'https://figma.com/file/ABC/x' }]);
  });

  it('when no FIGMA_ACCESS_TOKEN is configured (client factory throws), the raw link still passes through', async () => {
    const { audit } = await setup();
    const task = makeTask({ description: 'https://figma.com/design/ABC/x?node-id=1-1' });
    const refs = await collectFigmaReferences(task, worktreePath, audit, () => {
      throw new Error('LiveFigmaClient requires FIGMA_ACCESS_TOKEN');
    });
    expect(refs).toEqual([{ url: 'https://figma.com/design/ABC/x?node-id=1-1' }]);
  });

  it('one ref failing to render never stops the others — each is caught independently', async () => {
    const { audit } = await setup();
    const task = makeTask({
      description: 'https://figma.com/design/BAD/x?node-id=1-1 and https://figma.com/design/GOOD/x?node-id=2-2',
    });
    const client = {
      renderNode: async (fileKey: string, _nodeId: string) => {
        if (fileKey === 'BAD') throw new Error('Figma is down for this one');
        return { name: 'Good Frame', pngBytes: Buffer.from([7]) };
      },
    };
    const refs = await collectFigmaReferences(task, worktreePath, audit, () => client);
    expect(refs).toHaveLength(2);
    expect(refs[0]).toEqual({ url: 'https://figma.com/design/BAD/x?node-id=1-1' }); // failed -> bare URL
    expect(refs[1]!.name).toBe('Good Frame'); // unaffected by the first one's failure
  });

  it('scans a story\'s sub-tasks for Figma links too, not just the story\'s own text', async () => {
    const { audit } = await setup();
    const story = makeTask({
      key: 'PROJ-STORY',
      description: 'No design link here.',
      subtasks: [makeTask({ key: 'PROJ-SUB', description: 'https://figma.com/design/ABC/x?node-id=1-1' })],
    });
    const client = new MockFigmaClient({ 'ABC:1:1': { name: 'Sub-task Frame', pngBytes: Buffer.from([4]) } });
    const refs = await collectFigmaReferences(story, worktreePath, audit, () => client);
    expect(refs).toHaveLength(1);
    expect(refs[0]!.name).toBe('Sub-task Frame');
  });

  it('a node that does not resolve to an image falls back to a bare URL, not a crash', async () => {
    const { audit } = await setup();
    const task = makeTask({ description: 'https://figma.com/design/ABC/x?node-id=1-1' });
    const client = new MockFigmaClient({}); // no fixture -> renderNode resolves null
    const refs = await collectFigmaReferences(task, worktreePath, audit, () => client);
    expect(refs).toEqual([{ url: 'https://figma.com/design/ABC/x?node-id=1-1' }]);
  });
});

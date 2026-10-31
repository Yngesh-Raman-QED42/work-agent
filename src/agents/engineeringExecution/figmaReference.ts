import { mkdir, writeFile } from 'node:fs/promises';
import path from 'node:path';
import { extractFigmaRefs } from '../../models/types.js';
import type { TaskContext } from './models.js';
import type { FigmaClient } from '../../integrations/figma/client.js';
import { LiveFigmaClient } from '../../integrations/figma/client.js';
import type { AuditLog } from '../../pipeline/audit.js';

export const FIGMA_REFERENCE_DIR = '.work-agent/figma-reference';

export interface FigmaDesignReference {
  url: string;
  // The frame's own Figma name (e.g. "Homepage / Desktop") — present only
  // when the ref pointed at one specific node AND rendering it succeeded.
  name?: string;
  // Relative to the worktree root — present only alongside `name`. The
  // implementer can Read this file directly; it's a real file sitting in
  // its own worktree, not something that has to be fetched or described.
  savedRelativePath?: string;
}

/**
 * Finds every Figma link in a ticket (and, for a story, every sub-task's
 * text too — see policy.ts's isEligible for the same whole-group
 * reasoning), renders whichever ones point at one specific frame
 * (a "node-id" in the URL — a whole-file link has nothing singular to
 * render) to a PNG saved inside the worktree, and returns enough for the
 * prompt to point the implementer at each one by name.
 *
 * Entirely best-effort and additive, the same way the screenshot step in
 * runbook.ts is: the overwhelming majority of tickets have no Figma link
 * at all, in which case this returns [] immediately and touches nothing
 * on disk. When FIGMA_ACCESS_TOKEN isn't configured, or any individual
 * fetch fails (bad token, a deleted node, a network hiccup), that's
 * logged and the raw link is still passed through with no image attached
 * — Engineering Execution never stops exec-start over a design reference
 * failing to render, same as it never stops over a screenshot failing.
 */
export async function collectFigmaReferences(
  task: TaskContext,
  worktreePath: string,
  audit: AuditLog,
  makeClient: () => FigmaClient = () => new LiveFigmaClient(),
): Promise<FigmaDesignReference[]> {
  const texts: Array<string | null | undefined> = [task.description, ...task.comments.map((c) => c.body)];
  for (const sub of task.subtasks ?? []) {
    texts.push(sub.description, ...sub.comments.map((c) => c.body));
  }
  const refs = extractFigmaRefs(...texts);
  if (refs.length === 0) return [];

  await audit.log('figma_refs_found', { key: task.key, count: refs.length, urls: refs.map((r) => r.url) });

  let client: FigmaClient;
  try {
    client = makeClient();
  } catch (err) {
    // No FIGMA_ACCESS_TOKEN set — the links themselves are still real
    // signal worth handing to the implementer (see prompt.ts), just
    // without a pre-rendered image to go with them.
    await audit.log('figma_client_unavailable', { key: task.key, error: String(err) });
    return refs.map((r) => ({ url: r.url }));
  }

  return Promise.all(
    refs.map(async (ref, i): Promise<FigmaDesignReference> => {
      if (!ref.nodeId) return { url: ref.url };
      try {
        const image = await client.renderNode(ref.fileKey, ref.nodeId);
        if (!image) return { url: ref.url };
        const dir = path.join(worktreePath, FIGMA_REFERENCE_DIR);
        await mkdir(dir, { recursive: true });
        const filename = `figma-${i + 1}-${slugify(image.name)}.png`;
        await writeFile(path.join(dir, filename), image.pngBytes);
        await audit.log('figma_reference_saved', { key: task.key, url: ref.url, name: image.name, filename });
        return { url: ref.url, name: image.name, savedRelativePath: path.join(FIGMA_REFERENCE_DIR, filename) };
      } catch (err) {
        await audit.log('figma_render_failed', { key: task.key, url: ref.url, error: String(err) });
        return { url: ref.url };
      }
    }),
  );
}

function slugify(name: string): string {
  const s = name.toLowerCase().replace(/[^a-z0-9]+/g, '-').replace(/^-+|-+$/g, '').slice(0, 40);
  return s || 'frame';
}

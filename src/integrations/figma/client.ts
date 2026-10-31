// Read-only Figma REST client — the design-reference equivalent of
// jira/live.ts's LiveJiraConnector. Only ever used by Engineering
// Execution's figmaReference.ts, and only when a ticket's text actually
// contains a Figma link (see extractFigmaRefs in models/types.ts); most
// tickets never touch this file at all.

export interface FigmaNodeImage {
  // The frame/node's own name in Figma (e.g. "Homepage / Desktop") — real
  // design files commonly name separate frames this way, which is what
  // lets a ticket linking two frames read as "desktop" + "mobile" in the
  // implementation prompt without this code having to guess.
  name: string;
  pngBytes: Buffer;
}

export interface FigmaClient {
  /**
   * Renders one specific node to a PNG, returning its own Figma name
   * alongside the image bytes. Returns null (not a throw) when the node
   * itself doesn't resolve to an image — deleted, no access, or a node id
   * Figma's API just doesn't recognize — so one bad ref in a ticket never
   * stops the others from being fetched.
   */
  renderNode(fileKey: string, nodeId: string): Promise<FigmaNodeImage | null>;
}

export class LiveFigmaClient implements FigmaClient {
  private token: string;

  constructor(opts?: { token?: string }) {
    this.token = opts?.token ?? process.env.FIGMA_ACCESS_TOKEN ?? '';
    if (!this.token) {
      throw new Error('LiveFigmaClient requires FIGMA_ACCESS_TOKEN');
    }
  }

  private headers(): Record<string, string> {
    return { 'X-Figma-Token': this.token, Accept: 'application/json' };
  }

  async renderNode(fileKey: string, nodeId: string): Promise<FigmaNodeImage | null> {
    const encodedId = encodeURIComponent(nodeId);
    const [nameResp, imageResp] = await Promise.all([
      fetch(`https://api.figma.com/v1/files/${fileKey}/nodes?ids=${encodedId}`, { headers: this.headers() }),
      // scale=2 — a standard @2x render reads far more clearly as a pixel
      // reference than the 1x default, at a trivial size cost.
      fetch(`https://api.figma.com/v1/images/${fileKey}?ids=${encodedId}&format=png&scale=2`, { headers: this.headers() }),
    ]);
    if (!nameResp.ok) throw new Error(`Figma node fetch failed: ${nameResp.status} ${await nameResp.text()}`);
    if (!imageResp.ok) throw new Error(`Figma image render failed: ${imageResp.status} ${await imageResp.text()}`);

    const nameData = (await nameResp.json()) as { nodes: Record<string, { document?: { name: string } } | null> };
    const imageData = (await imageResp.json()) as { images: Record<string, string | null>; err?: string };

    const imageUrl = imageData.images[nodeId];
    if (!imageUrl) return null;

    const name = nameData.nodes[nodeId]?.document?.name ?? nodeId;
    const bytesResp = await fetch(imageUrl);
    if (!bytesResp.ok) throw new Error(`Figma rendered-image download failed: ${bytesResp.status}`);
    const pngBytes = Buffer.from(await bytesResp.arrayBuffer());

    return { name, pngBytes };
  }
}

export class MockFigmaClient implements FigmaClient {
  constructor(private fixtures: Record<string, FigmaNodeImage | null> = {}) {}

  async renderNode(fileKey: string, nodeId: string): Promise<FigmaNodeImage | null> {
    return this.fixtures[`${fileKey}:${nodeId}`] ?? null;
  }
}

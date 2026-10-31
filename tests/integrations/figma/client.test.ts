import { describe, expect, it, vi, afterEach } from 'vitest';
import { LiveFigmaClient, MockFigmaClient } from '../../../src/integrations/figma/client.js';

afterEach(() => {
  vi.restoreAllMocks();
});

function stubFigmaFetch(opts: { nodeName?: string; imageUrl?: string | null; pngBytes?: Uint8Array }) {
  const fetchMock = vi.fn().mockImplementation((url: string) => {
    if (url.includes('/v1/files/')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ nodes: { '12:345': opts.nodeName ? { document: { name: opts.nodeName } } : null } }),
      });
    }
    if (url.includes('/v1/images/')) {
      return Promise.resolve({
        ok: true,
        json: async () => ({ images: { '12:345': opts.imageUrl === undefined ? 'https://s3.example/rendered.png' : opts.imageUrl } }),
      });
    }
    // The pre-signed S3 download URL itself.
    return Promise.resolve({ ok: true, arrayBuffer: async () => (opts.pngBytes ?? new Uint8Array([1, 2, 3])).buffer });
  });
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('LiveFigmaClient', () => {
  it('requires a Figma access token', () => {
    expect(() => new LiveFigmaClient({ token: '' })).toThrow(/requires FIGMA_ACCESS_TOKEN/);
  });

  it('renders a node, returning its own Figma name alongside the image bytes', async () => {
    stubFigmaFetch({ nodeName: 'Homepage / Desktop', pngBytes: new Uint8Array([9, 9, 9]) });
    const client = new LiveFigmaClient({ token: 'tok' });
    const result = await client.renderNode('FILEKEY', '12:345');
    expect(result).not.toBeNull();
    expect(result!.name).toBe('Homepage / Desktop');
    expect(Buffer.from(result!.pngBytes)).toEqual(Buffer.from([9, 9, 9]));
  });

  it('sends the token as X-Figma-Token, not Bearer/Basic auth', async () => {
    const fetchMock = stubFigmaFetch({ nodeName: 'Frame' });
    const client = new LiveFigmaClient({ token: 'my-secret-token' });
    await client.renderNode('FILEKEY', '12:345');
    const call = fetchMock.mock.calls.find((c: unknown[]) => (c[0] as string).includes('/v1/files/'))!;
    expect(call[1].headers['X-Figma-Token']).toBe('my-secret-token');
  });

  it('falls back to the raw node id as the name when Figma has no name for it', async () => {
    stubFigmaFetch({ nodeName: undefined });
    const client = new LiveFigmaClient({ token: 'tok' });
    const result = await client.renderNode('FILEKEY', '12:345');
    expect(result!.name).toBe('12:345');
  });

  it('returns null (not a throw) when the node does not resolve to an image', async () => {
    stubFigmaFetch({ nodeName: 'Frame', imageUrl: null });
    const client = new LiveFigmaClient({ token: 'tok' });
    const result = await client.renderNode('FILEKEY', '12:345');
    expect(result).toBeNull();
  });

  it('throws with the response body when the Figma API itself rejects the request', async () => {
    vi.stubGlobal(
      'fetch',
      vi.fn().mockResolvedValue({ ok: false, status: 403, text: async () => 'Invalid token' }),
    );
    const client = new LiveFigmaClient({ token: 'bad-token' });
    await expect(client.renderNode('FILEKEY', '12:345')).rejects.toThrow(/403/);
  });
});

describe('MockFigmaClient', () => {
  it('returns the fixture for a matching file+node, null otherwise', async () => {
    const client = new MockFigmaClient({ 'FILEKEY:12:345': { name: 'Homepage', pngBytes: Buffer.from([1]) } });
    expect(await client.renderNode('FILEKEY', '12:345')).toEqual({ name: 'Homepage', pngBytes: Buffer.from([1]) });
    expect(await client.renderNode('FILEKEY', '99:999')).toBeNull();
  });
});

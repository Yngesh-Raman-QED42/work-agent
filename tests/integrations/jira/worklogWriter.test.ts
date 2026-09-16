import { describe, expect, it, vi, afterEach } from 'vitest';
import { LiveJiraWorklogWriter, MockJiraWorklogWriter } from '../../../src/integrations/jira/worklogWriter.js';

afterEach(() => {
  vi.restoreAllMocks();
});

describe('LiveJiraWorklogWriter', () => {
  it('requires Jira credentials', () => {
    expect(() => new LiveJiraWorklogWriter({ baseUrl: '', email: '', apiToken: '' })).toThrow(/requires JIRA_BASE_URL/);
  });

  it('POSTs a worklog with the minutes converted to seconds', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const writer = new LiveJiraWorklogWriter({ baseUrl: 'https://x.atlassian.net', email: 'e@x.com', apiToken: 'tok' });
    await writer.logWork('PROJ-1', 90);

    expect(fetchMock).toHaveBeenCalledTimes(1);
    const [url, opts] = fetchMock.mock.calls[0]!;
    expect(url).toBe('https://x.atlassian.net/rest/api/3/issue/PROJ-1/worklog');
    expect(opts.method).toBe('POST');
    const body = JSON.parse(opts.body);
    expect(body.timeSpentSeconds).toBe(90 * 60);
    expect(body.comment).toBeUndefined();
  });

  it('includes a comment as an ADF document when provided', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const writer = new LiveJiraWorklogWriter({ baseUrl: 'https://x.atlassian.net', email: 'e@x.com', apiToken: 'tok' });
    await writer.logWork('PROJ-1', 30, { comment: 'autonomous work' });

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.comment.type).toBe('doc');
    expect(body.comment.content[0].content[0].text).toBe('autonomous work');
  });

  it('sets "started" from an explicit date, so a backdated request lands on the right day', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const writer = new LiveJiraWorklogWriter({ baseUrl: 'https://x.atlassian.net', email: 'e@x.com', apiToken: 'tok' });
    await writer.logWork('PROJ-1', 60, { date: '2026-09-11' });

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.started).toBe('2026-09-11T09:00:00.000+0000');
  });

  it('omits "started" entirely when no date is given, so Jira defaults to now', async () => {
    const fetchMock = vi.fn().mockResolvedValue({ ok: true, text: async () => '' });
    vi.stubGlobal('fetch', fetchMock);

    const writer = new LiveJiraWorklogWriter({ baseUrl: 'https://x.atlassian.net', email: 'e@x.com', apiToken: 'tok' });
    await writer.logWork('PROJ-1', 60);

    const body = JSON.parse(fetchMock.mock.calls[0]![1].body);
    expect(body.started).toBeUndefined();
  });

  it('rejects a non-positive duration without making a request', async () => {
    const fetchMock = vi.fn();
    vi.stubGlobal('fetch', fetchMock);
    const writer = new LiveJiraWorklogWriter({ baseUrl: 'https://x.atlassian.net', email: 'e@x.com', apiToken: 'tok' });
    await expect(writer.logWork('PROJ-1', 0)).rejects.toThrow(/positive/);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('throws with the response body when Jira rejects the write', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue({ ok: false, status: 400, text: async () => 'bad request' }));
    const writer = new LiveJiraWorklogWriter({ baseUrl: 'https://x.atlassian.net', email: 'e@x.com', apiToken: 'tok' });
    await expect(writer.logWork('PROJ-1', 10)).rejects.toThrow(/400/);
  });
});

describe('MockJiraWorklogWriter', () => {
  it('records what would have been logged, without any network call', async () => {
    const writer = new MockJiraWorklogWriter();
    await writer.logWork('PROJ-1', 45, { comment: 'note', date: '2026-09-11' });
    expect(writer.logged).toEqual([{ key: 'PROJ-1', minutes: 45, comment: 'note', date: '2026-09-11' }]);
  });
});

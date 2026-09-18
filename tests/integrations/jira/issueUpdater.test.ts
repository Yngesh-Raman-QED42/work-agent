import { describe, expect, it } from 'vitest';
import { MockJiraIssueUpdater } from '../../../src/integrations/jira/issueUpdater.js';

describe('MockJiraIssueUpdater.updateDescription', () => {
  it('tracks each call so a test can assert on what was written', async () => {
    const updater = new MockJiraIssueUpdater();
    await updater.updateDescription('PROJ-1', 'new description text');
    expect(updater.descriptionUpdates).toEqual([{ key: 'PROJ-1', text: 'new description text' }]);
  });

  it('tracks multiple calls in order', async () => {
    const updater = new MockJiraIssueUpdater();
    await updater.updateDescription('PROJ-1', 'first');
    await updater.updateDescription('PROJ-2', 'second');
    expect(updater.descriptionUpdates).toEqual([
      { key: 'PROJ-1', text: 'first' },
      { key: 'PROJ-2', text: 'second' },
    ]);
  });
});

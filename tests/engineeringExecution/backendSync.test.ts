import { describe, expect, it } from 'vitest';
import { runBackendSync } from '../../src/agents/engineeringExecution/backendSync.js';

describe('runBackendSync (real commands)', () => {
  it('reports success and keeps only the last lines of output', async () => {
    const result = await runBackendSync({
      command: ['sh', '-c', 'for i in $(seq 1 30); do echo line$i; done'],
      timeoutMs: 10_000,
      onFailure: 'warn',
    });
    expect(result.ok).toBe(true);
    expect(result.outputTail.split('\n')).toHaveLength(15);
    expect(result.outputTail.endsWith('line30')).toBe(true);
  });

  it('reports failure on a non-zero exit, with stderr in the tail', async () => {
    const result = await runBackendSync({
      command: ['sh', '-c', 'echo "FAILED: Docker is not running" >&2; exit 1'],
      timeoutMs: 10_000,
      onFailure: 'stop',
    });
    expect(result.ok).toBe(false);
    expect(result.outputTail).toContain('FAILED: Docker is not running');
  });

  it('runs in the configured working directory', async () => {
    const result = await runBackendSync({ command: ['pwd'], cwd: '/tmp', timeoutMs: 10_000, onFailure: 'warn' });
    expect(result.outputTail).toBe('/tmp');
  });

  it('treats a timeout as a failure', async () => {
    const result = await runBackendSync({ command: ['sleep', '5'], timeoutMs: 200, onFailure: 'warn' });
    expect(result.ok).toBe(false);
    expect(result.outputTail).toContain('timed out');
  });
});

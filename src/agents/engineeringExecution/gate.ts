import type { CheckResult, GateDecision } from './models.js';

const DEFAULT_FORBIDDEN_PATH_PATTERNS = [
  /\.github\/workflows\//,
  /(^|\/)\.env(\.[a-zA-Z0-9_]+)?$/,
  /(^|\/)drizzle\//,
  /src\/(core\/)?db\/migrate/,
  /package-lock\.json$/,
  /pnpm-lock\.yaml$/,
  /yarn\.lock$/,
  /(^|\/)\.git\//,
];

export interface GateConfig {
  maxChangedFiles: number;
  forbiddenPathPatterns: RegExp[];
}

export const DEFAULT_GATE_CONFIG: GateConfig = {
  maxChangedFiles: 15,
  forbiddenPathPatterns: DEFAULT_FORBIDDEN_PATH_PATTERNS,
};

export function parseChangedFiles(diffStat: string): string[] {
  const files: string[] = [];
  for (const line of diffStat.split('\n')) {
    if (!line.includes('|')) continue;
    const name = line.split('|', 1)[0]!.trim();
    if (name) files.push(name);
  }
  return files;
}

/** The one place that decides whether it's safe to commit/push/open a PR.
 * Any failure here means: stop, and the caller must file an approval-queue
 * entry instead of proceeding. */
export function evaluateGate(checks: CheckResult[], diffStat: string, config: GateConfig = DEFAULT_GATE_CONFIG): GateDecision {
  const reasons: string[] = [];

  const failed = checks.filter((c) => !c.passed).map((c) => c.name);
  if (failed.length > 0) reasons.push(`failing checks: ${failed.join(', ')}`);

  const changedFiles = parseChangedFiles(diffStat);
  if (changedFiles.length === 0) {
    reasons.push('diff is empty — nothing was changed');
  } else if (changedFiles.length > config.maxChangedFiles) {
    reasons.push(`diff touches ${changedFiles.length} files, exceeding the autonomy threshold of ${config.maxChangedFiles}`);
  }

  for (const path of changedFiles) {
    for (const pattern of config.forbiddenPathPatterns) {
      if (pattern.test(path)) reasons.push(`diff touches a forbidden path: ${path} (matches ${pattern})`);
    }
  }

  if (reasons.length > 0) return { proceed: false, reasons };
  return { proceed: true, reasons: ['all checks passed', 'diff is non-empty, scoped, and touches no forbidden paths'] };
}

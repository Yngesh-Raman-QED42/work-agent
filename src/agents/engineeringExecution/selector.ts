import type { TaskContext } from './models.js';
import type { AutonomyPolicy } from './policy.js';

const BULLET_LINE_RE = /^\s*(?:[-*•]|\d+[.)])\s+\S/gm;

/** Number of enumerated requirement/acceptance-criteria lines. A more robust
 * scope proxy than raw description length: resistant to one ticket just
 * being written more verbosely than another, and it directly reads "how
 * many distinct things does this ticket ask for." (This tiebreak was added
 * after a real run picked the wrong ticket using raw length alone — see the
 * Python prototype's history / tests for the regression case.) */
function requirementCount(task: TaskContext): number {
  return [...task.description.matchAll(BULLET_LINE_RE)].length;
}

export interface CandidateEvaluation {
  task: TaskContext;
  eligible: boolean;
  reasons: string[];
  excludedDuplicate: boolean;
}

export interface SelectionResult {
  picked: TaskContext | null;
  evaluations: CandidateEvaluation[];
}

export function evaluateCandidates(
  candidates: TaskContext[],
  policy: AutonomyPolicy,
  hasExistingPr: (key: string) => boolean = () => false,
): CandidateEvaluation[] {
  return candidates.map((task) => {
    const { eligible, reasons } = policy.isEligible(task);
    if (eligible && hasExistingPr(task.key)) {
      return { task, eligible: false, reasons: [`an open or existing PR already references ${task.key}`], excludedDuplicate: true };
    }
    return { task, eligible, reasons, excludedDuplicate: false };
  });
}

export function selectTask(
  candidates: TaskContext[],
  policy: AutonomyPolicy,
  hasExistingPr: (key: string) => boolean = () => false,
): SelectionResult {
  const evaluations = evaluateCandidates(candidates, policy, hasExistingPr);
  const eligible = evaluations.filter((e) => e.eligible).map((e) => e.task);
  if (eligible.length === 0) return { picked: null, evaluations };

  eligible.sort((a, b) => {
    const reqDiff = requirementCount(a) - requirementCount(b);
    if (reqDiff !== 0) return reqDiff;
    const lenDiff = a.description.trim().length - b.description.trim().length;
    if (lenDiff !== 0) return lenDiff;
    return a.key.localeCompare(b.key);
  });

  return { picked: eligible[0]!, evaluations };
}

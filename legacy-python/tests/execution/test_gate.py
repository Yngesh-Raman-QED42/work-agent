import unittest

from work_agent.execution.gate import GateConfig, evaluate_gate, parse_changed_files
from work_agent.execution.models import CheckResult

PASSING_CHECKS = [
    CheckResult(name="test", command="npm test", passed=True, output=""),
    CheckResult(name="lint", command="npm run lint", passed=True, output=""),
]
FAILING_CHECKS = [
    CheckResult(name="test", command="npm test", passed=False, output="1 failing"),
    CheckResult(name="lint", command="npm run lint", passed=True, output=""),
]
SMALL_DIFF = " src/components/planner/AllocationBar.tsx | 8 +++++---\n 1 file changed, 5 insertions(+), 3 deletions(-)"


class TestParseChangedFiles(unittest.TestCase):
    def test_parses_file_names(self):
        files = parse_changed_files(SMALL_DIFF)
        self.assertEqual(files, ["src/components/planner/AllocationBar.tsx"])

    def test_empty_diff_returns_no_files(self):
        self.assertEqual(parse_changed_files(""), [])


class TestEvaluateGate(unittest.TestCase):
    def test_passing_checks_and_small_clean_diff_proceeds(self):
        decision = evaluate_gate(PASSING_CHECKS, SMALL_DIFF)
        self.assertTrue(decision.proceed)

    def test_failing_check_blocks(self):
        decision = evaluate_gate(FAILING_CHECKS, SMALL_DIFF)
        self.assertFalse(decision.proceed)
        self.assertTrue(any("test" in r for r in decision.reasons))

    def test_empty_diff_blocks(self):
        decision = evaluate_gate(PASSING_CHECKS, "")
        self.assertFalse(decision.proceed)

    def test_too_many_files_blocks(self):
        diff = "\n".join(f" src/file{i}.ts | 1 +" for i in range(20))
        decision = evaluate_gate(PASSING_CHECKS, diff, config=GateConfig(max_changed_files=15))
        self.assertFalse(decision.proceed)
        self.assertTrue(any("exceeding" in r for r in decision.reasons))

    def test_forbidden_path_blocks(self):
        diff = " .github/workflows/ci.yml | 3 +--\n 1 file changed"
        decision = evaluate_gate(PASSING_CHECKS, diff)
        self.assertFalse(decision.proceed)
        self.assertTrue(any("forbidden path" in r for r in decision.reasons))

    def test_lockfile_change_blocks(self):
        diff = " package-lock.json | 40 +++++++++++-----\n 1 file changed"
        decision = evaluate_gate(PASSING_CHECKS, diff)
        self.assertFalse(decision.proceed)

    def test_env_file_change_blocks(self):
        diff = " .env.production | 1 +\n 1 file changed"
        decision = evaluate_gate(PASSING_CHECKS, diff)
        self.assertFalse(decision.proceed)


if __name__ == "__main__":
    unittest.main()

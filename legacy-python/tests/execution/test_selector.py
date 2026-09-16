import unittest

from work_agent.execution.models import TaskContext
from work_agent.execution.policy import AutonomyPolicy
from work_agent.execution.selector import evaluate_candidates, select_task


def make_task(key, description_len=100, priority="Medium", project="QED42OPSIN"):
    return TaskContext(
        key=key, project=project, summary=f"summary {key}", description="d" * description_len,
        issue_type="Task", status="To Do", priority=priority, url=f"http://x/{key}",
    )


class TestSelector(unittest.TestCase):
    def setUp(self):
        self.policy = AutonomyPolicy()

    def test_picks_smallest_eligible_description(self):
        small = make_task("A-1", description_len=100)
        big = make_task("A-2", description_len=500)
        result = select_task([big, small], self.policy)
        self.assertEqual(result.picked.key, "A-1")

    def test_ineligible_candidates_are_skipped(self):
        ineligible = make_task("A-1", priority="High")
        eligible = make_task("A-2")
        result = select_task([ineligible, eligible], self.policy)
        self.assertEqual(result.picked.key, "A-2")

    def test_no_eligible_candidates_returns_none(self):
        ineligible = make_task("A-1", priority="High")
        result = select_task([ineligible], self.policy)
        self.assertIsNone(result.picked)

    def test_existing_pr_excludes_candidate(self):
        task = make_task("A-1")
        result = select_task([task], self.policy, has_existing_pr=lambda key: key == "A-1")
        self.assertIsNone(result.picked)

    def test_fewer_enumerated_requirements_wins_even_if_description_is_shorter_elsewhere(self):
        # Regression test for a real selection the live run got wrong: a
        # short paraphrase with 5 bullet requirements must NOT beat a longer
        # single-requirement description just because it has fewer raw chars.
        many_requirements = make_task("A-1", description_len=1)
        many_requirements.description = (
            "Fix search.\n"
            "* Return matching personnel.\n"
            "* Return matching projects.\n"
            "* Display only relevant allocations.\n"
            "* Exclude unrelated results.\n"
            "* Maintain accuracy across filters.\n"
        )
        one_requirement = make_task("A-2", description_len=1)
        one_requirement.description = (
            "As a user I want allocation labels to render correctly while scrolling so that "
            "personnel and project details are not obscured. Requirement: allocation bars and "
            "labels should remain confined to the grid area and never overlap the frozen panel."
        )
        result = select_task([many_requirements, one_requirement], self.policy)
        self.assertEqual(result.picked.key, "A-2")

    def test_evaluate_candidates_reports_all_including_losers(self):
        small = make_task("A-1", description_len=100)
        big = make_task("A-2", description_len=500)
        evaluations = evaluate_candidates([small, big], self.policy)
        self.assertEqual(len(evaluations), 2)
        self.assertTrue(all(e.eligible for e in evaluations))

    def test_duplicate_marks_excluded_duplicate_flag(self):
        task = make_task("A-1")
        evaluations = evaluate_candidates([task], self.policy, has_existing_pr=lambda key: True)
        self.assertFalse(evaluations[0].eligible)
        self.assertTrue(evaluations[0].excluded_duplicate)


if __name__ == "__main__":
    unittest.main()

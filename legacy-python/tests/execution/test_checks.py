import unittest

from work_agent.execution.checks import run_checks


class TestRunChecks(unittest.TestCase):
    def test_passing_and_failing_commands(self):
        commands = [("ok", ["true"]), ("bad", ["false"])]
        results = run_checks(".", commands=commands, timeout=10)
        by_name = {r.name: r for r in results}
        self.assertTrue(by_name["ok"].passed)
        self.assertFalse(by_name["bad"].passed)

    def test_output_captured(self):
        commands = [("echoer", ["python3", "-c", "print('hello-from-check')"])]
        results = run_checks(".", commands=commands, timeout=10)
        self.assertIn("hello-from-check", results[0].output)


if __name__ == "__main__":
    unittest.main()

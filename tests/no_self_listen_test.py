import importlib.util
from pathlib import Path
import unittest

spec = importlib.util.spec_from_file_location('check', Path(__file__).resolve().parents[1] / 'scripts/check-no-self-listen.py')
check = importlib.util.module_from_spec(spec)
spec.loader.exec_module(check)


class SelfListenTest(unittest.TestCase):
    def test_self_listener(self):
        self.assertTrue(check.self_listens('name: Gate\non:\n  workflow_run:\n    workflows: [Other, Gate]\n'))

    def test_companion(self):
        self.assertFalse(check.self_listens('name: Gate Cancel Heal\non:\n  workflow_run:\n    workflows: [Gate]\n'))

    def test_other_triggers(self):
        self.assertFalse(check.self_listens('name: Gate\non: [push, pull_request]\n'))

    def test_repo(self):
        self.assertFalse(check.main())


if __name__ == '__main__':
    unittest.main()

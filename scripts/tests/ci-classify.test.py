import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('classifier', Path(__file__).parents[1] / 'ci-classify.py')
assert spec is not None and spec.loader is not None
classifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(classifier)


class ClassificationTests(unittest.TestCase):
    def test_documentation_and_instructions(self) -> None:
        self.assertFalse(classifier.classify(['docs/guide.md', 'AGENTS.md', '.agents/skills/example/SKILL.md', '.codex/prompts/example.md']))

    def test_executable_mixed_and_configuration_changes(self) -> None:
        for path in ['.agents/skills/example/run.sh', '.codex/agents/reviewer.toml', '.codex/scripts/example.sh', 'apps/frontend/README.md', '.github/workflows/ci.yml']:
            with self.subTest(path=path):
                self.assertTrue(classifier.classify(['.agents/roles/reviewer.md', path]))

    def test_empty_unknown_and_special_files(self) -> None:
        self.assertTrue(classifier.classify([]))
        self.assertTrue(classifier.classify(['.agents/role.md'], {'.agents/role.md'}))
        self.assertTrue(classifier.classify_range('', 'head'))
        with patch.object(classifier, 'git', side_effect=subprocess.CalledProcessError(1, 'git')):
            self.assertTrue(classifier.classify_range('base', 'head'))

    def test_agent_check_cannot_be_silently_skipped(self) -> None:
        workflow = (Path(__file__).parents[2] / '.github/workflows/ci.yml').read_text()
        repo_checks = workflow.split('\n  repo-checks:\n', 1)[1].split('\n  lint:\n', 1)[0]
        complete = workflow.split('\n  ci-complete:\n', 1)[1]
        # Repo Checks runs on every diff (no job-level condition) and CI
        # Complete requires it, so the agent check cannot be skipped.
        self.assertNotIn('\n    if:', repo_checks)
        self.assertIn('python3 scripts/check-agent-instructions.py', repo_checks)
        self.assertIn('REPO_CHECKS_RESULT: ${{ needs.repo-checks.result }}', complete)
        self.assertIn('require repo-checks "$REPO_CHECKS_RESULT"', complete)
        self.assertIn('bun scripts/ci-cancellation-policy.ts', complete)

    def test_nul_delimiters_modes_and_rename_detection(self) -> None:
        # A renamed executable must still be included through its old path.
        outputs = [b'', b'', b'old.sh\0.agents/new.md\0', b'100755 blob abc\told.sh\0', b'100644 blob def\t.agents/new.md\0']
        with patch.object(classifier, 'git', side_effect=outputs) as git:
            self.assertTrue(classifier.classify_range('base', 'head'))
            self.assertIn(unittest.mock.call('diff', '--name-only', '--no-renames', '-z', 'base', 'head'), git.call_args_list)
        outputs = [b'', b'', b'.agents/name\nwith newline.md\0', b'', b'100644 blob abc\t.agents/name\nwith newline.md\0']
        with patch.object(classifier, 'git', side_effect=outputs):
            self.assertFalse(classifier.classify_range('base', 'head'))


if __name__ == '__main__':
    unittest.main()

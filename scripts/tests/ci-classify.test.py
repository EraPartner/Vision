import importlib.util
from pathlib import Path
import subprocess
import unittest
from unittest.mock import patch

spec = importlib.util.spec_from_file_location('classifier', Path(__file__).parents[1] / 'ci-classify.py')
classifier = importlib.util.module_from_spec(spec)
spec.loader.exec_module(classifier)


class ClassificationTests(unittest.TestCase):
    def test_documentation_and_instructions(self):
        self.assertFalse(classifier.classify(['docs/guide.md', 'AGENTS.md', '.agents/skills/example/SKILL.md', '.codex/cloud/README.md']))

    def test_executable_mixed_and_configuration_changes(self):
        for path in ['.agents/skills/example/run.sh', '.codex/agents/reviewer.toml', '.codex/cloud/setup.sh', 'apps/frontend/README.md', '.github/workflows/ci.yml']:
            with self.subTest(path=path):
                self.assertTrue(classifier.classify(['.agents/roles/reviewer.md', path]))

    def test_empty_unknown_and_special_files(self):
        self.assertTrue(classifier.classify([]))
        self.assertTrue(classifier.classify(['.agents/role.md'], {'.agents/role.md'}))
        self.assertTrue(classifier.classify_range('', 'head'))
        with patch.object(classifier, 'git', side_effect=subprocess.CalledProcessError(1, 'git')):
            self.assertTrue(classifier.classify_range('base', 'head'))

    def test_cloud_check_cannot_be_silently_skipped(self):
        workflow = (Path(__file__).parents[2] / '.github/workflows/ci.yml').read_text()
        quality = workflow.split('  quality-gate:', 1)[1].split('  build-image:', 1)[0]
        self.assertIn('      - cloud-tooling', quality)
        self.assertIn('CLOUD_TOOLING_RESULT: ${{ needs.cloud-tooling.result }}', quality)
        self.assertIn('case "$CLOUD_TOOLING_RESULT" in', quality)
        self.assertIn('success|cancelled)', quality)
        self.assertIn('node scripts/ci-cancellation-policy.js', quality)

    def test_nul_delimiters_modes_and_rename_detection(self):
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

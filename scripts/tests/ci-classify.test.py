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
        quality = workflow.split('  quality-gate:', 1)[1].split('  build-image:', 1)[0]
        self.assertIn('      - agent-tooling', quality)
        self.assertIn('AGENT_TOOLING_RESULT: ${{ needs.agent-tooling.result }}', quality)
        self.assertIn('case "$AGENT_TOOLING_RESULT" in', quality)
        self.assertIn('success|cancelled)', quality)
        self.assertIn('bun scripts/ci-cancellation-policy.ts', quality)

    def test_nul_delimiters_modes_and_rename_detection(self) -> None:
        # A renamed executable must still be included through its old path.
        outputs = [b'', b'', b'old.sh\0.agents/new.md\0', b'100755 blob abc\told.sh\0', b'100644 blob def\t.agents/new.md\0']
        with patch.object(classifier, 'git', side_effect=outputs) as git:
            self.assertTrue(classifier.classify_range('base', 'head'))
            self.assertIn(unittest.mock.call('diff', '--name-only', '--no-renames', '-z', 'base', 'head'), git.call_args_list)
        outputs = [b'', b'', b'.agents/name\nwith newline.md\0', b'', b'100644 blob abc\t.agents/name\nwith newline.md\0']
        with patch.object(classifier, 'git', side_effect=outputs):
            self.assertFalse(classifier.classify_range('base', 'head'))

    def test_native_paths(self) -> None:
        for paths in (
            ['apps/native/Package.swift'],
            ['docs/a.md', 'install-native.sh'],
            ['.github/workflows/ci.yml'],
            ['packaging/electron/backup/bundle.ts'],
            ['packaging/electron/audit-anchor.ts'],
            ['packaging/electron/build.ts'],
            ['packaging/electron/package.json'],
            ['packaging/electron/bun.lock'],
            ['packaging/electron/tsconfig.base.json'],
            ['packaging/electron/tsconfig.json'],
            ['packaging/electron/tsconfig.preload.json'],
            [],
        ):
            with self.subTest(paths=paths):
                self.assertTrue(classifier.classify_native(paths))
        for paths in (
            ['apps/frontend/src/App.tsx', 'docs/a.md'],
            ['apps/nativeish/x.swift'],
            ['install.sh'],
            ['packaging/electron/main.ts'],
            ['packaging/electron/tsconfig.other.json'],
        ):
            with self.subTest(paths=paths):
                self.assertFalse(classifier.classify_native(paths))

    def test_native_range_fails_closed_and_runs_on_push(self) -> None:
        self.assertTrue(classifier.classify_native_range('', 'head'))
        self.assertTrue(classifier.classify_native_range('0' * 40, 'head'))
        with patch.object(classifier, 'git', side_effect=subprocess.CalledProcessError(1, 'git')):
            self.assertTrue(classifier.classify_native_range('base', 'head'))
        with patch.object(classifier, 'git', side_effect=[b'', b'', b'apps/frontend/x.ts\0']):
            self.assertFalse(classifier.classify_native_range('base', 'head'))
        with patch.object(classifier, 'classify_range', return_value=True), patch.object(classifier, 'classify_native_range', return_value=False):
            self.assertEqual(classifier.classify_event('push', 'base', 'head'), (True, True))
            self.assertEqual(classifier.classify_event('pull_request', 'base', 'head'), (True, False))

    def test_native_job_gates_quality_without_joining_ci_complete(self) -> None:
        workflow = (Path(__file__).parents[2] / '.github/workflows/ci.yml').read_text()
        changes = workflow.split('  changes:', 1)[1].split('  commitlint:', 1)[0]
        self.assertIn('native: ${{ steps.classify.outputs.native }}', changes)
        native = workflow.split('  native-macos:', 1)[1].split('\n  # ', 1)[0]
        self.assertIn("if: needs.changes.outputs.native == 'true'", native)
        self.assertIn('runs-on: macos-26', native)
        interop = workflow.split('  native-interop:', 1)[1].split('\n  # ', 1)[0]
        self.assertIn('needs: [changes, native-macos]', interop)
        self.assertIn("if: needs.changes.outputs.native == 'true'", interop)
        quality = workflow.split('  quality-gate:', 1)[1].split('    if:', 1)[0]
        self.assertIn('      - native-macos', quality)
        self.assertIn('      - native-interop', quality)
        complete = workflow.split('  ci-complete:', 1)[1].split('    if:', 1)[0]
        self.assertNotIn('native-macos', complete)
        self.assertNotIn('native-interop', complete)


if __name__ == '__main__':
    unittest.main()

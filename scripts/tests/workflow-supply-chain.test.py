"""Adversarial checks for the workflow admission policy."""

import importlib.util
import tempfile
import unittest
from pathlib import Path


SPEC = importlib.util.spec_from_file_location(
    "workflow_policy",
    Path(__file__).resolve().parents[1] / "check-workflow-supply-chain.py",
)
POLICY = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(POLICY)


class WorkflowSupplyChainTests(unittest.TestCase):
    def test_missing_checkout_credential_policy_fails(self):
        workflow = "steps:\n  - uses: actions/checkout@" + "a" * 40 + "\n"
        self.assertIn(
            "persisted credentials", " ".join(POLICY.check_workflow(workflow, "x"))
        )

    def test_mutable_action_ref_fails(self):
        self.assertIn(
            "full SHA",
            " ".join(POLICY.check_workflow("- uses: actions/checkout@v4", "x")),
        )

    def test_dynamic_tool_download_fails(self):
        self.assertIn("bunx", " ".join(POLICY.check_workflow("run: bunx tsc", "x")))

    def test_external_checkout_requires_immutable_ref(self):
        workflow = (
            "steps:\n  - uses: actions/checkout@"
            + "a" * 40
            + "\n    with:\n      repository: EraPartner/Lockbox\n"
            + "      ref: main\n      persist-credentials: false\n"
        )
        self.assertIn("full SHA ref", " ".join(POLICY.check_workflow(workflow, "x")))

    def test_pinned_checkout_without_credentials_passes(self):
        workflow = (
            "steps:\n  - uses: actions/checkout@"
            + "a" * 40
            + "\n    with:\n      persist-credentials: false\n"
        )
        self.assertEqual(POLICY.check_workflow(workflow, "x"), [])

    def test_checkout_env_cannot_pose_as_with_input(self):
        workflow = (
            "steps:\n  - uses: actions/checkout@"
            + "a" * 40
            + "\n    env:\n      persist-credentials: false\n"
        )
        self.assertIn(
            "persisted credentials", " ".join(POLICY.check_workflow(workflow, "x"))
        )

    def test_discovers_yaml_alternates(self):
        with tempfile.TemporaryDirectory() as directory:
            root = Path(directory)
            (root / ".github/workflows").mkdir(parents=True)
            (root / ".github/actions/example").mkdir(parents=True)
            (root / ".github/workflows/check.yaml").write_text("name: Check\n")
            (root / ".github/actions/example/action.yaml").write_text("name: Example\n")
            names = {path.name for path in POLICY.discover_actions(root)}
            self.assertEqual(names, {"check.yaml", "action.yaml"})


if __name__ == "__main__":
    unittest.main()

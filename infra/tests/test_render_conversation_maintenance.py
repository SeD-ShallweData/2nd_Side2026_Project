import subprocess
import sys
import tempfile
import unittest
from pathlib import Path


SCRIPT = Path(__file__).resolve().parents[1] / "scripts" / "render-conversation-maintenance.py"


class RenderConversationMaintenanceTests(unittest.TestCase):
    def test_renders_separate_units_without_secrets(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--project-root", "/srv/moneyworry/repo",
                 "--web-user", "moneyworry_web", "--web-group", "moneyworry_web",
                 "--node-bin", "/usr/bin/node", "--worker-env-file",
                 "/etc/moneyworry/conversation-worker.env", "--output-dir", directory],
                text=True, capture_output=True, check=True,
            )
            self.assertEqual(len(result.stdout.splitlines()), 2)
            service = (Path(directory) / "moneyworry-conversation-maintenance.service").read_text()
            timer = (Path(directory) / "moneyworry-conversation-maintenance.timer").read_text()
            self.assertIn("ExecStart=/usr/bin/node /srv/moneyworry/repo/product/.runtime/conversation-worker.mjs", service)
            self.assertIn("EnvironmentFile=/etc/moneyworry/conversation-worker.env", service)
            self.assertIn("OnUnitActiveSec=30min", timer)
            self.assertNotIn("@PROJECT_ROOT@", service)

    def test_rejects_unsafe_unit_values(self):
        with tempfile.TemporaryDirectory() as directory:
            result = subprocess.run(
                [sys.executable, str(SCRIPT), "--project-root", "/srv/x;echo bad",
                 "--web-user", "web", "--web-group", "web", "--node-bin", "/usr/bin/node",
                 "--worker-env-file", "/etc/moneyworry/worker.env", "--output-dir", directory],
                text=True, capture_output=True,
            )
            self.assertNotEqual(result.returncode, 0)
            self.assertEqual(list(Path(directory).iterdir()), [])


if __name__ == "__main__":
    unittest.main()

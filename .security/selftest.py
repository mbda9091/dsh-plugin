"""Verify real scanner behavior with synthetic Git objects in a private directory."""

import contextlib
import io
import json
from pathlib import Path
import subprocess
import tempfile

from pii import make_recognizers
from scan import SECURITY, scan_snapshot


def main():
    policy = json.loads((SECURITY / "policy.json").read_text())
    recognizers = make_recognizers(policy)
    with tempfile.TemporaryDirectory(prefix="repo-security-health-") as directory:
        root = Path(directory)
        subprocess.run(["git", "init", "-q", str(root)], check=True, capture_output=True)
        sample = root / "sample.py"
        sample.write_text("print('safe')\n")
        subprocess.run(["git", "-C", str(root), "add", "sample.py"], check=True)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            count = scan_snapshot(root, None, policy, recognizers)
        if count != 0:
            raise RuntimeError("Scanner self-test unexpectedly rejected a clean sample")
        token = "ghp_" + "aB3dE5fG7hJ9kL2mN4pQ6rS8tU0vW1xY3zA5"
        phone = "139" + "12345678"
        sample.write_text(f'token = "{token}"\nphone = "{phone}"\nresult = eval(user_input)  # nosemgrep\n')
        (root / ".semgrepignore").write_text("sample.py\n")
        subprocess.run(["git", "-C", str(root), "add", "sample.py", ".semgrepignore"], check=True)
        output = io.StringIO()
        with contextlib.redirect_stdout(output):
            count = scan_snapshot(root, None, policy, recognizers)
        report = output.getvalue()
        if count < 3 or not all(name + ":" in report for name in ("Gitleaks", "Semgrep", "Presidio")):
            raise RuntimeError("Scanner self-test did not detect all three sample categories")
        if token in report or phone in report or "eval(user_input)" in report:
            raise RuntimeError("Scanner self-test detected unredacted output")
    print("PASS: clean sample and Gitleaks/Semgrep/Presidio detection; output redacted.", flush=True)


if __name__ == "__main__":
    main()

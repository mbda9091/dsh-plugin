#!/usr/bin/env python3
"""Rebuild repository-local scanners without the global repo-security CLI."""

import argparse
from pathlib import Path
import subprocess
import sys
import tarfile

# Direct Python invocation must remain read-only until Git's version gate passes.
sys.dont_write_bytecode = True

from manage import RepoSecurityError, hook_config, standalone_main


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--install-hooks", action="store_true")
    args = parser.parse_args()
    standalone_main(Path(__file__).resolve().parent, install_hooks=args.install_hooks)
    print("Tools verified." + (" Repository-local hooks enabled." if args.install_hooks else " Hooks unchanged."))
    print("Pre-commit order: " + hook_config.hook_order(Path(__file__).resolve().parent.parent))


if __name__ == "__main__":
    try:
        main()
    except (OSError, ValueError, RepoSecurityError, subprocess.SubprocessError, tarfile.TarError) as error:
        print(f"Security installation failed: {error}. Inspect incomplete state and rerun setup.", file=sys.stderr)
        sys.exit(2)

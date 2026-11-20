#!/usr/bin/env python3
"""Scan Git object snapshots without checking out or executing project code."""

import argparse
import fnmatch
import json
import os
from pathlib import Path, PurePosixPath
import re
import subprocess
import sys
import tempfile

SECURITY = Path(__file__).resolve().parent


def git_environment():
    env = dict(os.environ)
    # Git exports GIT_DIR for linked-worktree hooks. With -C .security it can
    # make Git treat that directory as the worktree root. Target this checkout
    # explicitly while retaining the commit-specific GIT_INDEX_FILE.
    for name in ("GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR"):
        env.pop(name, None)
    return env


def git(root, *args):
    result = subprocess.run(
        ["git", "-C", str(root), *args], capture_output=True, env=git_environment()
    )
    if result.returncode:
        raise RuntimeError("Git command failed: " + args[0])
    return result.stdout


def entries(root, revision=None):
    if revision is None:
        records = git(root, "ls-files", "--stage", "-z")
    else:
        records = git(root, "ls-tree", "-rz", revision)
    for record in records.split(b"\0"):
        if not record:
            continue
        metadata, path_bytes = record.split(b"\t", 1)
        mode, middle, last = metadata.decode().split()
        if revision is None:
            oid, stage = middle, last
            if stage != "0":
                raise RuntimeError("Resolve index conflicts before scanning")
        else:
            oid = last
        path = path_bytes.decode("utf-8")
        relative = PurePosixPath(path)
        if relative.is_absolute() or ".." in relative.parts or ".git" in relative.parts:
            raise RuntimeError("Unsafe Git path")
        if mode == "160000":
            raise RuntimeError("Submodules need a separate security scan: " + path)
        yield path, oid


def policy_excludes(path, policy):
    return (
        path.startswith((".security/.venv/", ".security/bin/"))
        or any(fnmatch.fnmatchcase(path, pattern) for pattern in policy["excluded_paths"])
    )

def decode_text(data):
    if data.startswith((b"\xff\xfe", b"\xfe\xff")):
        return data.decode("utf-16")
    if b"\0" in data:
        return None
    try:
        return data.decode("utf-8-sig")
    except UnicodeDecodeError:
        return None


def tool_findings(command, report, name, root, env):
    try:
        result = subprocess.run(
            command, cwd=root, env=env, capture_output=True,
            stdin=subprocess.DEVNULL, timeout=60,
        )
    except subprocess.TimeoutExpired:
        raise RuntimeError(name + " exceeded the 60-second limit; scan blocked") from None
    # Do not forward stdout/stderr: scanners can include source code and secrets.
    if result.returncode not in (0, 1):
        raise RuntimeError(name + " failed; no clean result can be claimed")
    try:
        data = json.loads(report.read_text() if report else result.stdout)
    except (ValueError, OSError):
        raise RuntimeError(name + " did not produce a valid report") from None
    if name == "Semgrep":
        if data.get("errors"):
            raise RuntimeError("Semgrep reported parsing/scanning errors; scan blocked")
        findings = data.get("results", [])
        for item in findings:
            path = Path(item["path"])
            if path.is_absolute():
                path = path.relative_to(root)
            print(f"  Semgrep: {path}:{item['start']['line']} [{item['check_id']}]", flush=True)
    else:
        findings = data or []
        for item in findings:
            path = Path(item["File"])
            if path.is_absolute():
                path = path.relative_to(root)
            print(f"  Gitleaks: {path}:{item['StartLine']} [{item['RuleID']}]", flush=True)
    if result.returncode == 1 and not findings:
        raise RuntimeError(name + " returned failure without findings")
    return len(findings)


def scan_snapshot(root, revision, policy, recognizers):
    from pii import detect

    gitleaks = SECURITY / "bin/gitleaks"
    semgrep = Path(sys.executable).parent / "semgrep"
    if not gitleaks.is_file() or not semgrep.is_file():
        raise RuntimeError("Security tools missing; run python3 .security/setup.py")
    findings = 0
    skipped = []
    count = 0
    with tempfile.TemporaryDirectory(prefix="code-security-") as temp:
        scratch = Path(temp)
        snapshot = scratch / "source"
        snapshot.mkdir()
        for path, oid in entries(root, revision):
            if policy_excludes(path, policy):
                continue
            size = int(git(root, "cat-file", "-s", oid))
            if size > policy["max_file_bytes"]:
                raise RuntimeError("File exceeds scan size limit: " + path)
            data = git(root, "cat-file", "blob", oid)
            text = decode_text(data)
            target = snapshot / path
            target.parent.mkdir(parents=True, exist_ok=True)
            # Symlinks are written as plain target-path text, never followed.
            target.write_bytes(data if text is None else text.encode("utf-8"))
            count += 1
            if text is None:
                skipped.append(path)
                continue
            for line, entity in detect(text, recognizers, policy, path=path):
                print(f"  Presidio: {path}:{line} [{entity}]", flush=True)
                findings += 1
        env = dict(os.environ)
        env.update(SEMGREP_SEND_METRICS="off", SEMGREP_ENABLE_VERSION_CHECK="0")
        env["SEMGREP_SETTINGS_FILE"] = str(scratch / "settings.yaml")
        env["SEMGREP_LOG_FILE"] = str(scratch / "semgrep.log")
        # Ignore ambient account/remote rule configuration; all rules are local.
        env.pop("SEMGREP_APP_TOKEN", None)
        for key in ("GITLEAKS_CONFIG", "GITLEAKS_CONFIG_TOML"):
            env.pop(key, None)
        # Repository-controlled .gitleaksignore must not suppress snapshot findings.
        ignore = scratch / "gitleaksignore"
        ignore.write_text("")
        source_ignore = snapshot / ".gitleaksignore"
        ignore_content = source_ignore.read_bytes() if source_ignore.is_file() else None
        targets = ["."]
        if ignore_content is not None:
            # Gitleaks also loads source/.gitleaksignore despite the explicit flag.
            # Neutralize it for the directory scan, then scan its original bytes as a file.
            source_ignore.write_bytes(b"")
            targets.append(".gitleaksignore")
        for index, target in enumerate(targets):
            if target == ".gitleaksignore":
                source_ignore.write_bytes(ignore_content)
            report = scratch / f"gitleaks-{index}.json"
            findings += tool_findings([
                str(gitleaks), "dir", target, "--config", str(SECURITY / "gitleaks.toml"),
                "--gitleaks-ignore-path", str(ignore),
                "--redact", "--ignore-gitleaks-allow", "--report-format", "json",
                "--report-path", str(report), "--exit-code", "1", "--no-banner",
            ], report, "Gitleaks", snapshot, env)
        findings += tool_findings([
            str(semgrep), "scan", "--config", str(SECURITY / "semgrep.yml"),
            "--metrics=off", "--disable-version-check", "--strict", "--json", "--quiet",
            "--error", "--no-git-ignore", "--disable-nosem", "--max-target-bytes", "0",
            "--x-ignore-semgrepignore-files", "--jobs", "2", str(snapshot),
        ], None, "Semgrep", snapshot, env)
        print(f"  Scanned {count} files; {findings} findings; {len(skipped)} binary/non-UTF files without PII coverage.", flush=True)
        for path in skipped:
            print(f"  PII coverage gap (review manually): {path}", flush=True)
    return findings


def push_commits(root, stream):
    commits = set()
    seen_line = False
    for line in stream:
        seen_line = True
        fields = line.split()
        if len(fields) != 4:
            raise RuntimeError("Invalid pre-push input")
        _, local, _, remote = fields
        if not all(re.fullmatch(r"[0-9a-fA-F]{40}|[0-9a-fA-F]{64}", x) for x in (local, remote)):
            raise RuntimeError("Invalid pre-push object IDs")
        if set(local) == {"0"}:
            continue  # Deleting a remote ref introduces no code.
        # Peeling also supports lightweight and annotated tags that point to commits.
        tip = git(root, "rev-parse", "--verify", local + "^{commit}").decode().strip()
        args = ["rev-list", tip]
        if set(remote) != {"0"}:
            exists = subprocess.run(["git", "-C", str(root), "cat-file", "-e", remote + "^{commit}"], capture_output=True, env=git_environment())
            if exists.returncode == 0:
                args += ["--not", remote]
        commits.update(git(root, *args).decode().splitlines())
    if not seen_line:
        print("No refs supplied by Git; nothing to push.", flush=True)
    return sorted(commits)


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("mode", choices=["staged", "head", "history", "pre-push"])
    parser.add_argument("--require-ready", action="store_true", help="Reject unready commit hooks.")
    args = parser.parse_args()
    root = Path(git(SECURITY, "rev-parse", "--show-toplevel").decode().strip())
    if args.require_ready:
        from manage import RepoSecurityError, require_commit_ready
        try:
            require_commit_ready(root)
        except RepoSecurityError as error:
            raise RuntimeError(str(error)) from None
    if git(root, "rev-parse", "--is-shallow-repository").decode().strip() == "true":
        print("COVERAGE WARNING: shallow clone; local objects do not cover complete remote history.", file=sys.stderr)
    policy = json.loads((SECURITY / "policy.json").read_text())
    from pii import make_recognizers
    recognizers = make_recognizers(policy)
    if args.mode == "staged":
        revisions = [None]
    elif args.mode == "head":
        revisions = [git(root, "rev-parse", "--verify", "HEAD").decode().strip()]
    elif args.mode == "history":
        revisions = git(root, "rev-list", "--all").decode().splitlines()
    else:
        revisions = push_commits(root, sys.stdin)
    # Identical trees can share a scan, including commits reached by several refs.
    trees = set()
    total = 0
    for revision in revisions:
        tree = git(root, "write-tree").decode().strip() if revision is None else git(root, "rev-parse", revision + "^{tree}").decode().strip()
        if tree in trees:
            continue
        trees.add(tree)
        print("Checking " + (revision[:12] if revision else "staged snapshot"), flush=True)
        total += scan_snapshot(root, revision, policy, recognizers)
    print(f"{'BLOCKED' if total else 'PASS'}: {len(trees)} unique snapshots, {total} findings.", flush=True)
    return 1 if total else 0


if __name__ == "__main__":
    try:
        sys.exit(main())
    except (RuntimeError, OSError, ValueError, ImportError, KeyError, TypeError, AttributeError) as error:
        print(f"BLOCKED: {error}", file=sys.stderr)
        sys.exit(2)

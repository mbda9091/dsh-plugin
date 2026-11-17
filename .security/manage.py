"""Standalone installation engine, also imported by the CLI; stdlib only."""

from __future__ import annotations

import contextlib
import hashlib
import io
import json
import os
import platform
import shutil
import stat
import subprocess
import tarfile
import tempfile
import urllib.request
from dataclasses import dataclass, replace
from importlib.metadata import PackageNotFoundError, version
from pathlib import Path, PurePosixPath
from typing import TYPE_CHECKING, Any, NotRequired, TypedDict, cast

if TYPE_CHECKING:
    from collections.abc import Generator, Sequence

TEMPLATE_VERSION = "0.2.0"
GITLEAKS_VERSION = "8.30.1"
SCANNER_VERSIONS = {"semgrep": "1.185.0", "presidio-analyzer": "2.2.366"}
CHECKSUMS = {
    ("Linux", "x86_64"): "551f6fc83ea457d62a0d98237cbad105af8d557003051f41f3e7ca7b3f2470eb",
    ("Linux", "aarch64"): "e4a487ee7ccd7d3a7f7ec08657610aa3606637dab924210b3aee62570fb4b080",
    ("Darwin", "x86_64"): "dfe101a4db2255fc85120ac7f3d25e4342c3c20cf749f2c20a18081af1952709",
    ("Darwin", "arm64"): "b40ab0ae55c505963e365f271a8d3846efbc170aa17f2607f13df610a9aeb6a5",
}
MANIFEST = ".security/install-manifest.json"
WORKFLOW = ".github/workflows/repo-security.yml"
HOOKS_PATH = ".security/hooks"
HOOK_ENTRY = ".git/hooks/pre-commit"
HOOK_LINK = ".git/hooks/pre-commit.d/10-security"
HOOK_TARGET = "../../../.security/hooks/pre-commit"
BACKUPS = ".git/repo-security-backups"
LEGACY_PUSH = ".security/hooks/pre-push"
LEGACY_DISPATCHERS = {
    "c5cc92e515c9de67bc5dc93d9db3faa3213ddc4e3dc7ea1e147fa9f2f142da6b",
    "192f87feb69f2ffdf8194830284b46ceb8d9dd1692e32742fe03745c93d5cb59",
}
LEGACY_PUSH_DIGESTS = {"794c853e72ee45d2961c90e175db1c9d69b06b84cd07744a05ba296d9aa3c6bc"}
HOOK_DISPATCHER = b"""#!/bin/sh
# Add independent executable checks to .git/hooks/pre-commit.d/.
set -eu
repo_root=$(git rev-parse --show-toplevel)
if [ -e "$repo_root/.git/repo-security-setup.lock" ] ||
    [ -L "$repo_root/.git/repo-security-setup.lock" ]; then
    echo 'Security setup is running or interrupted; finish setup before committing.' >&2
    exit 2
fi
hook_dir="$repo_root/.git/hooks/pre-commit.d"
if [ ! -f "$hook_dir/10-security" ] || [ ! -x "$hook_dir/10-security" ]; then
    echo 'Security pre-commit check is missing or not executable; rerun setup.' >&2
    exit 2
fi
for hook in "$hook_dir"/*; do
    if [ "$hook" = "$hook_dir/10-security" ]; then
        continue
    fi
    if [ ! -e "$hook" ] && [ ! -L "$hook" ]; then
        continue
    fi
    if [ ! -f "$hook" ] || [ ! -x "$hook" ]; then
        echo "Pre-commit check is not an executable file: $hook" >&2
        exit 2
    fi
    "$hook" "$@"
done
exec "$hook_dir/10-security" "$@"
"""
IGNORE_ENTRIES = (
    "/.security/.venv/",
    "/.security/bin/",
    "/.security/__pycache__/",
    "/.security/install-manifest.json",
)
RUNTIME_NAMES = (
    "setup.sh",
    "setup.py",
    "manage.py",
    "scan.py",
    "pii.py",
    "selftest.py",
    "run",
    "pyproject.toml",
    "uv.lock",
    "gitleaks.toml",
    "semgrep.yml",
    "policy.json",
    "hooks/pre-commit",
)
CUSTOMIZABLE = {".security/gitleaks.toml", ".security/semgrep.yml", ".security/policy.json"}


class RepoSecurityError(Exception):
    pass


class FileRecord(TypedDict):
    template_sha256: str
    installed_sha256: str
    executable: bool


class InstallRecord(TypedDict):
    schema_version: int
    template_version: str
    status: str
    phase: str
    files: dict[str, FileRecord]
    original_local_hooks: list[str]
    gitleaks: dict[str, str]
    migration_backup: NotRequired[str]


@dataclass(frozen=True)
class TemplateFile:
    destination: str
    content: bytes
    executable: bool
    template_sha256: str | None = None

    @property
    def digest(self) -> str:
        return hashlib.sha256(self.content).hexdigest()


@dataclass(frozen=True)
class HooksState:
    local: tuple[str, ...]
    effective: str | None
    origin: str | None


@dataclass(frozen=True)
class InstallPlan:
    root: Path
    resources: tuple[TemplateFile, ...]
    hooks: HooksState
    previous: InstallRecord | None
    create: tuple[str, ...]
    keep: tuple[str, ...]
    repair: tuple[str, ...]
    conflicts: tuple[str, ...]
    ignore_before: bytes | None
    ignore_after: bytes
    update: tuple[str, ...]
    remove: tuple[str, ...]
    checkout: bool

    @property
    def upgrade_required(self) -> bool:
        return self.previous is not None and (
            bool(self.update or self.remove)
            or set(self.previous["files"]) != {x.destination for x in self.resources}
            or self.hooks.local == (HOOKS_PATH,)
        )

    def describe(self) -> tuple[str, ...]:
        return (
            f"Repository: {self.root}",
            *(f"ADD {name}" for name in self.create),
            *(f"KEEP {name}" for name in self.keep),
            *(f"CHMOD {name}" for name in self.repair),
            *(f"UPDATE {name}" for name in self.update),
            *(f"REMOVE {name}" for name in self.remove),
            *(f"CONFLICT {reason}" for reason in self.conflicts),
            f"Git hook entry: {HOOK_ENTRY} (dispatcher; preserves independent checks)",
            f"Security check: {HOOK_LINK} -> {HOOK_TARGET} (relative symlink)",
            f"Hooks source: {self.hooks.origin or '(unset)'}",
            "Install/verify: Python 3.13, locked Semgrep/Presidio, SHA-256 checked Gitleaks.",
            "May download into .security and uv's Python/package caches; no business history scan.",
        )


def git(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    env = dict(os.environ)
    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"):
        env.pop(key, None)
    return subprocess.run(  # noqa: S603 -- fixed executable, explicit arguments, no shell
        ["git", "-C", str(root), *args],  # noqa: S607
        capture_output=True,
        text=True,
        env=env,
        check=False,
        timeout=30,
    )


def repository_root(path: Path) -> Path:
    if not path.is_dir():
        msg = "Target must be an existing Git repository directory"
        raise RepoSecurityError(msg)
    result = git(path.resolve(), "rev-parse", "--show-toplevel")
    if result.returncode:
        msg = "Target must be a non-bare Git repository"
        raise RepoSecurityError(msg)
    root = Path(result.stdout.rstrip("\n"))
    if not (root / ".git").is_dir() or (root / ".git").is_symlink():
        msg = "Linked worktrees and submodule checkouts are not supported"
        raise RepoSecurityError(msg)
    return root


def hooks_state(root: Path) -> HooksState:
    local = git(root, "config", "--local", "--get-all", "core.hooksPath")
    effective = git(root, "config", "--show-origin", "--get", "core.hooksPath")
    if local.returncode not in (0, 1) or effective.returncode not in (0, 1):
        msg = "Cannot inspect Git hooks configuration"
        raise RepoSecurityError(msg)
    if effective.returncode == 1:
        return HooksState(tuple(local.stdout.splitlines()), None, None)
    origin, value = effective.stdout.rstrip("\n").split("\t", 1)
    return HooksState(tuple(local.stdout.splitlines()), value, origin)


def path_problem(root: Path, relative: str, *, directory: bool = False) -> str | None:
    parts = PurePosixPath(relative).parts
    if not parts or PurePosixPath(relative).is_absolute() or ".." in parts:
        return f"{relative}: invalid managed path"
    current = root
    for index, part in enumerate(parts):
        current /= part
        if current.is_symlink():
            return f"{relative}: symlink at {current.relative_to(root)}"
        is_directory = index < len(parts) - 1 or directory
        if current.exists() and (current.is_dir() if is_directory else current.is_file()) is False:
            return f"{relative}: unexpected file type at {current.relative_to(root)}"
    return None


def validate_file_records(entries: dict[str, Any], *, legacy: bool = False) -> None:
    allowed = {".security/" + name for name in RUNTIME_NAMES} | {WORKFLOW}
    required = {".security/" + name for name in RUNTIME_NAMES}
    if legacy:
        allowed.add(LEGACY_PUSH)
        required.discard(".security/setup.sh")
    if not required.issubset(entries):
        raise ValueError
    for name, entry in entries.items():
        if name not in allowed:
            raise ValueError
        for key in ("template_sha256", "installed_sha256"):
            value = entry[key]
            if not isinstance(value, str) or len(value) != hashlib.sha256().digest_size * 2:
                raise ValueError
            int(value, 16)
        if not isinstance(entry["executable"], bool):
            raise TypeError


def validate_record(data: dict[str, Any], *, legacy: bool = False) -> InstallRecord:
    if type(data["schema_version"]) is not int or data["schema_version"] != 1:
        raise ValueError
    if data["template_version"] != TEMPLATE_VERSION:
        raise ValueError
    if data["status"] not in ("incomplete", "ready") or not isinstance(data["phase"], str):
        raise ValueError
    if not isinstance(data["files"], dict) or not isinstance(data["gitleaks"], dict):
        raise TypeError
    original = data["original_local_hooks"]
    if not isinstance(original, list) or not all(
        x == HOOKS_PATH for x in cast("list[object]", original)
    ):
        raise ValueError
    validate_file_records(cast("dict[str, Any]", data["files"]), legacy=legacy)
    if "migration_backup" in data:
        backup = data["migration_backup"]
        if (
            not isinstance(backup, str)
            or not backup.startswith(BACKUPS + "/")
            or ".." in PurePosixPath(backup).parts
        ):
            raise ValueError
    if not all(
        isinstance(k, str) and isinstance(v, str)
        for k, v in cast("dict[object, object]", data["gitleaks"]).items()
    ):
        raise TypeError
    return cast("InstallRecord", data)


def read_record(root: Path, *, legacy: bool = False) -> InstallRecord | None:
    problem = path_problem(root, MANIFEST)
    if problem:
        raise RepoSecurityError(problem)
    path = root / MANIFEST
    if not path.exists():
        return None
    try:
        return validate_record(json.loads(path.read_bytes()), legacy=legacy)
    except (ValueError, TypeError, KeyError, AttributeError) as error:
        msg = "Invalid or different-version install manifest; rerun setup for supported migrations"
        raise RepoSecurityError(msg) from error


def hook_link_matches(root: Path) -> bool:
    path = root / HOOK_LINK
    return (
        not path_problem(root, ".git/hooks/pre-commit.d", directory=True)
        and path.is_symlink()
        and str(path.readlink()) == HOOK_TARGET
    )


def hooks_enabled(root: Path, hooks: HooksState) -> bool:
    path = root / HOOK_ENTRY
    return (
        hooks.effective is None
        and not hooks.local
        and hook_link_matches(root)
        and not path_problem(root, HOOK_ENTRY)
        and path.is_file()
        and path.read_bytes() == HOOK_DISPATCHER
        and os.access(path, os.X_OK)
    )


def owned_old_dispatcher(root: Path, previous: InstallRecord | None) -> bool:
    path = root / HOOK_ENTRY
    return (
        previous is not None
        and not path_problem(root, HOOK_ENTRY)
        and path.is_file()
        and hashlib.sha256(path.read_bytes()).hexdigest() in LEGACY_DISPATCHERS
    )


def hook_conflicts(
    root: Path, hooks: HooksState, previous: InstallRecord | None = None
) -> list[str]:
    conflicts: list[str] = []
    if hooks.effective is not None and (
        hooks.effective != HOOKS_PATH or hooks.local != (HOOKS_PATH,)
    ):
        conflicts.append(
            f"core.hooksPath from {hooks.origin}: existing hook manager; "
            "review and migrate existing hooks before enabling the managed pre-commit hook"
        )
    problem = path_problem(root, ".git/hooks/pre-commit.d", directory=True)
    if problem:
        conflicts.append(problem)
    else:
        path = root / HOOK_LINK
        if (path.exists() or path.is_symlink()) and not hook_link_matches(root):
            conflicts.append("Existing security hook member; review it before managed hook setup")
    problem = path_problem(root, HOOK_ENTRY)
    if problem:
        conflicts.append(problem)
    else:
        entry = root / HOOK_ENTRY
        if (
            entry.exists()
            and entry.read_bytes() != HOOK_DISPATCHER
            and not owned_old_dispatcher(root, previous)
        ):
            conflicts.append(
                "Existing pre-commit; review and integrate it before managed hook setup"
            )
    return conflicts


def merged_ignore(original: bytes | None) -> bytes:
    text = (original or b"").decode("utf-8")
    lines = text.splitlines()
    additions = [x for x in IGNORE_ENTRIES if x not in lines and x.lstrip("/") not in lines]
    if not additions:
        return original or b""
    newline = "\r\n" if "\r\n" in text else "\n"
    separator = newline if text and not text.endswith(("\n", "\r")) else ""
    return (text + separator + newline.join(additions) + newline).encode("utf-8")


def tracked_update(root: Path, relative: str) -> bool:
    head = git(root, "rev-parse", "--verify", "HEAD:" + relative)
    actual = git(root, "hash-object", "--no-filters", "--", relative)
    staged = git(root, "diff", "--cached", "--quiet", "HEAD", "--", relative)
    return (
        head.returncode == actual.returncode == staged.returncode == 0
        and head.stdout.strip() == actual.stdout.strip()
    )


def preserve_rules(
    root: Path,
    resources: tuple[TemplateFile, ...],
    previous: InstallRecord | None,
    *,
    checkout: bool,
) -> tuple[TemplateFile, ...]:
    result: list[TemplateFile] = []
    for resource in resources:
        selected = resource
        info = previous["files"].get(resource.destination) if previous else None
        path = root / resource.destination
        if (
            info
            and resource.destination in CUSTOMIZABLE
            and not path_problem(root, resource.destination)
            and path.is_file()
        ):
            content = path.read_bytes()
            if hashlib.sha256(content).hexdigest() == info["installed_sha256"] or tracked_update(
                root, resource.destination
            ):
                selected = replace(
                    resource,
                    content=content,
                    template_sha256=info["template_sha256"] if checkout else resource.digest,
                )
        result.append(selected)
    return tuple(result)


def approved_registration(
    root: Path, resource: TemplateFile, previous: InstallRecord, *, checkout: bool
) -> bool:
    pending = (
        previous["status"] == "incomplete"
        and previous["phase"] == "deploying"
        and "migration_backup" in previous
        and previous["files"][resource.destination]["template_sha256"] == resource.digest
    )
    return not checkout or pending or tracked_update(root, resource.destination)


def plan_resource(  # noqa: PLR0913 -- one shared file decision updates the plan's action lists
    root: Path,
    resource: TemplateFile,
    previous: InstallRecord | None,
    *,
    checkout: bool,
    create: list[str],
    keep: list[str],
    repair: list[str],
    update: list[str],
    conflicts: list[str],
) -> None:
    relative = resource.destination
    problem = path_problem(root, relative)
    if problem:
        conflicts.append(problem)
        return
    target = root / relative
    info = previous["files"].get(relative) if previous else None
    if not target.exists():
        create.append(relative)
        return
    actual = hashlib.sha256(target.read_bytes()).hexdigest()
    if (
        checkout
        and info
        and previous
        and previous["status"] == "incomplete"
        and previous["phase"] == "deploying"
        and "migration_backup" in previous
        and relative not in CUSTOMIZABLE
        and info["template_sha256"] != resource.digest
        and not tracked_update(root, relative)
    ):
        conflicts.append(f"{relative}: interrupted bundled upgrade; rerun repo-security setup")
        return
    if actual != resource.digest:
        if info and actual == info["installed_sha256"] and not checkout:
            update.append(relative)
        else:
            conflicts.append(f"{relative}: custom or different-version content")
            return
    elif info and info["installed_sha256"] != resource.digest:
        if previous and approved_registration(root, resource, previous, checkout=checkout):
            update.append(relative)
        else:
            conflicts.append(
                f"{relative}: differs from recorded installation; commit or restore edits"
            )
            return
    else:
        keep.append(relative)
    if resource.executable and not os.access(target, os.X_OK):
        repair.append(relative)


def make_plan(  # noqa: C901, PLR0912, PLR0915 -- aggregate all conflicts before any writes
    root: Path,
    resources: tuple[TemplateFile, ...],
    *,
    github_actions: bool = False,
    locked: bool = False,
    checkout: bool = False,
) -> InstallPlan:
    conflicts: list[str] = []
    previous = None
    try:
        previous = read_record(root, legacy=True)
    except RepoSecurityError as error:
        conflicts.append(str(error))
    selected = tuple(
        x
        for x in resources
        if x.destination != WORKFLOW
        or github_actions
        or (previous is not None and WORKFLOW in previous["files"])
    )
    selected = preserve_rules(root, selected, previous, checkout=checkout)
    hooks = hooks_state(root)
    conflicts.extend(hook_conflicts(root, hooks, previous))
    update: list[str] = []
    remove: list[str] = []
    if owned_old_dispatcher(root, previous):
        update.append(HOOK_ENTRY)
    legacy_push = root / LEGACY_PUSH
    if legacy_push.exists() or legacy_push.is_symlink():
        info = previous["files"].get(LEGACY_PUSH) if previous else None
        digest = (
            hashlib.sha256(legacy_push.read_bytes()).hexdigest()
            if not path_problem(root, LEGACY_PUSH) and legacy_push.is_file()
            else None
        )
        if info and digest == info["installed_sha256"] and digest in LEGACY_PUSH_DIGESTS:
            remove.append(LEGACY_PUSH)
        else:
            conflicts.append("Legacy pre-push hook is modified or unregistered; review it manually")
    if (platform.system(), platform.machine()) not in CHECKSUMS:
        conflicts.append("Unsupported platform; use Linux/macOS x64/arm64 or WSL")
    if shutil.which("uv") is None:
        conflicts.append("Install uv before setup")
    if not os.access(root, os.W_OK) or not os.access(root / ".git", os.W_OK):
        conflicts.append("Repository and Git directory must be writable")
    if not locked and (
        (root / ".git/repo-security-setup.lock").exists()
        or (root / ".git/repo-security-setup.lock").is_symlink()
    ):
        conflicts.append(
            "Setup lock exists; after confirming no setup is running, "
            "remove .git/repo-security-setup.lock manually"
        )
    create: list[str] = []
    keep: list[str] = []
    repair: list[str] = []
    for resource in selected:
        plan_resource(
            root,
            resource,
            previous,
            checkout=checkout,
            create=create,
            keep=keep,
            repair=repair,
            update=update,
            conflicts=conflicts,
        )
    if previous and (problem := path_problem(root, BACKUPS, directory=True)):
        conflicts.append(problem)
    for relative in (".security/.venv", ".security/bin"):
        problem = path_problem(root, relative, directory=True)
        if problem:
            conflicts.append(problem)
    for relative in (".security/bin/gitleaks", ".gitignore"):
        problem = path_problem(root, relative)
        if problem:
            conflicts.append(problem)
    ignore_before = None
    ignore_after = b""
    if not path_problem(root, ".gitignore"):
        ignore = root / ".gitignore"
        ignore_before = ignore.read_bytes() if ignore.exists() else None
        try:
            ignore_after = merged_ignore(ignore_before)
        except UnicodeDecodeError:
            conflicts.append(".gitignore must be UTF-8 text")
        if ignore_after != ignore_before:
            create.append(".gitignore (merge)")
    return InstallPlan(
        root,
        selected,
        hooks,
        previous,
        tuple(create),
        tuple(keep),
        tuple(repair),
        tuple(conflicts),
        ignore_before,
        ignore_after,
        tuple(update),
        tuple(remove),
        checkout,
    )


@contextlib.contextmanager
def setup_lock(root: Path) -> Generator[None, None, None]:
    path = root / ".git/repo-security-setup.lock"
    try:
        descriptor = os.open(path, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as error:
        msg = "Setup lock exists; do not remove it while another setup is running"
        raise RepoSecurityError(msg) from error
    identity = os.fstat(descriptor)
    try:
        with os.fdopen(descriptor, "w") as stream:
            stream.write(f"pid={os.getpid()}\n")
        yield
    finally:
        current = path.lstat() if path.exists() or path.is_symlink() else None
        if current and (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino):
            path.unlink()


def atomic_write(path: Path, content: bytes, *, mode: int = 0o600) -> None:
    if path.is_symlink():
        raise RepoSecurityError("Refusing to replace symlink: " + path.name)
    if path.exists() and path.read_bytes() == content:
        return
    descriptor, name = tempfile.mkstemp(prefix=".repo-security-", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(content)
        temporary.chmod(mode)
        temporary.replace(path)
    finally:
        temporary.unlink(missing_ok=True)


def save_record(root: Path, record: InstallRecord) -> None:
    problem = path_problem(root, MANIFEST)
    if problem:
        raise RepoSecurityError(problem)
    atomic_write(root / MANIFEST, (json.dumps(record, indent=2, sort_keys=True) + "\n").encode())


def create_resource(path: Path, resource: TemplateFile) -> None:
    descriptor, name = tempfile.mkstemp(prefix=".repo-security-", dir=path.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(resource.content)
        temporary.chmod(0o755 if resource.executable else 0o644)
        os.link(temporary, path)  # Exclusive publication: never overwrite a concurrent file.
    finally:
        temporary.unlink(missing_ok=True)


def record_for(plan: InstallPlan) -> InstallRecord:
    record: InstallRecord = {
        "schema_version": 1,
        "template_version": TEMPLATE_VERSION,
        "status": "incomplete",
        "phase": "deploying",
        "files": {
            x.destination: {
                "template_sha256": x.template_sha256 or x.digest,
                "installed_sha256": x.digest,
                "executable": x.executable,
            }
            for x in plan.resources
        },
        "original_local_hooks": (
            plan.previous["original_local_hooks"] if plan.previous else list(plan.hooks.local)
        ),
        "gitleaks": plan.previous["gitleaks"] if plan.previous else {},
    }
    if plan.previous and "migration_backup" in plan.previous:
        record["migration_backup"] = plan.previous["migration_backup"]
    return record


def backup_migration(plan: InstallPlan) -> str:
    previous = plan.previous
    if previous and previous["status"] == "incomplete" and "migration_backup" in previous:
        relative = previous["migration_backup"]
        if (
            path_problem(plan.root, relative, directory=True)
            or path_problem(plan.root, relative + "/backup.json")
            or not (plan.root / relative / "backup.json").is_file()
        ):
            msg = "Migration backup is missing or linked; restore it before retrying setup"
            raise RepoSecurityError(msg)
        return relative
    parent = plan.root / BACKUPS
    parent.mkdir(mode=0o700, exist_ok=True)
    backup = Path(tempfile.mkdtemp(prefix="upgrade-", dir=parent))
    files: dict[str, dict[str, str | int]] = {}
    for relative in dict.fromkeys((MANIFEST, HOOK_ENTRY, *plan.update, *plan.remove)):
        source = plan.root / relative
        if not source.exists():
            continue
        problem = path_problem(plan.root, relative)
        if problem:
            raise RepoSecurityError(problem)
        content = source.read_bytes()
        destination = backup / "files" / relative
        destination.parent.mkdir(parents=True, exist_ok=True)
        atomic_write(destination, content)
        files[relative] = {
            "sha256": hashlib.sha256(content).hexdigest(),
            "mode": stat.S_IMODE(source.stat().st_mode),
        }
    atomic_write(
        backup / "backup.json",
        json.dumps({"files": files, "local_hooks": plan.hooks.local}, indent=2).encode() + b"\n",
    )
    return str(backup.relative_to(plan.root))


def verify_owned_file(root: Path, relative: str, previous: InstallRecord | None) -> None:
    info = previous["files"].get(relative) if previous else None
    path = root / relative
    if (
        not info
        or path_problem(root, relative)
        or not path.is_file()
        or hashlib.sha256(path.read_bytes()).hexdigest() != info["installed_sha256"]
    ):
        raise RepoSecurityError("Managed file changed during migration: " + relative)


def deploy_resource(plan: InstallPlan, resource: TemplateFile) -> None:
    problem = path_problem(plan.root, resource.destination)
    if problem:
        raise RepoSecurityError(problem)
    path = plan.root / resource.destination
    path.parent.mkdir(parents=True, exist_ok=True)
    if path.exists():
        if path.read_bytes() != resource.content:
            if resource.destination not in plan.update:
                raise RepoSecurityError("File changed during setup: " + resource.destination)
            verify_owned_file(plan.root, resource.destination, plan.previous)
            atomic_write(path, resource.content, mode=stat.S_IMODE(path.stat().st_mode))
    else:
        create_resource(path, resource)
    if resource.executable and not os.access(path, os.X_OK):
        path.chmod(path.stat().st_mode | 0o111)


def deploy(plan: InstallPlan) -> None:
    for resource in plan.resources:
        deploy_resource(plan, resource)
    for relative in plan.remove:
        verify_owned_file(plan.root, relative, plan.previous)
        (plan.root / relative).unlink()
    problem = path_problem(plan.root, ".gitignore")
    if problem:
        raise RepoSecurityError(problem)
    ignore = plan.root / ".gitignore"
    current = ignore.read_bytes() if ignore.exists() else None
    if current != plan.ignore_before:
        msg = ".gitignore changed during setup; preserving external edits"
        raise RepoSecurityError(msg)
    if plan.ignore_after != current:
        atomic_write(
            ignore,
            plan.ignore_after,
            mode=stat.S_IMODE(ignore.stat().st_mode) if ignore.exists() else 0o644,
        )


def run_tool(
    command: Sequence[str], *, cwd: Path, env: dict[str, str] | None = None, timeout: int = 180
) -> str:
    result = subprocess.run(  # noqa: S603 -- explicit argv; never forward potentially sensitive stderr
        command,
        cwd=cwd,
        env=env,
        capture_output=True,
        text=True,
        check=False,
        timeout=timeout,
    )
    if result.returncode:
        msg = f"{Path(command[0]).name} failed (exit {result.returncode}); no clean result claimed"
        raise RepoSecurityError(msg)
    return result.stdout.strip()


def uv_environment() -> dict[str, str]:
    env = dict(os.environ)
    for key in (
        "UV_PROJECT_ENVIRONMENT",
        "VIRTUAL_ENV",
        "UV_WORKING_DIR",
        "UV_PROJECT",
        "UV_PYTHON",
        "PYTHONPATH",
        "PYTHONHOME",
    ):
        env.pop(key, None)
    env["PYTHONDONTWRITEBYTECODE"] = "1"
    return env


def install_gitleaks(security: Path, previous: dict[str, str]) -> dict[str, str]:
    key = (platform.system(), platform.machine())
    checksum = CHECKSUMS[key]
    binary = security / "bin/gitleaks"
    if (
        binary.is_file()
        and not binary.is_symlink()
        and previous.get("archive_sha256") == checksum
        and previous.get("version") == GITLEAKS_VERSION
        and previous.get("sha256") == hashlib.sha256(binary.read_bytes()).hexdigest()
    ):
        if not os.access(binary, os.X_OK):
            binary.chmod(binary.stat().st_mode | 0o111)
        return previous
    arch = "x64" if key[1] == "x86_64" else "arm64"
    asset = f"gitleaks_{GITLEAKS_VERSION}_{key[0].lower()}_{arch}.tar.gz"
    url = f"https://github.com/gitleaks/gitleaks/releases/download/v{GITLEAKS_VERSION}/{asset}"
    with urllib.request.urlopen(url, timeout=120) as response:  # noqa: S310 -- fixed HTTPS release URL
        payload = response.read()
    if hashlib.sha256(payload).hexdigest() != checksum:
        msg = "Gitleaks checksum mismatch; installation blocked"
        raise RepoSecurityError(msg)
    directory = security / "bin"
    directory.mkdir(exist_ok=True)
    with tarfile.open(fileobj=io.BytesIO(payload), mode="r:gz") as archive:
        member = archive.getmember("gitleaks")
        stream = archive.extractfile(member) if member.isfile() else None
        if stream is None:
            msg = "Invalid Gitleaks archive executable"
            raise RepoSecurityError(msg)
        content = stream.read()
        atomic_write(binary, content, mode=0o755)
        if not os.access(binary, os.X_OK):
            binary.chmod(binary.stat().st_mode | 0o111)
        for name in ("LICENSE", "LICENSE.txt", "NOTICE", "NOTICE.txt"):
            with contextlib.suppress(KeyError):
                notice = archive.getmember(name)
                source = archive.extractfile(notice) if notice.isfile() else None
                if source:
                    atomic_write(directory / ("GITLEAKS-" + name), source.read(), mode=0o644)
    return {
        "version": GITLEAKS_VERSION,
        "archive_sha256": checksum,
        "sha256": hashlib.sha256(content).hexdigest(),
    }


def verify_python_runtime(security: Path) -> None:
    python = security / ".venv/bin/python"
    semgrep = security / ".venv/bin/semgrep"
    for path in (python, semgrep):
        if not path.is_file() or not os.access(path, os.X_OK):
            msg = "Security Python or Semgrep entry point is missing or not executable"
            raise RepoSecurityError(msg)
    command = "from importlib.metadata import version; " + "; ".join(
        f"assert version({name!r}) == {expected!r}" for name, expected in SCANNER_VERSIONS.items()
    )
    command += "; import semgrep; from presidio_analyzer import Pattern, PatternRecognizer"
    env = uv_environment()
    run_tool([str(python), "-B", "-c", command], cwd=security, env=env)
    with tempfile.TemporaryDirectory(prefix="repo-security-probe-") as directory:
        env.update(
            SEMGREP_SEND_METRICS="off",
            SEMGREP_ENABLE_VERSION_CHECK="0",
            SEMGREP_SETTINGS_FILE=str(Path(directory) / "settings.yml"),
            SEMGREP_LOG_FILE=str(Path(directory) / "semgrep.log"),
        )
        env.pop("SEMGREP_APP_TOKEN", None)
        actual = run_tool(
            [str(semgrep), "--version", "--disable-version-check", "--metrics=off"],
            cwd=security,
            env=env,
        )
    if actual != SCANNER_VERSIONS["semgrep"]:
        msg = "Unexpected Semgrep executable version"
        raise RepoSecurityError(msg)


def verify_scan_runtime(security: Path) -> None:
    version = run_tool([str(security / "bin/gitleaks"), "version"], cwd=security)
    if version.removeprefix("v") != GITLEAKS_VERSION:
        msg = "Unexpected Gitleaks version"
        raise RepoSecurityError(msg)
    run_tool(
        [str(security / ".venv/bin/python"), "-B", str(security / "selftest.py")],
        cwd=security,
        env=uv_environment(),
    )


def verify_runtime(security: Path) -> None:
    verify_python_runtime(security)
    verify_scan_runtime(security)


def install_runtime(root: Path, record: InstallRecord) -> None:
    security = root / ".security"
    uv = shutil.which("uv")
    if uv is None:
        msg = "Install uv before setup"
        raise RepoSecurityError(msg)
    command = [
        uv,
        "sync",
        "--locked",
        "--no-config",
        "--python",
        "3.13",
        "--project",
        str(security),
    ]
    env = uv_environment()
    try:
        run_tool([*command, "--check"], cwd=security, env=env)
    except RepoSecurityError:
        run_tool(command, cwd=security, env=env, timeout=600)
    try:
        verify_python_runtime(security)
    except (OSError, RepoSecurityError, subprocess.SubprocessError):
        # Package metadata alone does not reveal missing launchers or damaged imports.
        run_tool([*command, "--reinstall"], cwd=security, env=env, timeout=600)
        verify_python_runtime(security)  # One bounded repair; persistent failures stay blocked.
    record["gitleaks"] = install_gitleaks(security, record["gitleaks"])
    prior = read_record(root)
    if not prior or prior["status"] != "ready" or prior["gitleaks"] != record["gitleaks"]:
        save_record(root, record)  # Preserve verified archive provenance on partial failure.
    verify_scan_runtime(security)


def deploy_hook_dispatcher(root: Path) -> None:
    path = root / HOOK_LINK
    path.parent.mkdir(parents=True, exist_ok=True)
    if not hook_link_matches(root):
        path.symlink_to(HOOK_TARGET)  # Exclusive creation never overwrites another hook.
    entry = root / HOOK_ENTRY
    if not entry.exists():
        create_resource(entry, TemplateFile(HOOK_ENTRY, HOOK_DISPATCHER, executable=True))
    elif entry.read_bytes() != HOOK_DISPATCHER:
        if not owned_old_dispatcher(root, read_record(root, legacy=True)):
            msg = "Pre-commit entry changed during migration; preserving external edits"
            raise RepoSecurityError(msg)
        atomic_write(entry, HOOK_DISPATCHER, mode=stat.S_IMODE(entry.stat().st_mode))
    if not os.access(entry, os.X_OK):
        entry.chmod(entry.stat().st_mode | stat.S_IXUSR)


def activate_hooks(plan: InstallPlan) -> None:
    if hooks_state(plan.root) != plan.hooks:
        msg = "Hooks configuration changed during setup; preserving external edits"
        raise RepoSecurityError(msg)
    conflicts = hook_conflicts(plan.root, plan.hooks, plan.previous)
    if conflicts:
        raise RepoSecurityError("\n".join(conflicts))
    deploy_hook_dispatcher(plan.root)
    if hooks_state(plan.root) != plan.hooks:
        msg = "Hooks configuration changed during setup; preserving external edits"
        raise RepoSecurityError(msg)
    if (
        plan.hooks.local
        and git(plan.root, "config", "--local", "--unset-all", "core.hooksPath").returncode
    ):
        msg = "Cannot remove legacy repository-local hooks path"
        raise RepoSecurityError(msg)
    try:
        if not hooks_enabled(plan.root, hooks_state(plan.root)):
            msg = "Hooks configuration did not take effect"
            raise RepoSecurityError(msg)  # noqa: TRY301 -- rollback follows this verification failure
    except (RepoSecurityError, OSError, ValueError, subprocess.SubprocessError):
        current = hooks_state(plan.root)
        if plan.hooks.local and not current.local:
            for value in plan.hooks.local:
                git(plan.root, "config", "--local", "--add", "core.hooksPath", value)
        raise


def migration_record(plan: InstallPlan) -> InstallRecord:
    record = record_for(plan)
    if plan.upgrade_required:
        record["migration_backup"] = backup_migration(plan)
        if plan.previous:
            for name, old in plan.previous["files"].items():
                if name in record["files"]:
                    record["files"][name]["installed_sha256"] = old["installed_sha256"]
                else:
                    record["files"][name] = old.copy()
    return record


def execute_setup(  # noqa: C901, PLR0912 -- phase checkpoints and hook activation stay ordered
    root: Path,
    resources: tuple[TemplateFile, ...],
    *,
    github_actions: bool = False,
    install_hooks: bool = True,
    checkout: bool = False,
) -> InstallPlan:
    initial = make_plan(root, resources, github_actions=github_actions, checkout=checkout)
    if initial.conflicts:
        raise RepoSecurityError("\n".join(initial.conflicts))
    if initial.upgrade_required and not install_hooks:
        msg = "Managed installation upgrade requires hook setup; run .security/setup.sh"
        raise RepoSecurityError(msg)
    with setup_lock(root):
        plan = make_plan(
            root, resources, github_actions=github_actions, locked=True, checkout=checkout
        )
        if plan.conflicts:
            raise RepoSecurityError("\n".join(plan.conflicts))
        updating = (
            not plan.previous
            or plan.previous["status"] != "ready"
            or bool(plan.create or plan.repair)
            or (install_hooks and not hooks_enabled(root, plan.hooks))
            or plan.upgrade_required
        )
        (root / ".security").mkdir(exist_ok=True)
        record = migration_record(plan)
        try:
            if updating:
                save_record(root, record)
            if install_hooks:
                # Update the forwarding guard first; old scanners reject its readiness flag.
                guard = next(
                    x for x in plan.resources if x.destination == ".security/hooks/pre-commit"
                )
                deploy_resource(plan, guard)
                # The shell entry rejects commits under the lock, even before runtime deployment.
                activate_hooks(plan)
            deploy(plan)
            record["files"] = record_for(plan)["files"]
            record["phase"] = "deployed"
            if updating:
                save_record(root, record)
            install_runtime(root, record)
            record["phase"] = "tools-verified"
            if updating:
                save_record(root, record)
            # Revalidate managed content and hook state after slow external operations.
            final = make_plan(
                root, resources, github_actions=github_actions, locked=True, checkout=checkout
            )
            if final.conflicts or final.create or final.repair or final.update or final.remove:
                msg = "Installation changed during verification; rerun setup after review"
                raise RepoSecurityError(msg)  # noqa: TRY301 -- persist incomplete state on failure
            if install_hooks:
                if not hooks_enabled(root, final.hooks):
                    msg = "Security hooks changed during installation; rerun setup"
                    raise RepoSecurityError(msg)  # noqa: TRY301 -- never mark disabled hooks ready
                record["status"], record["phase"] = "ready", "ready"
            else:
                record["phase"] = "tools-verified"
                if hooks_enabled(root, final.hooks):
                    record["status"], record["phase"] = "ready", "ready"
            save_record(root, record)
        except (
            OSError,
            ValueError,
            RepoSecurityError,
            subprocess.SubprocessError,
            tarfile.TarError,
        ):
            record["status"] = "incomplete"
            if record["phase"] == "ready":
                record["phase"] = "tools-verified"
            # Keep successfully installed protection active: an unready setup must block commits.
            save_record(root, record)
            raise
    return plan


def diagnose(root: Path, resources: tuple[TemplateFile, ...]) -> tuple[bool, tuple[str, ...]]:
    messages: list[str] = []
    healthy = True
    plan = make_plan(root, resources)
    for conflict in plan.conflicts:
        if any(conflict.startswith(name + ": custom") for name in CUSTOMIZABLE):
            messages.append("CUSTOM " + conflict)
        else:
            messages.append("ERROR " + conflict)
            healthy = False
    if plan.create or plan.repair:
        messages.extend("ERROR missing/needs repair: " + x for x in (*plan.create, *plan.repair))
        healthy = False
    if plan.upgrade_required:
        messages.append("ERROR managed installation needs upgrade; run .security/setup.sh")
        healthy = False
    messages.extend(
        "CUSTOM " + resource.destination + ": preserved repository rules"
        for resource in plan.resources
        if resource.template_sha256 and resource.template_sha256 != resource.digest
    )
    if not plan.previous or plan.previous["status"] != "ready":
        messages.append("ERROR installation manifest missing or incomplete; run setup")
        healthy = False
    if not hooks_enabled(root, plan.hooks):
        messages.append("ERROR repository security hooks are not active")
        healthy = False
    unsafe = any(
        not any(c.startswith(name + ": custom") for name in CUSTOMIZABLE) for c in plan.conflicts
    )
    unsafe = (
        unsafe
        or any(x != ".gitignore (merge)" for x in plan.create)
        or bool(plan.repair)
        or plan.upgrade_required
    )
    if not trusted_binary(root, plan.previous):
        messages.append(
            "ERROR Gitleaks provenance or executable digest missing/mismatched; run setup"
        )
        unsafe = True
    if not unsafe:
        try:
            verify_runtime(root / ".security")
            messages.append("OK real scanner versions, local rules and synthetic detection")
        except (OSError, RepoSecurityError, subprocess.SubprocessError):
            messages.append(
                "ERROR scanner environment, versions or local rules failed verification"
            )
            healthy = False
    else:
        healthy = False
    messages.append(
        "CI: " + ("present" if (root / WORKFLOW).is_file() else "not configured (optional)")
    )
    return healthy, tuple(messages)


def trusted_binary(root: Path, record: InstallRecord | None) -> bool:
    binary = root / ".security/bin/gitleaks"
    if record is None or path_problem(root, ".security/bin/gitleaks") or not binary.is_file():
        return False
    provenance = record["gitleaks"]
    return (
        provenance.get("version") == GITLEAKS_VERSION
        and provenance.get("archive_sha256")
        == CHECKSUMS.get((platform.system(), platform.machine()))
        and provenance.get("sha256") == hashlib.sha256(binary.read_bytes()).hexdigest()
    )


def _require_registered_files(root: Path, record: InstallRecord) -> None:
    for name in RUNTIME_NAMES:
        relative = ".security/" + name
        path = root / relative
        if path_problem(root, relative) or not path.is_file():
            msg = f"Required security file is missing or linked: {relative}"
            raise RepoSecurityError(msg)
        info = record["files"][relative]
        if hashlib.sha256(path.read_bytes()).hexdigest() != info["installed_sha256"]:
            msg = f"Security file changed since installation: {relative}; review and reinstall"
            raise RepoSecurityError(msg)
        if info["executable"] and not os.access(path, os.X_OK):
            msg = f"Security entry point is not executable: {relative}"
            raise RepoSecurityError(msg)


def _require_commit_tools(root: Path, record: InstallRecord) -> None:
    if not trusted_binary(root, record) or not os.access(root / ".security/bin/gitleaks", os.X_OK):
        msg = "Gitleaks is missing or its installed digest does not match; rerun setup"
        raise RepoSecurityError(msg)
    for tool in ("python", "semgrep"):
        path = root / ".security/.venv/bin" / tool
        if not path.is_file() or not os.access(path, os.X_OK):
            msg = f"Security tool is missing or not executable: {tool}; rerun setup"
            raise RepoSecurityError(msg)
    for name, expected in SCANNER_VERSIONS.items():
        try:
            actual = version(name)
        except PackageNotFoundError as error:
            msg = f"Security dependency is missing: {name}; rerun setup"
            raise RepoSecurityError(msg) from error
        if actual != expected:
            msg = f"Security dependency has an unexpected version: {name}; rerun setup"
            raise RepoSecurityError(msg)


def require_commit_ready(root: Path) -> None:
    lock = root / ".git/repo-security-setup.lock"
    if lock.exists() or lock.is_symlink():
        msg = "Security setup is running or interrupted; resolve its setup lock before committing"
        raise RepoSecurityError(msg)
    record = read_record(root)
    if record is None or record["status"] != "ready" or record["phase"] != "ready":
        msg = "Security installation is not ready; run .security/setup.sh"
        raise RepoSecurityError(msg)
    hooks = hooks_state(root)
    if not hooks_enabled(root, hooks):
        msg = "Security hooks are not enabled; run .security/setup.sh"
        raise RepoSecurityError(msg)
    legacy_push = root / HOOKS_PATH / "pre-push"
    if legacy_push.exists() or legacy_push.is_symlink():
        msg = "Legacy pre-push hook remains; review and remove it for commit-only setup"
        raise RepoSecurityError(msg)
    _require_registered_files(root, record)
    _require_commit_tools(root, record)


def standalone_main(security: Path, *, install_hooks: bool) -> None:
    root = repository_root(security.parent)
    for name in RUNTIME_NAMES:
        problem = path_problem(root, ".security/" + name)
        if problem:
            raise RepoSecurityError(problem)
    resources = tuple(
        TemplateFile(
            ".security/" + name,
            (security / name).read_bytes(),
            name in ("run", "setup.sh") or name.startswith("hooks/"),
        )
        for name in RUNTIME_NAMES
    )
    if (root / WORKFLOW).is_file():
        resources += (TemplateFile(WORKFLOW, (root / WORKFLOW).read_bytes(), executable=False),)
    execute_setup(
        root,
        resources,
        github_actions=(root / WORKFLOW).is_file(),
        install_hooks=install_hooks,
        checkout=True,
    )

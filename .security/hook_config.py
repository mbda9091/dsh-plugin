"""Git-native registration and one-time migration; copied into each installation."""

from __future__ import annotations

import hashlib
import os
import re
import shlex
import stat
import subprocess
import tempfile
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Mapping

MINIMUM_GIT = (2, 54, 0)
SCHEMA_VERSION = 2
SECURITY_COMMAND = "./.security/hooks/pre-commit"
MIGRATED_CHECKS = ".security/hooks/migrated-project-checks"
DISPATCHER_DIGESTS = {
    "f8ca5b03e22fa8eabbb4a11c2d1b9a2c24f8f927d484d4d5ed73d3b211400ced",
    "c5cc92e515c9de67bc5dc93d9db3faa3213ddc4e3dc7ea1e147fa9f2f142da6b",
    "192f87feb69f2ffdf8194830284b46ceb8d9dd1692e32742fe03745c93d5cb59",
}


class RepoSecurityError(Exception):
    pass


def git(root: Path, *args: str) -> subprocess.CompletedProcess[str]:
    env = dict(os.environ)
    # Configuration inspection must target this checkout, not an inherited index.
    for key in ("GIT_DIR", "GIT_WORK_TREE", "GIT_COMMON_DIR", "GIT_INDEX_FILE"):
        env.pop(key, None)
    return subprocess.run(  # noqa: S603 -- fixed Git executable and explicit argument vector
        ["git", "-C", str(root), *args],  # noqa: S607
        capture_output=True,
        text=True,
        env=env,
        check=False,
        timeout=30,
    )


def require_git(root: Path, *, capability: bool = True) -> str:
    try:
        result = git(root, "--version")
    except OSError as error:
        msg = "Git >= 2.54.0 is required. Install or upgrade Git; no repository changes were made."
        raise RepoSecurityError(msg) from error
    actual = result.stdout.strip()
    match = re.fullmatch(r"git version (\d+)\.(\d+)\.(\d+)(?:[. +\-].*)?", actual)
    if (
        result.returncode
        or not match
        or tuple(map(int, match.groups())) < MINIMUM_GIT
        or (tuple(map(int, match.groups())) == MINIMUM_GIT and re.search(r"[.\-]rc", actual))
    ):
        msg = (
            f"Unsupported or unrecognized Git ({actual or 'unknown version'}); "
            "Git >= 2.54.0 is required. Upgrade Git and rerun setup. "
            "No repository changes were made."
        )
        raise RepoSecurityError(msg)
    if not capability:
        return actual
    if not native_event(root, "pre-commit"):
        msg = "Git native hook configuration is unavailable; upgrade Git. No changes were made."
        raise RepoSecurityError(msg)
    return actual


def native_event(root: Path, event: str) -> bool:
    probe = "repo-security-capability-probe"
    listed = git(
        root,
        "-c",
        "core.hooksPath=/dev/null",
        "-c",
        f"hook.{probe}.command=:",
        "-c",
        f"hook.{probe}.event=",
        "-c",
        f"hook.{probe}.event={event}",
        "-c",
        f"hook.{probe}.enabled=true",
        "-c",
        f"hook.{event}.enabled=true",
        "hook",
        "list",
        "-z",
        event,
    )
    return listed.returncode == 0 and probe in listed.stdout.split("\0")


@dataclass(frozen=True)
class GitLayout:
    git_dir: Path
    common_dir: Path
    scope: str
    config: Path


def git_layout(root: Path) -> GitLayout:
    def location(option: str) -> Path:
        result = git(root, "rev-parse", option)
        if result.returncode:
            msg_0 = "Cannot resolve Git repository layout"
            raise RepoSecurityError(msg_0)
        path = Path(result.stdout.rstrip("\n"))
        return (root / path).resolve()

    directory = location("--absolute-git-dir")
    common = location("--git-common-dir")
    extension = git(root, "config", "--bool", "--get", "extensions.worktreeConfig")
    enabled = extension.returncode == 0 and extension.stdout.strip() == "true"
    if directory != common and not enabled:
        msg = "Linked worktree requires extensions.worktreeConfig; enable isolation before setup"
        raise RepoSecurityError(msg)
    scope = "worktree" if enabled else "local"
    return GitLayout(
        directory, common, scope, directory / "config.worktree" if enabled else common / "config"
    )


def metadata_path(root: Path, relative: str) -> Path:
    if relative.startswith(".git/"):
        return git_layout(root).git_dir / relative.removeprefix(".git/")
    return root / relative


def config_values(root: Path, *, scope: str | None = None) -> tuple[tuple[str, str], ...]:
    if scope == "worktree" and not git_layout(root).config.exists():
        return ()
    command = ["config", "-z"]
    if scope:
        command.append("--" + scope)
    command.append("--list")
    result = git(root, *command)
    if result.returncode:
        msg = "Cannot inspect Git configuration"
        raise RepoSecurityError(msg)
    return tuple(
        (item.partition("\n")[0], item.partition("\n")[2])
        for item in result.stdout.split("\0")
        if item
    )


def _values(entries: tuple[tuple[str, str], ...], key: str) -> tuple[str, ...]:
    return tuple(value for name, value in entries if name == key)


def _enabled(root: Path, name: str) -> bool:
    result = git(root, "config", "--bool", "--get", name)
    if result.returncode == 1:
        return True
    if result.returncode or result.stdout.strip() not in ("true", "false"):
        raise RepoSecurityError("Invalid Boolean Git configuration: " + name)
    return result.stdout.strip() == "true"


@dataclass(frozen=True)
class NativeHook:
    name: str
    event: str
    command: str

    def record(self) -> dict[str, str]:
        return {"name": self.name, "event": self.event, "command": self.command}


@dataclass(frozen=True)
class OwnedRemoval:
    relative: str
    content: bytes | str


@dataclass(frozen=True)
class HooksState:
    local: tuple[str, ...]
    effective: str | None
    origin: str | None
    layout: GitLayout
    config_before: bytes | None
    entries: tuple[tuple[str, str], ...]


def hooks_state(root: Path) -> HooksState:
    layout = git_layout(root)
    if layout.config.is_symlink() or (layout.config.exists() and not layout.config.is_file()):
        msg = "Git configuration must be a regular file, not a symlink"
        raise RepoSecurityError(msg)
    effective = git(root, "config", "--show-origin", "--get", "core.hooksPath")
    if effective.returncode not in (0, 1):
        msg = "Cannot inspect Git hooks configuration"
        raise RepoSecurityError(msg)
    origin, value = (None, None)
    if effective.returncode == 0:
        origin, value = effective.stdout.rstrip("\n").split("\t", 1)
    return HooksState(
        _values(config_values(root, scope="local"), "core.hookspath"),
        value,
        origin,
        layout,
        layout.config.read_bytes() if layout.config.exists() else None,
        config_values(root),
    )


def hook_signature(state: HooksState) -> tuple[GitLayout, tuple[tuple[str, str], ...]]:
    # After publication, IDE branch metadata is unrelated and must remain untouched.
    return state.layout, tuple(
        (key, value)
        for key, value in state.entries
        if key.startswith(("hook.", "include.", "includeif."))
        or key in ("core.hookspath", "extensions.worktreeconfig")
    )


def _available_name(entries: tuple[tuple[str, str], ...], stem: str) -> str:
    names = {key[5:].rsplit(".", 1)[0] for key, _ in entries if key.startswith("hook.")}
    candidate = stem
    suffix = 1
    while candidate in names:
        suffix += 1
        candidate = f"{stem}-{suffix}"
    return candidate


def _existing_security_names(entries: tuple[tuple[str, str], ...]) -> tuple[str, ...]:
    names = {
        key[5:-8]
        for key, value in entries
        if key.startswith("hook.") and key.endswith(".command") and value == SECURITY_COMMAND
    }
    return tuple(
        sorted(name for name in names if re.fullmatch(r"repo-security(?:-[A-Za-z0-9-]+)?", name))
    )


def migration_script(members: tuple[str, ...]) -> bytes:
    lines = ["#!/bin/sh", "set -eu", "git_dir=$(git rev-parse --absolute-git-dir)"]
    for member in members:
        path = '"$git_dir"/' + shlex.quote("hooks/pre-commit.d/" + member)
        lines.extend(
            [
                f"if [ ! -f {path} ] || [ ! -x {path} ]; then",
                "    echo 'Migrated project check is missing or not executable.' >&2",
                "    exit 2",
                "fi",
                f'{path} "$@"',
            ]
        )
    return ("\n".join(lines) + "\n").encode()


@dataclass(frozen=True)
class HookPlan:
    state: HooksState
    registrations: tuple[NativeHook, ...]
    removals: tuple[OwnedRemoval, ...]
    members: tuple[str, ...]
    clear_legacy_path: bool
    conflicts: tuple[str, ...]

    @property
    def name(self) -> str:
        return self.registrations[-1].name


def _legacy_removals(  # noqa: C901, PLR0912 -- check ownership and active legacy checks
    root: Path,
    state: HooksState,
    previous: Mapping[str, Any] | None,
) -> tuple[list[OwnedRemoval], tuple[str, ...]]:
    entry = state.layout.common_dir / "hooks/pre-commit"
    owned = (
        not entry.is_symlink()
        and entry.is_file()
        and hashlib.sha256(entry.read_bytes()).hexdigest() in DISPATCHER_DIGESTS
    )
    if not owned:
        if (
            previous
            and previous.get("schema_version") == 1
            and (entry.exists() or entry.is_symlink())
        ):
            msg = "Legacy security pre-commit was modified; preserving it before migration"
            raise RepoSecurityError(msg)
        return [], ()
    if entry.parent.is_symlink():
        msg = "Legacy hooks directory is a symlink; preserving it before migration"
        raise RepoSecurityError(msg)
    if state.layout.git_dir != state.layout.common_dir:
        if (
            state.effective is not None
            and (root / state.effective).resolve() != entry.parent.resolve()
        ):
            # A private hooksPath already isolates this checkout. The shared
            # dispatcher is inactive here and remains owned by the main checkout.
            return [], ()
        msg = "Migrate the main checkout's shared security hook before worktree setup"
        raise RepoSecurityError(msg)
    if not previous:
        msg = "Legacy security dispatcher needs its installation record for migration"
        raise RepoSecurityError(msg)
    removals = [OwnedRemoval(".git/hooks/pre-commit", entry.read_bytes())]
    member_path = state.layout.git_dir / "hooks/pre-commit.d/10-security"
    if member_path.is_symlink():
        target = str(member_path.readlink())
        if target != "../../../.security/hooks/pre-commit":
            msg = "Legacy security member was modified; preserving it"
            raise RepoSecurityError(msg)
        removals.append(OwnedRemoval(".git/hooks/pre-commit.d/10-security", target))
    elif member_path.exists():
        msg = "Legacy security member was modified; preserving it"
        raise RepoSecurityError(msg)
    if state.effective is not None and (root / state.effective).resolve() != entry.parent.resolve():
        # The default dispatcher is inactive under another hooksPath; keep its
        # project members inactive instead of accidentally enabling them.
        return removals, ()
    directory = entry.parent / "pre-commit.d"
    if directory.is_symlink():
        msg = "Legacy project checks directory is a symlink; preserving it"
        raise RepoSecurityError(msg)
    members: list[str] = []
    for path in sorted(directory.iterdir()) if directory.exists() else ():
        if path.name == "10-security":
            continue
        if not path.is_file() or not os.access(path, os.X_OK):
            raise RepoSecurityError("Legacy project check is not executable: " + path.name)
        members.append(path.name)
    return removals, tuple(members)


def plan_hooks(  # noqa: C901, PLR0912, PLR0915 -- aggregate native and migration conflicts
    root: Path, previous: Mapping[str, Any] | None
) -> HookPlan:
    state = hooks_state(root)
    entries = state.entries
    conflicts: list[str] = []
    removals: list[OwnedRemoval] = []
    members: tuple[str, ...] = ()
    registrations: list[NativeHook] = []
    try:
        removals, members = _legacy_removals(root, state, previous)
    except RepoSecurityError as error:
        conflicts.append(str(error))
    if previous and previous.get("schema_version") == SCHEMA_VERSION:
        registrations = [NativeHook(**item) for item in previous["native_hooks"]]
        members = tuple(previous.get("migration_members", ()))
    else:
        if members:
            registrations.append(
                NativeHook(
                    _available_name(entries, "repo-security-project-checks"),
                    "pre-commit",
                    "./" + MIGRATED_CHECKS,
                )
            )
        existing = _existing_security_names(entries)
        if len(existing) > 1:
            conflicts.append(
                "Multiple unregistered security hooks exist; review duplicates before setup"
            )
        name = existing[0] if existing else _available_name(entries, "repo-security")
        registrations.append(NativeHook(name, "pre-commit", SECURITY_COMMAND))
    migrating = previous and (
        previous.get("schema_version") == 1
        or (previous.get("status") == "incomplete" and "migration_backup" in previous)
    )
    clear_path = bool(
        migrating and state.local == (".security/hooks",) and state.effective == ".security/hooks"
    )
    if state.effective == ".security/hooks" and not clear_path:
        conflicts.append(
            "hooksPath selects the security runtime; "
            "an owned legacy record is required to migrate it"
        )
    if clear_path:
        if state.layout.git_dir != state.layout.common_dir:
            conflicts.append("Legacy hooksPath must be migrated in its owning main checkout")
        elif previous and previous.get("schema_version") != SCHEMA_VERSION:
            directory = root / ".security/hooks"
            for path in sorted(directory.iterdir()) if directory.exists() else ():
                if path.name == "pre-commit":
                    continue
                if not native_event(root, path.name) or not os.access(path, os.X_OK):
                    # Helpers and disabled traditional files were not active Git hooks.
                    continue
                info = (
                    previous.get("files", {}).get(".security/hooks/" + path.name)
                    if previous
                    else None
                )
                if (
                    path.name == "pre-push"
                    and info
                    and path.is_file()
                    and hashlib.sha256(path.read_bytes()).hexdigest() == info["installed_sha256"]
                    and info["installed_sha256"]
                    == "794c853e72ee45d2961c90e175db1c9d69b06b84cd07744a05ba296d9aa3c6bc"
                ):
                    continue
                if path.is_file() and os.access(path, os.X_OK):
                    stem = "repo-security-project-" + re.sub(r"[^a-zA-Z0-9-]", "-", path.name)
                    registrations.insert(
                        -1,
                        NativeHook(
                            _available_name(entries, stem),
                            path.name,
                            "./.security/hooks/" + shlex.quote(path.name),
                        ),
                    )
                else:
                    conflicts.append(
                        "Cannot migrate legacy hook without changing its behavior: " + path.name
                    )
    owned_names = {hook.name for hook in registrations}
    for hook in registrations:
        prefix = f"hook.{hook.name}."
        own = tuple((key, value) for key, value in entries if key.startswith(prefix))
        local = config_values(root, scope=state.layout.scope)
        scoped = tuple((key, value) for key, value in local if key.startswith(prefix))
        if own != scoped:
            conflicts.append(
                "Managed hook is overridden or duplicated in another scope: " + hook.name
            )
        commands = _values(own, prefix + "command")
        events = _values(own, prefix + "event")
        if commands and commands != (hook.command,):
            conflicts.append("Managed hook command was modified: " + hook.name)
        if events and any(event != hook.event for event in events):
            conflicts.append("Managed hook events were modified: " + hook.name)
        if not _enabled(root, prefix + "enabled") or not _enabled(
            root, f"hook.{hook.event}.enabled"
        ):
            conflicts.append("Hook or event is disabled: " + hook.name)
    if len(owned_names) != len(registrations):
        conflicts.append("Managed hook names are not unique")
    return HookPlan(
        state, tuple(registrations), tuple(removals), members, clear_path, tuple(conflicts)
    )


def hooks_enabled(root: Path, plan: HookPlan) -> bool:
    entries = config_values(root)
    for hook in plan.registrations:
        if _values(entries, f"hook.{hook.name}.command") != (hook.command,):
            return False
        if _values(entries, f"hook.{hook.name}.event") != (hook.event,):
            return False
        if not _enabled(root, f"hook.{hook.name}.enabled") or not _enabled(
            root, f"hook.{hook.event}.enabled"
        ):
            return False
        listed = git(root, "hook", "list", "-z", hook.event)
        if listed.returncode or listed.stdout.split("\0").count(hook.name) != 1:
            return False
    return True


def _config_content(  # noqa: C901 -- repair project fields in place, then append only security
    root: Path, plan: HookPlan
) -> bytes:
    config = plan.state.layout.config
    descriptor, name = tempfile.mkstemp(prefix=".repo-security-config-", dir=config.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(plan.state.config_before or b"")
        scoped = config_values(root, scope=plan.state.layout.scope)
        # Keep migrated project checks in place; only the security event moves.
        for hook in plan.registrations[:-1]:
            for field, value in (("command", hook.command), ("event", hook.event)):
                key = f"hook.{hook.name}.{field}"
                if _values(scoped, key) == (value,):
                    continue
                result = git(root, "config", "--file", str(temporary), "--replace-all", key, value)
                if result.returncode:
                    msg = "Cannot prepare migrated project hook configuration"
                    raise RepoSecurityError(msg)
        for hook in plan.registrations[-1:]:
            for field in ("command", "event"):
                result = git(
                    root,
                    "config",
                    "--file",
                    str(temporary),
                    "--unset-all",
                    f"hook.{hook.name}.{field}",
                )
                if result.returncode not in (0, 5):
                    msg = "Cannot prepare native hook configuration"
                    raise RepoSecurityError(msg)
        if plan.clear_legacy_path:
            result = git(root, "config", "--file", str(temporary), "--unset-all", "core.hooksPath")
            if result.returncode not in (0, 5):
                msg = "Cannot migrate legacy hooksPath"
                raise RepoSecurityError(msg)
        # Append actual registrations, not a sorted list: Git follows config parse order.
        with temporary.open("ab") as stream:
            stream.write(b"\n")
            for hook in plan.registrations[-1:]:
                # Our names are restricted; JSON string quoting matches these Git config values.
                import json  # noqa: PLC0415 -- only needed during the write phase

                stream.write(
                    (
                        f'[hook "{hook.name}"]\n'
                        f"\tcommand = {json.dumps(hook.command, ensure_ascii=False)}\n"
                        f"\tevent = {hook.event}\n"
                    ).encode()
                )
        return temporary.read_bytes()
    finally:
        temporary.unlink(missing_ok=True)


def registration_at_end(root: Path, plan: HookPlan) -> bool:
    entries = config_values(root, scope=plan.state.layout.scope)
    events = tuple(
        (key, value) for key, value in entries if key.startswith("hook.") and key.endswith(".event")
    )
    expected = tuple((f"hook.{hook.name}.event", hook.event) for hook in plan.registrations[-1:])
    return hooks_enabled(root, plan) and events[-len(expected) :] == expected


def hook_order(root: Path) -> str:
    result = git(root, "hook", "list", "-z", "--show-scope", "pre-commit")
    if result.returncode not in (0, 1):
        msg = "Cannot inspect the effective pre-commit hook order"
        raise RepoSecurityError(msg)
    return (
        " -> ".join(item.replace("\t", ":") for item in result.stdout.split("\0") if item)
        or "(none)"
    )


def activate_hooks(  # noqa: C901, PLR0912 -- locked publication and ownership checks stay ordered
    root: Path, plan: HookPlan
) -> None:
    if hooks_state(root) != plan.state:
        msg = "Hooks configuration changed during setup; preserving external edits"
        raise RepoSecurityError(msg)
    if plan.conflicts:
        raise RepoSecurityError("\n".join(plan.conflicts))
    if not registration_at_end(root, plan) or plan.clear_legacy_path:
        content = _config_content(root, plan)
        config = plan.state.layout.config
        lock = config.with_name(config.name + ".lock")
        try:
            descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
        except FileExistsError as error:
            msg = "Git configuration is locked by another writer"
            raise RepoSecurityError(msg) from error
        try:
            with os.fdopen(descriptor, "wb") as stream:
                stream.write(content)
            current = hooks_state(root)
            if current != plan.state:
                msg = "Hooks configuration changed during setup; preserving external edits"
                raise RepoSecurityError(msg)
            if config.exists():
                lock.chmod(stat.S_IMODE(config.stat().st_mode))
            lock.replace(config)
        finally:
            lock.unlink(missing_ok=True)
    if not hooks_enabled(root, plan):
        msg = "Native hooks configuration did not take effect"
        raise RepoSecurityError(msg)
    for removal in plan.removals:
        path = metadata_path(root, removal.relative)
        current = plan.state.layout.git_dir
        for part in Path(removal.relative.removeprefix(".git/")).parts[:-1]:
            current /= part
            if current.is_symlink():
                msg = "Legacy hook directory changed during migration; preserving external edits"
                raise RepoSecurityError(msg)
        if not path.exists() and not path.is_symlink():
            continue
        actual = str(path.readlink()) if path.is_symlink() else path.read_bytes()
        if actual != removal.content:
            msg = "Legacy hook changed during migration; preserving external edits"
            raise RepoSecurityError(msg)
        path.unlink()

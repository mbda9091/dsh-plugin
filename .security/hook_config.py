"""Git-native registration for the repository security scanner; copied into each installation."""

from __future__ import annotations

import os
import re
import stat
import subprocess
import tempfile
from contextlib import contextmanager
from dataclasses import dataclass
from pathlib import Path
from typing import TYPE_CHECKING, Any

if TYPE_CHECKING:
    from collections.abc import Generator, Mapping

MINIMUM_GIT = (2, 54, 0)
SCHEMA_VERSION = 2
SECURITY_COMMAND = "./.security/hooks/pre-commit"


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
    return GitLayout(directory, common, "local", common / "config")


def metadata_path(root: Path, relative: str) -> Path:
    if relative.startswith(".git/"):
        return git_layout(root).git_dir / relative.removeprefix(".git/")
    return root / relative


def config_values(root: Path, *, scope: str | None = None) -> tuple[tuple[str, str], ...]:
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
class HooksState:
    local: tuple[str, ...]
    effective: str | None
    origin: str | None
    layout: GitLayout
    config_before: bytes | None
    shared_config_before: bytes | None
    entries: tuple[tuple[str, str], ...]


def hooks_state(root: Path) -> HooksState:
    layout = git_layout(root)
    shared = layout.common_dir / "config"
    for config in (layout.config, shared):
        if config.is_symlink() or (config.exists() and not config.is_file()):
            msg = "Git configuration must be a regular file, not a symlink"
            raise RepoSecurityError(msg)
    effective = git(root, "config", "--show-origin", "-z", "--get", "core.hooksPath")
    if effective.returncode not in (0, 1):
        msg = "Cannot inspect Git hooks configuration"
        raise RepoSecurityError(msg)
    origin, value = (None, None)
    if effective.returncode == 0:
        origin, value, _ = effective.stdout.split("\0", 2)
    return HooksState(
        _values(config_values(root, scope="local"), "core.hookspath"),
        value,
        origin,
        layout,
        layout.config.read_bytes() if layout.config.exists() else None,
        shared.read_bytes() if shared.exists() else None,
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


@dataclass(frozen=True)
class HookPlan:
    state: HooksState
    registrations: tuple[NativeHook, ...]
    conflicts: tuple[str, ...]

    @property
    def name(self) -> str:
        return self.registrations[0].name


def plan_hooks(root: Path, previous: Mapping[str, Any] | None) -> HookPlan:
    state = hooks_state(root)
    entries = state.entries
    conflicts: list[str] = []
    if previous:
        registrations = tuple(NativeHook(**item) for item in previous["native_hooks"])
    else:
        existing = _existing_security_names(entries)
        if len(existing) > 1:
            conflicts.append("Multiple unregistered security hooks exist; review before setup")
        name = existing[0] if existing else _available_name(entries, "repo-security")
        registrations = (NativeHook(name, "pre-commit", SECURITY_COMMAND),)
    if (
        state.effective is not None
        and (root / state.effective).resolve() == (root / ".security/hooks").resolve()
    ):
        conflicts.append(
            "hooksPath selects the security runtime and would invoke it twice; "
            "review this configuration before setup. No hooksPath changes are made."
        )
    scoped_entries = config_values(root, scope=state.layout.scope)
    for hook in registrations:
        prefix = f"hook.{hook.name}."
        own = tuple((key, value) for key, value in entries if key.startswith(prefix))
        scoped = tuple((key, value) for key, value in scoped_entries if key.startswith(prefix))
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
    return HookPlan(state, registrations, tuple(conflicts))


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


def _config_content(root: Path, plan: HookPlan) -> bytes:
    config = plan.state.layout.config
    descriptor, name = tempfile.mkstemp(prefix=".repo-security-config-", dir=config.parent)
    temporary = Path(name)
    try:
        with os.fdopen(descriptor, "wb") as stream:
            stream.write(plan.state.config_before or b"")
        hook = plan.registrations[0]
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
        # Git follows config parse order; append only our registration.
        import json  # noqa: PLC0415 -- only needed during the write phase

        with temporary.open("ab") as stream:
            stream.write(
                (
                    f'\n[hook "{hook.name}"]\n'
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


@contextmanager
def _config_lock(config: Path) -> Generator[Path, None, None]:
    lock = config.with_name(config.name + ".lock")
    try:
        descriptor = os.open(lock, os.O_WRONLY | os.O_CREAT | os.O_EXCL, 0o600)
    except FileExistsError as error:
        msg = "Git configuration is locked by another writer"
        raise RepoSecurityError(msg) from error
    identity = os.fstat(descriptor)
    os.close(descriptor)
    try:
        yield lock
    finally:
        current = lock.lstat() if lock.exists() or lock.is_symlink() else None
        if current and (current.st_dev, current.st_ino) == (identity.st_dev, identity.st_ino):
            lock.unlink()


def _publish_config(root: Path, plan: HookPlan) -> None:
    config = plan.state.layout.config
    content = _config_content(root, plan)
    with _config_lock(config) as lock:
        if hooks_state(root) != plan.state:
            msg = "Hooks configuration changed during setup; preserving external edits"
            raise RepoSecurityError(msg)
        lock.write_bytes(content)
        if config.exists():
            lock.chmod(stat.S_IMODE(config.stat().st_mode))
        lock.replace(config)


def activate_hooks(root: Path, plan: HookPlan) -> None:
    if hooks_state(root) != plan.state:
        msg = "Hooks configuration changed during setup; preserving external edits"
        raise RepoSecurityError(msg)
    if plan.conflicts:
        raise RepoSecurityError("\n".join(plan.conflicts))
    if not registration_at_end(root, plan):
        _publish_config(root, plan)
    if not hooks_enabled(root, plan):
        msg = "Native hooks configuration did not take effect"
        raise RepoSecurityError(msg)

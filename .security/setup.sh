#!/bin/sh
set -eu
# Check before uv can create an environment or download Python/packages.
require_git() {
    if ! command -v git >/dev/null 2>&1; then
        echo 'Git >= 2.54.0 is required. Install Git; no repository changes were made.' >&2
        return 2
    fi
    if ! actual=$(git --version); then
        echo 'Cannot read Git version; Git >= 2.54.0 is required. No changes were made.' >&2
        return 2
    fi
    case "$actual" in
        'git version '*) number=${actual#git version } ;;
        *) number=unknown ;;
    esac
    major=${number%%.*}
    remainder=${number#*.}
    minor=${remainder%%.*}
    remainder=${remainder#*.}
    patch=${remainder%%[!0-9]*}
    case "$major:$minor:$patch" in
        *[!0-9:]*|:*|*::*|*:) valid=false ;;
        *) valid=true ;;
    esac
    case "$number" in *.*.*) ;; *) valid=false ;; esac
    suffix=${remainder#"$patch"}
    case "$suffix" in ''|.*|' '*|+*|-*) ;; *) valid=false ;; esac
    if [ "$valid" = true ]; then
        if [ "$major" -gt 2 ] || { [ "$major" -eq 2 ] && [ "$minor" -ge 54 ]; }; then
            case "$number" in 2.54.0.rc*|2.54.0-rc*) valid=false ;; *) return 0 ;; esac
        fi
    fi
    echo "Unsupported Git ($actual); Git >= 2.54.0 is required. Upgrade Git and rerun setup. No repository changes were made." >&2
    return 2
}
require_git
security_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! git -C "$security_dir/.." -c core.hooksPath=/dev/null \
    -c hook.repo-security-capability-probe.command=: \
    -c hook.repo-security-capability-probe.event= \
    -c hook.repo-security-capability-probe.event=pre-commit \
    -c hook.repo-security-capability-probe.enabled=true \
    -c hook.pre-commit.enabled=true \
    hook list -z pre-commit >/dev/null 2>&1; then
    echo 'Git native hook configuration is unavailable. Upgrade Git; no changes were made.' >&2
    exit 2
fi
if ! command -v uv >/dev/null 2>&1; then
    echo 'uv is required. Install uv, then rerun .security/setup.sh.' >&2
    exit 2
fi
exec uv run --no-project --no-config --isolated --python 3.13 \
    python -B "$security_dir/setup.py" --install-hooks "$@"

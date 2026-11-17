#!/bin/sh
set -eu
security_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
if ! command -v uv >/dev/null 2>&1; then
    echo 'uv is required. Install uv, then rerun .security/setup.sh.' >&2
    exit 2
fi
exec uv run --no-project --no-config --isolated --python 3.13 \
    python -B "$security_dir/setup.py" --install-hooks "$@"

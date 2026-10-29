#Requires -Version 7
# Initialize with scripts/config.ps1 init; --help describes launcher options.
param()
$ErrorActionPreference = 'Stop'
$scripts = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '../../scripts'))
. (Join-Path $scripts 'common.ps1')
$node = Resolve-Node
& $node (Join-Path $scripts 'bootstrap.mjs') web @args
exit $LASTEXITCODE

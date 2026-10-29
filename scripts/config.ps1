#Requires -Version 7
# Thin entry point: init [--dry-run] / check. Remaining arguments go to the TS CLI.
param()
$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$node = Resolve-Node
& $node (Join-Path $PSScriptRoot 'bootstrap.mjs') config @args
exit $LASTEXITCODE

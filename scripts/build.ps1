#Requires -Version 7
<#
.SYNOPSIS
  Build or type-check every plugin with the TypeScript compiler.

.DESCRIPTION
  Thin wrapper: the implementation lives in scripts/src (TypeScript) and runs
  through scripts/bootstrap.mjs. The wrapper stays as a stable entry point for
  the docs and for scripts/dev-install.ps1 / pack.ps1 / stable-install.ps1
  while those are still PowerShell.

  The metadata gates (check-targets, catalog --check) run before TypeScript so
  a bad dsh.targets, a stale locale prefix, or an outdated CATALOG.md fails fast
  with a path to the fix.

.PARAMETER Check
  Type-check only (tsc --noEmit) instead of emitting lib/.

.EXAMPLE
  pwsh -File scripts/build.ps1
  pwsh -File scripts/build.ps1 -Check
#>
param([switch]$Check)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$node = Resolve-Node
$arguments = @((Join-Path $PSScriptRoot 'bootstrap.mjs'), 'build')
if ($Check) { $arguments += '--check' }

& $node @arguments
exit $LASTEXITCODE

#Requires -Version 7
<#
.SYNOPSIS
  Generate CATALOG.md from each plugin's dsh.targets and zh locale metadata.

.DESCRIPTION
  Thin wrapper around `node scripts/bootstrap.mjs catalog`; the implementation
  lives in scripts/src/commands/catalog.ts.

  The file is generated but committed; use -Check to verify that it is up to
  date (scripts/build.ps1 does this).

.PARAMETER Output
  Destination path. Defaults to CATALOG.md at the repository root.

.PARAMETER Check
  Do not write; exit 1 when the existing file differs from the generated one.

.EXAMPLE
  pwsh -File scripts/catalog.ps1
  pwsh -File scripts/catalog.ps1 -Check
#>
param([string]$Output = '', [switch]$Check)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$node = Resolve-Node
$arguments = @((Join-Path $PSScriptRoot 'bootstrap.mjs'), 'catalog')
if ($Check) { $arguments += '--check' }
if (-not [string]::IsNullOrWhiteSpace($Output)) { $arguments += @('--output', $Output) }

& $node @arguments
exit $LASTEXITCODE

#Requires -Version 7
<#
.SYNOPSIS
  Validate every plugin's dsh.targets, locale scenario prefix, and README.

.DESCRIPTION
  Thin wrapper around `node scripts/bootstrap.mjs check-targets`; the
  implementation lives in scripts/src/commands/check-targets.ts.

  Called by scripts/build.ps1, including -Check. Run it directly when adding or
  changing a plugin; errors point at the exact file that needs updating.

.EXAMPLE
  pwsh -File scripts/check-targets.ps1
#>
param()

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$node = Resolve-Node
& $node (Join-Path $PSScriptRoot 'bootstrap.mjs') check-targets
exit $LASTEXITCODE

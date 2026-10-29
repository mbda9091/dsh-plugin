#Requires -Version 7
# Build and pack plugins into dist/.
# Compatibility wrapper; business logic and configuration live in scripts/src.
param([switch]$SkipBuild, [string]$DshCli, [string]$PnpmScript)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$node = Resolve-Node
$arguments = @((Join-Path $PSScriptRoot 'bootstrap.mjs'), 'pack')
if ($SkipBuild) { $arguments += '--skip-build' }
if (-not [string]::IsNullOrWhiteSpace($DshCli)) { $arguments += @('--dsh-cli', $DshCli) }
if (-not [string]::IsNullOrWhiteSpace($PnpmScript)) { $arguments += @('--pnpm-script', $PnpmScript) }
& $node @arguments
exit $LASTEXITCODE

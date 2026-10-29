#Requires -Version 7
# Build or type-check plugins.
# Compatibility wrapper; business logic and configuration live in scripts/src.
param([switch]$Check, [string]$DshCli, [string]$PnpmScript)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$node = Resolve-Node
$arguments = @((Join-Path $PSScriptRoot 'bootstrap.mjs'), 'build')
if ($Check) { $arguments += '--check' }
if (-not [string]::IsNullOrWhiteSpace($DshCli)) { $arguments += @('--dsh-cli', $DshCli) }
if (-not [string]::IsNullOrWhiteSpace($PnpmScript)) { $arguments += @('--pnpm-script', $PnpmScript) }
& $node @arguments
exit $LASTEXITCODE

#Requires -Version 7
# Install compatible tarballs and refresh their dependency resolution.
# Compatibility wrapper; business logic and configuration live in scripts/src.
param([string]$Profile, [string]$Surface, [string]$Platform, [switch]$DryRun, [switch]$All, [string]$DshCli, [string]$PnpmScript)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$node = Resolve-Node
$arguments = @((Join-Path $PSScriptRoot 'bootstrap.mjs'), 'stable-install')
if ($DryRun) { $arguments += '--dry-run' }
if ($All) { $arguments += '--all' }
if (-not [string]::IsNullOrWhiteSpace($Profile)) { $arguments += @('--profile', $Profile) }
if (-not [string]::IsNullOrWhiteSpace($Surface)) { $arguments += @('--surface', $Surface) }
if (-not [string]::IsNullOrWhiteSpace($Platform)) { $arguments += @('--platform', $Platform) }
if (-not [string]::IsNullOrWhiteSpace($DshCli)) { $arguments += @('--dsh-cli', $DshCli) }
if (-not [string]::IsNullOrWhiteSpace($PnpmScript)) { $arguments += @('--pnpm-script', $PnpmScript) }
& $node @arguments
exit $LASTEXITCODE

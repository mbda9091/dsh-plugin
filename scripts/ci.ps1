#Requires -Version 7
# Run type checking and L1-L5 with the resolved local configuration.
# Compatibility wrapper; business logic and configuration live in scripts/src.
param([switch]$Keep, [int]$TimeoutMs, [string]$DshCli, [string]$PnpmScript, [string]$TestBrowser, [string]$TestBrowserPath)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$node = Resolve-Node
$arguments = @((Join-Path $PSScriptRoot 'bootstrap.mjs'), 'ci')
if ($Keep) { $arguments += '--keep' }
if (-not [string]::IsNullOrWhiteSpace($TestBrowser)) { $arguments += @('--test-browser', $TestBrowser) }
if (-not [string]::IsNullOrWhiteSpace($TestBrowserPath)) { $arguments += @('--test-browser-path', $TestBrowserPath) }
if (-not [string]::IsNullOrWhiteSpace($DshCli)) { $arguments += @('--dsh-cli', $DshCli) }
if (-not [string]::IsNullOrWhiteSpace($PnpmScript)) { $arguments += @('--pnpm-script', $PnpmScript) }
if ($PSBoundParameters.ContainsKey('TimeoutMs')) { $arguments += @('--timeout', "$TimeoutMs") }
& $node @arguments
exit $LASTEXITCODE

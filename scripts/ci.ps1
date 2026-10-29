#Requires -Version 7
<#
.SYNOPSIS
  Run the local CI pipeline: type check, L1-L3, L4 and L5.
#>
param([switch]$Keep, [int]$TimeoutMs = 120000, [string]$DshCli)

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')
$node = Resolve-Node
if ($DshCli) { $env:DSH_CLI = $DshCli }
$arguments = @((Join-Path $PSScriptRoot 'bootstrap.mjs'), 'ci', '--timeout', "$TimeoutMs")
if ($Keep) { $arguments += '--keep' }
& $node @arguments
exit $LASTEXITCODE

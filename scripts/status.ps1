#Requires -Version 7
<#
.SYNOPSIS
  Show how every plugin in this repo is installed in the profile.

.DESCRIPTION
  Thin wrapper around `node scripts/bootstrap.mjs status`; the implementation
  lives in scripts/src/commands/status.ts.

  Reads the profile's package.json (no writes, no approval) and prints each
  plugin's dependency spec (`link:` = development, `file:`/tarball = stable
  package), whether its bundle is selected, its declared target, and whether it
  is compatible with the requested target.

.PARAMETER Profile
  Target profile name. Defaults to $env:DSH_PROFILE, then `desktop`.

.PARAMETER Surface
  Surface to check against: `desktop` or `web`. Defaults to the profile name
  when it is `desktop` or `web`.

.PARAMETER Platform
  Platform to check against: `windows` or `mac`. Defaults to the current OS.

.EXAMPLE
  pwsh -File scripts/status.ps1
  pwsh -File scripts/status.ps1 -Surface web -Platform windows
#>
param([string]$Profile = '', [string]$Surface = '', [string]$Platform = '')

$ErrorActionPreference = 'Stop'
. (Join-Path $PSScriptRoot 'common.ps1')

$node = Resolve-Node
$arguments = @((Join-Path $PSScriptRoot 'bootstrap.mjs'), 'status')
if (-not [string]::IsNullOrWhiteSpace($Profile)) { $arguments += @('--profile', $Profile) }
if (-not [string]::IsNullOrWhiteSpace($Surface)) { $arguments += @('--surface', $Surface) }
if (-not [string]::IsNullOrWhiteSpace($Platform)) { $arguments += @('--platform', $Platform) }

& $node @arguments
exit $LASTEXITCODE

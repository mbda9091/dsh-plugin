#Requires -Version 7
<#
.SYNOPSIS
  Build every plugin and pack it into a tarball under dist/.

.DESCRIPTION
  Runs scripts/build.ps1 first, then `pnpm pack` in each plugin directory.
  pnpm packs exactly the package.json `files` list, so the tarball is the same
  artifact a registry install would use. The result is what
  scripts/stable-install.ps1 installs.

  `lib/` is not committed, so the build step is not optional: packing an
  unbuilt plugin would ship a tarball whose `exports` point at missing files.

.PARAMETER SkipBuild
  Skip scripts/build.ps1 (pack the current lib/ as-is).

.EXAMPLE
  pwsh -File scripts/pack.ps1
#>
param([switch]$SkipBuild)

. (Join-Path $PSScriptRoot 'common.ps1')

$repo = Split-Path -Parent $PSScriptRoot
$node = Resolve-Node
$pnpm = Resolve-Pnpm
Set-NodeOnPath $node

if (-not $SkipBuild) {
  & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'build.ps1')
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$dist = Join-Path $repo 'dist'
New-Item -ItemType Directory -Path $dist -Force | Out-Null

$plugins = @(Get-PluginPackages -Repo $repo)
if ($plugins.Count -eq 0) { throw 'No plugin packages found.' }

# `lib/` is not committed and `pnpm pack` ships whatever exists, so a missing
# build output would silently produce a tarball that cannot be loaded.
$unbuilt = @($plugins | Where-Object {
  -not (Test-Path -LiteralPath (Join-Path $_.Dir 'lib\index.js'))
})
if ($unbuilt.Count -gt 0) {
  $names = ($unbuilt | ForEach-Object { $_.Name }) -join ', '
  throw "no build output in: $names; run scripts/build.ps1 (or drop -SkipBuild)"
}

foreach ($plugin in $plugins) {
  Write-Host "· pack $($plugin.PackageName)"
  Push-Location $plugin.Dir
  try {
    $pnpmArguments = @($pnpm.Arguments) + @('pack', '--pack-destination', $dist)
    & $pnpm.Command @pnpmArguments
    if ($LASTEXITCODE -ne 0) { throw "pack failed: $($plugin.PackageName)" }
  } finally {
    Pop-Location
  }
}

Write-Host 'tarballs:'
Get-ChildItem -LiteralPath $dist -Filter '*.tgz' | Sort-Object LastWriteTime -Descending |
  Select-Object Name, Length | Format-Table -AutoSize

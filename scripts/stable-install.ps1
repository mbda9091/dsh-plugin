#Requires -Version 7
<#
.SYNOPSIS
  Replace link installs with the packaged (tarball) build of each compatible plugin.

.DESCRIPTION
  Resolves the target surface/platform first and skips plugins whose
  dsh.targets do not cover it. For each remaining plugin, installs
  `dist/<name>-<version>.tgz` with `dsh plugin add`, then re-resolves the
  dependency with `pnpm update` in the profile. The second step is required
  when switching away from a `link:` install: pnpm can keep the junction (and a
  `link:` lockfile entry) even though the manifest now points at the tarball.

  pnpm installs the plugin's `dependencies` into the profile this time, which
  is what the link install skips.

  This writes to the profile directory, outside the workspace; DSH may ask for
  approval. Replacing a loaded plugin needs an app restart (`restart-required`).

.PARAMETER Profile
  Target profile name. Defaults to $env:DSH_PROFILE, then `desktop`.

.PARAMETER Surface
  Target surface: `desktop` or `web`. Defaults to the profile name when it is
  `desktop` or `web`; pass it explicitly for a custom profile.

.PARAMETER Platform
  Target platform: `windows` or `mac`. Defaults to the current OS.

.PARAMETER All
  Install every plugin, including ones whose dsh.targets do not cover the
  target. Useful for testing the runtime guard.

.EXAMPLE
  pwsh -File scripts/stable-install.ps1

.EXAMPLE
  pwsh -File scripts/stable-install.ps1 -DryRun -Surface web -Platform windows
#>
param(
  [string]$Profile = '',
  [string]$Surface = '',
  [string]$Platform = '',
  [switch]$DryRun,
  [switch]$All
)

. (Join-Path $PSScriptRoot 'common.ps1')
if (-not $Profile) { $Profile = Get-ProfileName }

$repo = Split-Path -Parent $PSScriptRoot
$dsh = Resolve-Dsh
$node = Resolve-Node
$pnpm = Resolve-Pnpm
Set-NodeOnPath $node
$dist = Join-Path $repo 'dist'
$profileDir = Get-ProfileDir $Profile
$plugins = @(Get-PluginPackages -Repo $repo)
if ($plugins.Count -eq 0) { throw 'No plugin packages found.' }

$target = Resolve-Target -Surface $Surface -Platform $Platform -Profile $Profile
$compatible = @($plugins | Where-Object { $All -or (Test-TargetCompatible -Plugin $_ -Target $target) })
$skipped = @($plugins | Where-Object { -not $All -and -not (Test-TargetCompatible -Plugin $_ -Target $target) })

Write-Host "target: $($target.Surface)/$($target.Platform)"
foreach ($plugin in $skipped) {
  Write-Host "· skip $($plugin.PackageName): requires $(Format-PluginTarget -Plugin $plugin)"
}
if ($compatible.Count -eq 0) {
  Write-Warning "no compatible plugins for target $($target.Surface)/$($target.Platform)"
}

function Get-TarballPath {
  param($Plugin)
  $flatName = ($Plugin.PackageName -replace '^@', '' -replace '/', '-')
  return Join-Path $dist "$flatName-$($Plugin.Version).tgz"
}

# Check every tarball before touching the profile. Otherwise a missing later
# artifact leaves earlier plugins switched while the run fails halfway.
$missing = @($compatible | Where-Object { -not (Test-Path -LiteralPath (Get-TarballPath $_)) })
if ($missing.Count -gt 0) {
  $names = ($missing | ForEach-Object { "$($_.PackageName)@$($_.Version)" }) -join ', '
  throw "missing tarball(s) for target $($target.Surface)/$($target.Platform): $names (run scripts/pack.ps1 first)"
}

foreach ($plugin in $compatible) {
  $tarball = Get-TarballPath $plugin

  # Do not remove the current dependency first: on Windows, removing a `link:`
  # dependency walks the junction and can delete the plugin's source directory.
  # `pnpm add` with the same package name replaces the spec in place and keeps
  # the bundle selected.
  if ($DryRun) {
    Write-Host "  dsh plugin --profile $Profile add $tarball"
    Write-Host "  (profile) pnpm update $($plugin.PackageName)"
    continue
  }

  Write-Host "· add $([System.IO.Path]::GetFileName($tarball))"
  & $dsh plugin --profile $Profile add $tarball
  if ($LASTEXITCODE -ne 0) { throw "tarball install failed: $($plugin.PackageName)" }

  # Re-resolve: this turns a stale `link:` entry (junction included) into the
  # packaged tarball.
  Write-Host "· re-resolve $($plugin.PackageName)"
  Push-Location $profileDir
  try {
    $pnpmArguments = @($pnpm.Arguments) + @('update', $plugin.PackageName)
    & $pnpm.Command @pnpmArguments
    if ($LASTEXITCODE -ne 0) { throw "pnpm update failed: $($plugin.PackageName)" }
  } finally {
    Pop-Location
  }
}

if ($DryRun) { Write-Host 'dry run: nothing changed.'; exit 0 }
Write-Host "stable install done. installed $($compatible.Count) plugin(s), skipped $($skipped.Count). Restart the app to load the packaged build."

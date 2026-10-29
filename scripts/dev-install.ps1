#Requires -Version 7
<#
.SYNOPSIS
  Install every compatible plugin in this repo into a profile as a link.

.DESCRIPTION
  Resolves the target surface/platform first, skips plugins whose dsh.targets
  do not cover it, then runs scripts/build.ps1 and `dsh plugin add <directory>`
  for each remaining top-level plugin package. pnpm records a `link:`
  dependency and the plugin manager selects the bundle, so code changes in this
  repo hot-reload through HMR. Re-running is idempotent.

  `lib/` is not committed: the link points at this directory and the loader
  imports `lib/index.js` directly, so the build has to run before linking.

  This writes to the profile directory, outside the workspace; DSH may ask for
  approval (or run it from a terminal outside DSH).

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

.PARAMETER SkipBuild
  Link the current `lib/` as-is instead of rebuilding first.

.EXAMPLE
  pwsh -File scripts/dev-install.ps1

.EXAMPLE
  pwsh -File scripts/dev-install.ps1 -DryRun -Surface web -Platform windows
#>
param(
  [string]$Profile = '',
  [string]$Surface = '',
  [string]$Platform = '',
  [switch]$DryRun,
  [switch]$SkipBuild,
  [switch]$All
)

. (Join-Path $PSScriptRoot 'common.ps1')
if (-not $Profile) { $Profile = Get-ProfileName }

$repo = Split-Path -Parent $PSScriptRoot
$dsh = Resolve-Dsh
$node = Resolve-Node
$pnpm = Resolve-Pnpm
Set-NodeOnPath $node
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

# Building is a prerequisite, not an optimization: a link install without
# `lib/` fails later inside the loader, where Node caches the failure.
if (-not $SkipBuild -and -not $DryRun) {
  & pwsh -NoProfile -File (Join-Path $PSScriptRoot 'build.ps1')
  if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
}

$unbuilt = @($compatible | Where-Object {
  -not (Test-Path -LiteralPath (Join-Path $_.Dir 'lib\index.js'))
})
if ($unbuilt.Count -gt 0) {
  $names = ($unbuilt | ForEach-Object { $_.Name }) -join ', '
  if ($DryRun) {
    Write-Warning "no build output in: $names (a real run builds first)"
  } else {
    throw "no build output in: $names; run scripts/build.ps1 first"
  }
}

Write-Host "profile: $Profile (link mode)"
foreach ($plugin in $compatible) {
  Write-Host "· link $($plugin.PackageName)"
  if ($DryRun) {
    Write-Host "  dsh plugin --profile $Profile add $($plugin.Dir)"
    Write-Host "  (profile) pnpm update $($plugin.PackageName)"
    continue
  }
  & $dsh plugin --profile $Profile add $plugin.Dir
  if ($LASTEXITCODE -ne 0) { throw "link install failed: $($plugin.PackageName)" }

  # Re-resolve so a previous tarball install becomes a junction instead of
  # staying a real copy under a `link:` spec.
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
Write-Host "done. installed $($compatible.Count) plugin(s), skipped $($skipped.Count). Code changes now hot-reload; restart the app if a plugin was already loaded."

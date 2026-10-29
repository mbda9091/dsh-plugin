# Shared helpers for the plugin scripts. Dot-source it from scripts/ scripts.
# All functions resolve the DSH runtime tools without requiring PATH setup.

$script:RepoRoot = Split-Path -Parent $PSScriptRoot

function Get-DshHome {
  if ($env:DSH_HOME) { return $env:DSH_HOME }
  return (Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh')
}

# A disposable DSH_HOME holds test data, but need not contain runtime tools.
function Get-DshRuntimeDirectories {
  $defaultHome = Join-Path ([Environment]::GetFolderPath('UserProfile')) '.dsh'
  @((Get-DshHome), $defaultHome) | Select-Object -Unique | ForEach-Object {
    Join-Path $_ 'dsh-runtimes/dsh-primary-runtime/dependencies'
  }
}

function Resolve-Node {
  if ($env:DSH_NODE) {
    $command = Get-Command $env:DSH_NODE -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
    if ($command) { return $command.Source }
    throw "DSH_NODE does not name an executable: $env:DSH_NODE. Set DSH_NODE to the Node executable path."
  }
  $relative = if ($IsWindows) { 'node/bin/node.exe' } else { 'node/bin/node' }
  foreach ($runtime in Get-DshRuntimeDirectories) {
    $candidate = Join-Path $runtime $relative
    if (Test-Path -LiteralPath $candidate -PathType Leaf) { return $candidate }
  }
  $command = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return $command.Source }
  throw 'Node was not found in the DSH runtimes or PATH. Set DSH_NODE to the Node executable path.'
}

function Resolve-Pnpm {
  foreach ($runtime in Get-DshRuntimeDirectories) {
    $candidate = Join-Path $runtime 'pnpm/bin/pnpm.cjs'
    if (Test-Path -LiteralPath $candidate -PathType Leaf) {
      return @{ Command = (Resolve-Node); Arguments = @($candidate) }
    }
  }
  $command = Get-Command pnpm -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
  if ($command) { return @{ Command = $command.Source; Arguments = @() } }
  throw 'pnpm was not found in the DSH runtimes or PATH. Install pnpm and add it to PATH, or set DSH_HOME to a home containing the DSH runtime.'
}

function Resolve-Dsh {
  if ($env:DSH_CLI) { return $env:DSH_CLI }
  $candidate = Join-Path $env:LOCALAPPDATA 'Programs\DeepSeek Harness\resources\runtime\cli\bin\dsh.cmd'
  if (Test-Path -LiteralPath $candidate) { return $candidate }
  return (Get-Command dsh -ErrorAction Stop).Source
}

function Get-ProfileName {
  if ($env:DSH_PROFILE) { return $env:DSH_PROFILE }
  return 'desktop'
}

function Get-ProfileDir {
  param([string]$Profile = (Get-ProfileName))
  if ($env:DSH_PROFILE_DIR -and $Profile -eq (Get-ProfileName)) { return $env:DSH_PROFILE_DIR }
  return (Join-Path (Get-DshHome) "profiles/$Profile")
}

function Get-ProfileManifest {
  param([string]$Profile = (Get-ProfileName))
  $path = Join-Path (Get-ProfileDir $Profile) 'package.json'
  if (-not (Test-Path -LiteralPath $path)) { throw "profile manifest not found: $path" }
  return (Get-Content -LiteralPath $path -Raw | ConvertFrom-Json)
}

function Set-NodeOnPath {
  param([string]$Node)
  $env:PATH = "$(Split-Path -Parent $Node);$env:PATH"
}

# Every top-level directory whose package.json declares a dsh bundle.
function Get-PluginPackages {
  param([string]$Repo = $script:RepoRoot)
  Get-ChildItem -LiteralPath $Repo -Directory | Where-Object {
    $_.Name -notlike '.*' -and $_.Name -ne 'node_modules' -and $_.Name -ne 'dist'
  } | ForEach-Object {
    $manifestPath = Join-Path $_.FullName 'package.json'
    if (-not (Test-Path -LiteralPath $manifestPath)) { return }
    $manifest = Get-Content -LiteralPath $manifestPath -Raw | ConvertFrom-Json
    if ($null -eq $manifest.dsh -or $null -eq $manifest.dsh.bundle) { return }
    $targets = $manifest.dsh.targets
    $surfaces = @()
    $platforms = @()
    if ($null -ne $targets) {
      if ($null -ne $targets.surfaces) { $surfaces = @($targets.surfaces) }
      if ($null -ne $targets.platforms) { $platforms = @($targets.platforms) }
    }
    [pscustomobject]@{
      Name = $_.Name
      Dir = $_.FullName
      PackageName = $manifest.name
      Version = $manifest.version
      Manifest = $manifest
      Surfaces = $surfaces
      Platforms = $platforms
    }
  }
}

# Resolve the target a script should install/check for. Explicit values win;
# otherwise the current OS and the profile name (desktop/web) provide defaults.
function Resolve-Target {
  param(
    [string]$Surface = '',
    [string]$Platform = '',
    [string]$Profile = ''
  )

  if (-not $Platform) {
    if ($IsWindows) { $Platform = 'windows' }
    elseif ($IsMacOS) { $Platform = 'mac' }
    elseif ($IsLinux) { throw 'Linux is reserved; only windows and mac targets are enabled.' }
    else { throw 'Unsupported current platform; pass -Platform windows|mac.' }
  }

  if (-not $Surface) {
    $name = if ($Profile) { $Profile } else { $env:DSH_PROFILE }
    switch ($name) {
      'desktop' { $Surface = 'desktop' }
      'web' { $Surface = 'web' }
      default { throw "Cannot infer surface from profile '$name'; pass -Surface desktop|web." }
    }
  }

  if ($Surface -notin @('desktop', 'web')) {
    throw "Unsupported surface '$Surface'; use desktop or web."
  }
  if ($Platform -notin @('windows', 'mac')) {
    throw "Unsupported platform '$Platform'; use windows or mac."
  }

  [pscustomobject]@{ Surface = $Surface; Platform = $Platform }
}

# True when a plugin's dsh.targets covers the target.
function Test-TargetCompatible {
  param($Plugin, $Target)
  return (($Plugin.Surfaces -contains $Target.Surface) -and ($Plugin.Platforms -contains $Target.Platform))
}

# Display form used in script output and status.ps1.
function Format-PluginTarget {
  param($Plugin)
  return "$($Plugin.Surfaces -join '+')/$($Plugin.Platforms -join '+')"
}

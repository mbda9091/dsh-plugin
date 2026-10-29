# Bootstrap helpers only. Tool selection and business logic live in scripts/src.
# Node must be located before the TypeScript configuration reader can run.

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

<#
.SYNOPSIS
  Install dsh-web-search-searxng into a DSH profile and point web_search at SearXNG.

.DESCRIPTION
  - Installs this directory as a file: plugin dependency (unless -SkipInstall).
  - Backs up and edits the profile's cordis.patch.yml:
      * web.config.searchProvider = searxng
      * web-search-searxng.config.baseURL (plus optional filters)
  - Prints the restart command.

  Stop "dsh web" before running: Windows locks the profile's node_modules while
  the app is running.

.PARAMETER BaseURL
  SearXNG base URL, e.g. https://search.example.com or http://127.0.0.1:8080.

.PARAMETER AuthHeader
  Optional raw Authorization header, e.g. "Bearer <token>".

.PARAMETER Profile
  DSH profile name. Default: web.

.PARAMETER ProfileFile
  Override the cordis.patch.yml path (used for testing).

.EXAMPLE
  powershell -NoProfile -ExecutionPolicy Bypass -File .\install.ps1 -BaseURL 'https://search.example.com' -Language 'zh-CN'
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)]
  [string]$BaseURL,

  [string]$AuthHeader = '',
  [string]$Language = '',
  [string]$Engines = '',
  [string]$Categories = '',
  [string]$Profile = 'web',
  [string]$ProfileFile = '',
  [switch]$SkipInstall,
  [switch]$NoRestart
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

function Write-Step([string]$Message) {
  Write-Host "[searx] $Message" -ForegroundColor Cyan
}

function Write-Warn([string]$Message) {
  Write-Host "[searx] $Message" -ForegroundColor Yellow
}

function Assert-BaseURL([string]$Value) {
  $uri = $null
  if (-not [Uri]::TryCreate($Value, [UriKind]::Absolute, [ref]$uri)) {
    throw "BaseURL is not an absolute URL: $Value"
  }
  if ($uri.Scheme -notin @('http', 'https')) {
    throw "BaseURL must use http or https: $Value"
  }
  if (-not [string]::IsNullOrEmpty($uri.UserInfo)) {
    throw 'BaseURL must not contain credentials; use -AuthHeader instead.'
  }
  if (-not [string]::IsNullOrEmpty($uri.Query) -or -not [string]::IsNullOrEmpty($uri.Fragment)) {
    throw 'BaseURL must not contain a query string or fragment.'
  }
}

function Quote-Yaml([string]$Value) {
  if ($Value.Contains([char]10) -or $Value.Contains([char]13)) {
    throw 'YAML scalar values must not contain newlines.'
  }
  return "'" + $Value.Replace("'", "''") + "'"
}

function Find-TopLevelBlock {
  param(
    [System.Collections.Generic.List[string]]$Lines,
    [string]$Id
  )
  $pattern = '^- id:\s*[''"]?' + [regex]::Escape($Id) + '[''"]?\s*$'
  for ($i = 0; $i -lt $Lines.Count; $i++) {
    if ($Lines[$i] -match $pattern) {
      $start = $i
      $end = $Lines.Count
      for ($j = $i + 1; $j -lt $Lines.Count; $j++) {
        if ($Lines[$j] -match '^- ') {
          $end = $j
          break
        }
      }
      return [pscustomobject]@{ Start = $start; End = $end }
    }
  }
  return $null
}

function Set-ConfigValue {
  param(
    [System.Collections.Generic.List[string]]$Lines,
    [pscustomobject]$Block,
    [string]$Key,
    [string]$Value
  )
  $keyPattern = '^(\s+)' + [regex]::Escape($Key) + ':\s*(.*)$'
  for ($i = $Block.Start + 1; $i -lt $Block.End; $i++) {
    if ($Lines[$i] -match $keyPattern) {
      $indent = $Matches[1]
      $Lines[$i] = $indent + $Key + ': ' + $Value
      return
    }
  }

  # No existing key: insert under the block's config map.
  for ($i = $Block.Start + 1; $i -lt $Block.End; $i++) {
    if ($Lines[$i] -match '^(\s+)config:\s*$') {
      $indent = $Matches[1] + '  '
      $Lines.Insert($i + 1, $indent + $Key + ': ' + $Value)
      $Block.End += 1
      return
    }
  }

  # No config map at all: append one at the end of the block.
  if ($Block.End -gt $Block.Start + 1 -and $Lines[$Block.End - 1].Trim().Length -eq 0) {
    $insertAt = $Block.End - 1
  } else {
    $insertAt = $Block.End
  }
  $Lines.Insert($insertAt, '  config:')
  $Lines.Insert($insertAt + 1, '    ' + $Key + ': ' + $Value)
  $Block.End += 2
}

function Add-Block {
  param(
    [System.Collections.Generic.List[string]]$Lines,
    [string]$Id,
    [System.Collections.Specialized.OrderedDictionary]$Config
  )
  if ($Lines.Count -gt 0 -and $Lines[$Lines.Count - 1].Trim().Length -ne 0) {
    $Lines.Add('')
  }
  $Lines.Add('- id: ' + $Id)
  $Lines.Add('  config:')
  foreach ($key in $Config.Keys) {
    $Lines.Add('    ' + $key + ': ' + $Config[$key])
  }
  return [pscustomobject]@{ Start = $Lines.Count - $Config.Count - 2; End = $Lines.Count }
}

Assert-BaseURL $BaseURL

if ([string]::IsNullOrEmpty($ProfileFile)) {
  $profileDir = Join-Path (Join-Path $env:USERPROFILE '.dsh\profiles') $Profile
  $ProfileFile = Join-Path $profileDir 'cordis.patch.yml'
}
if (-not (Test-Path -LiteralPath $ProfileFile)) {
  throw "Profile patch file not found: $ProfileFile. Start 'dsh --profile $Profile' once to initialize it."
}

$repo = $PSScriptRoot
if (-not $SkipInstall) {
  Write-Step "installing $repo into profile '$Profile'"
  $fileSpec = 'file:' + ($repo -replace '\\', '/')
  & dsh plugin --profile $Profile add $fileSpec
  if ($LASTEXITCODE -ne 0) {
    throw "dsh plugin add failed (exit $LASTEXITCODE). If node_modules is locked, stop 'dsh web' and rerun."
  }
} else {
  Write-Warn 'skipping plugin install (-SkipInstall)'
}

Write-Step "patching $ProfileFile"
$backup = "$ProfileFile.bak-$(Get-Date -Format 'yyyyMMdd-HHmmss')-searx"
Copy-Item -LiteralPath $ProfileFile -Destination $backup -Force
Write-Step "backup: $backup"

$lines = [System.Collections.Generic.List[string]]::new()
foreach ($line in [System.IO.File]::ReadAllLines($ProfileFile)) {
  $lines.Add($line)
}

# 1. Point the web service at the new provider.
$webBlock = Find-TopLevelBlock -Lines $lines -Id 'web'
if ($null -eq $webBlock) {
  Write-Warn "no '- id: web' block found; appending one (review fetchProvider after this)."
  $webConfig = [ordered]@{ searchProvider = 'searxng' }
  $webBlock = Add-Block -Lines $lines -Id 'web' -Config $webConfig
} else {
  Set-ConfigValue -Lines $lines -Block $webBlock -Key 'searchProvider' -Value 'searxng'
}

# 2. Write the provider endpoint and optional filters.
$config = [ordered]@{ baseURL = (Quote-Yaml $BaseURL) }
if (-not [string]::IsNullOrWhiteSpace($AuthHeader)) {
  $config['authHeader'] = (Quote-Yaml $AuthHeader)
}
if (-not [string]::IsNullOrWhiteSpace($Language)) {
  $config['language'] = (Quote-Yaml $Language)
}
if (-not [string]::IsNullOrWhiteSpace($Engines)) {
  $config['engines'] = (Quote-Yaml $Engines)
}
if (-not [string]::IsNullOrWhiteSpace($Categories)) {
  $config['categories'] = (Quote-Yaml $Categories)
}

$providerBlock = Find-TopLevelBlock -Lines $lines -Id 'web-search-searxng'
if ($null -eq $providerBlock) {
  Add-Block -Lines $lines -Id 'web-search-searxng' -Config $config | Out-Null
} else {
  foreach ($key in $config.Keys) {
    Set-ConfigValue -Lines $lines -Block $providerBlock -Key $key -Value $config[$key]
  }
}

$utf8 = [System.Text.UTF8Encoding]::new($false)
[System.IO.File]::WriteAllLines($ProfileFile, $lines, $utf8)

Write-Step 'done. Verify the composed config:'
Write-Host "  dsh --profile $Profile --dump-config" -ForegroundColor DarkGray
if (-not $NoRestart) {
  Write-Host "Then restart the app:  dsh web" -ForegroundColor DarkGray
}
Write-Host "Rollback: Copy-Item -LiteralPath '$backup' -Destination '$ProfileFile' -Force" -ForegroundColor DarkGray

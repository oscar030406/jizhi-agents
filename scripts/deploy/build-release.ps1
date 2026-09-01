param(
  [string]$OutputDir = ''
)

$ErrorActionPreference = 'Continue'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)

Set-Location $repo
$dirty = @(git status --porcelain --untracked-files=all -- . ':(exclude).agents/**')
if ($LASTEXITCODE -ne 0) { throw 'git status failed' }
if ($dirty.Count -ne 0) { throw 'Release sources are dirty or untracked; commit before building a release.' }
$sha = (git rev-parse --short=12 HEAD).Trim()
if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($sha)) { throw 'git rev-parse failed' }
if ([string]::IsNullOrWhiteSpace($OutputDir)) {
  $OutputDir = Join-Path $repo "tmp\deploy\release-$sha"
}
if ((Test-Path -LiteralPath $OutputDir) -and @(Get-ChildItem -LiteralPath $OutputDir -Force).Count -ne 0) {
  throw "Release output must be empty: $OutputDir"
}

$classroom = Join-Path $repo 'apps\classroom'
$engine = Join-Path $repo 'apps\agent-engine'
$sshKey = Join-Path $env:USERPROFILE '.ssh\id_ed25519'
$savedDirectory = Get-Location
$savedEnv = @{}
$envNames = @(
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
  'NEXT_PUBLIC_PERSISTENCE', 'NEXT_PUBLIC_PERSISTENCE_TOKEN'
)
foreach ($name in $envNames) { $savedEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }

try {
  foreach ($name in $envNames[0..5]) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
  $token = (& ssh -i $sshKey -o ConnectTimeout=15 root@118.196.52.57 "grep '^NEXT_PUBLIC_PERSISTENCE_TOKEN=' /root/jizhi-agents/apps/classroom/.env.local | cut -d= -f2-").Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($token)) {
    throw 'Failed to load the production persistence build token.'
  }
  $env:NEXT_PUBLIC_PERSISTENCE = '1'
  $env:NEXT_PUBLIC_PERSISTENCE_TOKEN = $token

  Set-Location $classroom
  & pnpm build
  if ($LASTEXITCODE -ne 0) { throw "Production build failed: $LASTEXITCODE" }
} finally {
  foreach ($name in $envNames) {
    $value = $savedEnv[$name]
    if ($null -eq $value) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($name, $value, 'Process') }
  }
  Set-Location $savedDirectory
}

$buildId = (Get-Content (Join-Path $classroom '.next\BUILD_ID') -Raw).Trim()
New-Item -ItemType Directory -Force -Path $OutputDir | Out-Null
$webPackage = Join-Path $OutputDir "classroom-next-$sha.tgz"
$enginePackage = Join-Path $OutputDir "agent-engine-$sha.tgz"
foreach ($path in @($webPackage, $enginePackage)) {
  if (Test-Path -LiteralPath $path) { Remove-Item -LiteralPath $path -Force }
}

& tar.exe -czf $webPackage --exclude=.next/cache --exclude=.next/dev --exclude=.next/standalone `
  --exclude='*.map' -C $classroom .next
if ($LASTEXITCODE -ne 0) { throw 'Web package creation failed.' }
& tar.exe -czf $enginePackage --exclude='__pycache__' --exclude='*.pyc' -C $engine `
  app backend requirements.txt `
  scripts/build_embedding_index.py `
  scripts/compute_kc_coverage.py `
  scripts/derive_kc_gold.py `
  scripts/po_to_markdown.py `
  scripts/rst_to_markdown.py
if ($LASTEXITCODE -ne 0) { throw 'Engine package creation failed.' }

$deployFiles = @(
  $webPackage,
  $enginePackage,
  (Join-Path $repo 'scripts\deploy\jizhi-engine-hardening.conf'),
  (Join-Path $repo 'scripts\deploy\jizhi-web-hardening.conf'),
  (Join-Path $repo 'scripts\deploy\apply-release.sh')
)
foreach ($source in $deployFiles[2..4]) {
  Copy-Item -LiteralPath $source -Destination $OutputDir -Force
}

& python (Join-Path $repo 'scripts\scan-package-hygiene.py') $webPackage --strict
if ($LASTEXITCODE -ne 0) { throw 'Web package hygiene gate failed.' }
& python (Join-Path $repo 'scripts\scan-package-hygiene.py') $enginePackage --strict
if ($LASTEXITCODE -ne 0) { throw 'Engine package hygiene gate failed.' }

$releaseFiles = Get-ChildItem -LiteralPath $OutputDir -File | Where-Object { $_.Name -ne 'manifest.json' -and $_.Name -ne 'SHA256SUMS' }
$hashes = [ordered]@{}
$sumLines = @()
foreach ($file in $releaseFiles) {
  $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()
  $hashes[$file.Name] = $hash
  $sumLines += "$hash  $($file.Name)"
}
$sumLines | Set-Content -LiteralPath (Join-Path $OutputDir 'SHA256SUMS') -Encoding ASCII

$manifest = [ordered]@{
  schemaVersion = 1
  gitSha = $sha
  buildId = $buildId
  trackedDirty = $false
  createdAt = [DateTime]::UtcNow.ToString('o')
  files = $hashes
}
$manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath (Join-Path $OutputDir 'manifest.json') -Encoding UTF8

Write-Host "RELEASE_SHA=$sha"
Write-Host "BUILD_ID=$buildId"
Write-Host "OUTPUT=$OutputDir"

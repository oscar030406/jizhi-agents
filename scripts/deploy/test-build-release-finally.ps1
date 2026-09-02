$ErrorActionPreference = 'Stop'

$sourceScript = Join-Path $PSScriptRoot 'build-release.ps1'
$base = Join-Path ([IO.Path]::GetTempPath()) "jizhi-build-release-test-$([Guid]::NewGuid().ToString('N'))"
$fixture = Join-Path $base 'repo'
$caller = Join-Path $base 'caller'
$tools = Join-Path $base 'tools'
$output = Join-Path $base 'release-output'
$originalDirectory = Get-Location
$originalPath = $env:PATH
$originalHttpProxy = [Environment]::GetEnvironmentVariable('HTTP_PROXY', 'Process')
$originalPersistence = [Environment]::GetEnvironmentVariable('NEXT_PUBLIC_PERSISTENCE', 'Process')
$originalNextDist = [Environment]::GetEnvironmentVariable('NEXT_DIST_DIR', 'Process')
$originalVercel = [Environment]::GetEnvironmentVariable('VERCEL', 'Process')

function Write-Utf8NoBom([string]$Path, [string]$Content) {
  [IO.File]::WriteAllText($Path, $Content, [Text.UTF8Encoding]::new($false))
}

try {
  $fixtureDirectories = @(
    (Join-Path $fixture 'scripts\deploy'),
    (Join-Path $fixture 'apps\classroom\public'),
    (Join-Path $fixture 'apps\classroom\public\vendor\maic-importer'),
    (Join-Path $fixture 'apps\classroom\node_modules\.pnpm\@img+sharp-linux-x64@fixture\node_modules\@img\sharp-linux-x64\lib'),
    (Join-Path $fixture 'apps\classroom\node_modules\.pnpm\@img+sharp-libvips-linux-x64@fixture\node_modules\@img\sharp-libvips-linux-x64\lib'),
    (Join-Path $fixture 'apps\classroom\node_modules\.pnpm\demo@1\node_modules\demo'),
    (Join-Path $fixture 'apps\classroom\lib\prompts\snippets'),
    (Join-Path $fixture 'apps\classroom\lib\prompts\templates'),
    (Join-Path $fixture 'apps\classroom\lib\pbl\v2\prompts'),
    (Join-Path $fixture 'apps\agent-engine\app'),
    (Join-Path $fixture 'apps\agent-engine\backend'),
    (Join-Path $fixture 'apps\agent-engine\scripts'),
    $tools,
    $caller
  )
  New-Item -ItemType Directory -Force -Path $fixtureDirectories | Out-Null
  Copy-Item -LiteralPath $sourceScript -Destination (Join-Path $fixture 'scripts\deploy\build-release.ps1')
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'apply-release.sh') -Destination (Join-Path $fixture 'scripts\deploy\apply-release.sh')
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'jizhi-engine-hardening.conf') -Destination (Join-Path $fixture 'scripts\deploy\jizhi-engine-hardening.conf')
  Copy-Item -LiteralPath (Join-Path $PSScriptRoot 'jizhi-web-hardening.conf') -Destination (Join-Path $fixture 'scripts\deploy\jizhi-web-hardening.conf')
  Write-Utf8NoBom (Join-Path $fixture '.gitattributes') "*.sh text eol=lf`n"
  Write-Utf8NoBom (Join-Path $fixture '.gitignore') "tmp/`napps/classroom/.next/`napps/classroom/node_modules/`napps/classroom/public/vendor/maic-importer/`napps/classroom/public/agents/.bak-test/`n"
  Write-Utf8NoBom (Join-Path $fixture 'scripts\scan-package-hygiene.py') "raise SystemExit(0)`n"
  Write-Utf8NoBom (Join-Path $fixture 'apps\classroom\public\logo.txt') "public-fixture`n"
  Write-Utf8NoBom (Join-Path $fixture 'apps\classroom\public\vendor\maic-importer\index.js') "generated`n"
  Write-Utf8NoBom (Join-Path $fixture 'apps\classroom\lib\prompts\snippets\fixture.md') "snippet`n"
  Write-Utf8NoBom (Join-Path $fixture 'apps\classroom\lib\prompts\templates\fixture.md') "template`n"
  Write-Utf8NoBom (Join-Path $fixture 'apps\classroom\lib\pbl\v2\prompts\fixture.md') "pbl`n"
  Write-Utf8NoBom (Join-Path $fixture 'apps\classroom\node_modules\.pnpm\demo@1\node_modules\demo\package.json') "{}`n"
  Write-Utf8NoBom (Join-Path $fixture 'apps\classroom\node_modules\.pnpm\@img+sharp-linux-x64@fixture\node_modules\@img\sharp-linux-x64\lib\sharp-linux-x64.node') "linux`n"
  Write-Utf8NoBom (Join-Path $fixture 'apps\classroom\node_modules\.pnpm\@img+sharp-libvips-linux-x64@fixture\node_modules\@img\sharp-libvips-linux-x64\lib\libvips-cpp.so.8') "linux`n"
  foreach ($path in @(
    'apps\agent-engine\app\main.py',
    'apps\agent-engine\backend\__init__.py',
    'apps\agent-engine\requirements.txt',
    'apps\agent-engine\requirements.production.txt',
    'apps\agent-engine\requirements.production.lock',
    'apps\agent-engine\scripts\build_embedding_index.py',
    'apps\agent-engine\scripts\compute_kc_coverage.py',
    'apps\agent-engine\scripts\derive_kc_gold.py',
    'apps\agent-engine\scripts\po_to_markdown.py',
    'apps\agent-engine\scripts\rst_to_markdown.py'
  )) {
    Write-Utf8NoBom (Join-Path $fixture $path) "# fixture`n"
  }

  $fakeBuild = Join-Path $tools 'fake-build.ps1'
  $fakeBuildBody = @'
$ErrorActionPreference = 'Stop'
$classroom = (Get-Location).Path
if ($env:NEXT_DIST_DIR -or $env:VERCEL) { exit 92 }
$standalone = Join-Path $classroom '.next\standalone'
New-Item -ItemType Directory -Force -Path @(
  (Join-Path $classroom '.next\static'),
  (Join-Path $standalone '.next\static'),
  (Join-Path $standalone 'data'),
  (Join-Path $standalone 'node_modules\.pnpm\@img+sharp-linux-x64@fixture\node_modules\@img\sharp-linux-x64\lib'),
  (Join-Path $standalone 'node_modules\.pnpm\@img+sharp-libvips-linux-x64@fixture\node_modules\@img\sharp-libvips-linux-x64\lib'),
  (Join-Path $standalone 'node_modules\.pnpm\demo@1\node_modules\demo'),
  (Join-Path $standalone 'node_modules')
) | Out-Null
[IO.File]::WriteAllText((Join-Path $classroom '.next\BUILD_ID'), 'fixture-build-id')
[IO.File]::WriteAllText((Join-Path $standalone '.next\BUILD_ID'), 'fixture-build-id')
[IO.File]::WriteAllText((Join-Path $standalone '.next\static\app.js'), 'static')
[IO.File]::WriteAllText((Join-Path $classroom '.next\static\app.js'), 'static')
[IO.File]::WriteAllText((Join-Path $standalone 'server.js'), 'setInterval(() => {}, 1000)')
[IO.File]::WriteAllText((Join-Path $standalone 'package.json'), '{}')
[IO.File]::WriteAllText((Join-Path $standalone 'data\sentinel'), 'must-not-ship')
[IO.File]::WriteAllText((Join-Path $standalone 'node_modules\.pnpm\@img+sharp-linux-x64@fixture\node_modules\@img\sharp-linux-x64\lib\sharp-linux-x64.node'), 'linux')
[IO.File]::WriteAllText((Join-Path $standalone 'node_modules\.pnpm\@img+sharp-libvips-linux-x64@fixture\node_modules\@img\sharp-libvips-linux-x64\lib\libvips-cpp.so.8'), 'linux')
[IO.File]::WriteAllText((Join-Path $standalone 'node_modules\.pnpm\demo@1\node_modules\demo\package.json'), '{}')
$sourceDemo = Join-Path $classroom 'node_modules\.pnpm\demo@1\node_modules\demo'
New-Item -ItemType Junction -Path (Join-Path $standalone 'node_modules\demo') -Target $sourceDemo | Out-Null
'@
  Write-Utf8NoBom $fakeBuild $fakeBuildBody
  Write-Utf8NoBom (Join-Path $tools 'pnpm.cmd') "@echo off`r`nexit /b 91`r`n"

  $ErrorActionPreference = 'Continue'
  git init --quiet $fixture
  if ($LASTEXITCODE -ne 0) { throw 'fixture git init failed' }
  Set-Location $fixture
  git config user.name release-test
  git config user.email release-test@example.invalid
  git add .
  git commit --quiet -m fixture
  if ($LASTEXITCODE -ne 0) { throw 'fixture git commit failed' }
  $ErrorActionPreference = 'Stop'

  Set-Location $caller
  $env:PATH = "$tools;$originalPath"
  $env:HTTP_PROXY = 'fixture-http-proxy'
  $env:NEXT_PUBLIC_PERSISTENCE = 'fixture-persistence'
  $env:NEXT_DIST_DIR = '.next-stale-caller-value'
  $env:VERCEL = '1'
  $failure = ''
  try {
    & (Join-Path $fixture 'scripts\deploy\build-release.ps1')
  } catch {
    $failure = $_.Exception.Message
  }
  if ($failure -notmatch 'Production build failed: 91') { throw "unexpected build failure: $failure" }
  if ((Get-Location).Path -ne $caller) { throw 'build script did not restore the caller directory' }
  if ($env:HTTP_PROXY -ne 'fixture-http-proxy') { throw 'build script did not restore HTTP_PROXY' }
  if ($env:NEXT_PUBLIC_PERSISTENCE -ne 'fixture-persistence') { throw 'build script did not restore NEXT_PUBLIC_PERSISTENCE' }
  if ($env:NEXT_DIST_DIR -ne '.next-stale-caller-value') { throw 'build script did not restore NEXT_DIST_DIR' }
  if ($env:VERCEL -ne '1') { throw 'build script did not restore VERCEL' }
  if (@(Get-ChildItem -LiteralPath (Join-Path $fixture 'tmp\deploy') -Directory -Filter '.release-build-*').Count -ne 0) {
    throw 'build script left a temporary release directory after failure'
  }

  $pnpmSuccess = "@echo off`r`npowershell -NoProfile -ExecutionPolicy Bypass -File `"$fakeBuild`"`r`nexit /b %ERRORLEVEL%`r`n"
  Write-Utf8NoBom (Join-Path $tools 'pnpm.cmd') $pnpmSuccess

  $ignoredBackup = Join-Path $fixture 'apps\classroom\public\agents\.bak-test'
  New-Item -ItemType Directory -Force -Path $ignoredBackup | Out-Null
  Write-Utf8NoBom (Join-Path $ignoredBackup 'old.png') 'backup'
  $pollutionFailure = ''
  try {
    & (Join-Path $fixture 'scripts\deploy\build-release.ps1') -OutputDir $output
  } catch {
    $pollutionFailure = $_.Exception.Message
  }
  if ($pollutionFailure -notmatch 'Ignored public content would be packaged') {
    throw "ignored public pollution was not rejected: $pollutionFailure"
  }
  Remove-Item -LiteralPath $ignoredBackup -Recurse -Force
  New-Item -ItemType Directory -Force -Path (Join-Path $fixture 'apps\classroom\.next') | Out-Null
  Write-Utf8NoBom (Join-Path $fixture 'apps\classroom\.next\BUILD_ID') 'stale-build-id'

  & (Join-Path $fixture 'scripts\deploy\build-release.ps1') -OutputDir $output
  if (-not (Test-Path -LiteralPath $output -PathType Container)) { throw 'release output was not created' }
  $manifest = Get-Content -LiteralPath (Join-Path $output 'manifest.json') -Raw | ConvertFrom-Json
  if ($manifest.schemaVersion -ne 4 -or $manifest.webLayout -ne 'next-standalone-v1') {
    throw 'release manifest does not declare the standalone layout'
  }
  if ($manifest.buildId -ne 'fixture-build-id') { throw 'release manifest reused a stale BUILD_ID' }
  $outputNames = @(Get-ChildItem -LiteralPath $output -File -Force | ForEach-Object Name | Sort-Object)
  $sha = $manifest.gitSha
  $expectedOutputNames = @(
    'SHA256SUMS',
    "agent-engine-$sha.tgz",
    'apply-release.sh',
    "classroom-next-$sha.tgz",
    'jizhi-engine-hardening.conf',
    'jizhi-web-hardening.conf',
    'manifest.json'
  ) | Sort-Object
  if (@(Compare-Object $expectedOutputNames $outputNames).Count -ne 0) {
    throw "release output file set mismatch: $($outputNames -join ', ')"
  }
  $webArchive = Get-ChildItem -LiteralPath $output -Filter 'classroom-next-*.tgz' -File | Select-Object -First 1
  if ($null -eq $webArchive) { throw 'web archive missing' }
  $listing = @(& tar.exe -tzf $webArchive.FullName | ForEach-Object { $_ -replace '^\./', '' })
  foreach ($required in @(
    'server.js', 'start-standalone.mjs', '.next/BUILD_ID', '.next/static/app.js',
    'public/logo.txt', 'public/vendor/maic-importer/index.js'
  )) {
    if ($listing -notcontains $required) { throw "standalone archive missing $required" }
  }
  if ($listing -contains 'data/sentinel') { throw 'standalone archive leaked mutable fixture data' }
  if ($listing | Where-Object { $_ -like '*.next/standalone*' }) { throw 'standalone archive was not flattened' }
  if (-not ($listing | Where-Object { $_ -like '*@img+sharp-linux-x64@fixture*' })) { throw 'Linux sharp missing from archive' }
  if (-not ($listing | Where-Object { $_ -like '*@img+sharp-libvips-linux-x64@fixture*' })) { throw 'Linux libvips missing from archive' }
  $verboseListing = (& tar.exe -tvzf $webArchive.FullName) -join "`n"
  if ($verboseListing -match '[A-Za-z]:[/\\]') { throw 'archive contains a build-machine absolute link' }
  if ($listing -notcontains 'node_modules/demo' -and $listing -notcontains 'node_modules/demo/package.json') {
    throw 'archive did not carry the fixture dependency without an absolute link'
  }
  $wrapper = (& tar.exe -xOzf $webArchive.FullName 'start-standalone.mjs') -join "`n"
  if ($wrapper -notmatch "import\('./server\.js'\)" -or $wrapper -match '/root/jizhi-agents') {
    throw 'standalone startup wrapper is invalid'
  }
  & tar.exe -xzf $webArchive.FullName -C $base start-standalone.mjs server.js
  if ($LASTEXITCODE -ne 0) { throw 'failed to extract standalone entrypoints for syntax validation' }
  & node --check (Join-Path $base 'start-standalone.mjs')
  if ($LASTEXITCODE -ne 0) { throw 'standalone startup wrapper syntax check failed' }
  & node --check (Join-Path $base 'server.js')
  if ($LASTEXITCODE -ne 0) { throw 'standalone server syntax check failed' }
  & (Join-Path $env:SystemRoot 'System32\certutil.exe') -hashfile (Join-Path $output 'SHA256SUMS') SHA256 | Out-Null

  Write-Host 'build release failure/package self-check: ok'
} finally {
  $env:PATH = $originalPath
  if ($null -eq $originalHttpProxy) { Remove-Item Env:HTTP_PROXY -ErrorAction SilentlyContinue }
  else { [Environment]::SetEnvironmentVariable('HTTP_PROXY', $originalHttpProxy, 'Process') }
  if ($null -eq $originalPersistence) { Remove-Item Env:NEXT_PUBLIC_PERSISTENCE -ErrorAction SilentlyContinue }
  else { [Environment]::SetEnvironmentVariable('NEXT_PUBLIC_PERSISTENCE', $originalPersistence, 'Process') }
  if ($null -eq $originalNextDist) { Remove-Item Env:NEXT_DIST_DIR -ErrorAction SilentlyContinue }
  else { [Environment]::SetEnvironmentVariable('NEXT_DIST_DIR', $originalNextDist, 'Process') }
  if ($null -eq $originalVercel) { Remove-Item Env:VERCEL -ErrorAction SilentlyContinue }
  else { [Environment]::SetEnvironmentVariable('VERCEL', $originalVercel, 'Process') }
  Set-Location $originalDirectory
  $resolvedBase = [IO.Path]::GetFullPath($base)
  $tempRoot = [IO.Path]::GetFullPath([IO.Path]::GetTempPath())
  if (-not $resolvedBase.StartsWith($tempRoot, [StringComparison]::OrdinalIgnoreCase)) {
    throw "Refusing to remove unexpected test directory: $resolvedBase"
  }
  if (Test-Path -LiteralPath $resolvedBase) { Remove-Item -LiteralPath $resolvedBase -Recurse -Force }
}

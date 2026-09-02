param(
  [string]$OutputDir = ''
)

$ErrorActionPreference = 'Stop'
$repo = Split-Path -Parent (Split-Path -Parent $PSScriptRoot)
$deployRoot = Join-Path $repo 'tmp\deploy'
$classroom = Join-Path $repo 'apps\classroom'
$engine = Join-Path $repo 'apps\agent-engine'
$savedDirectory = Get-Location
$workDir = ''
$savedEnv = @{}
$envNames = @(
  'HTTP_PROXY', 'HTTPS_PROXY', 'ALL_PROXY', 'http_proxy', 'https_proxy', 'all_proxy',
  'NEXT_PUBLIC_PERSISTENCE', 'NEXT_DIST_DIR', 'VERCEL'
)
foreach ($name in $envNames) { $savedEnv[$name] = [Environment]::GetEnvironmentVariable($name, 'Process') }

function Assert-LfFile([string]$Path) {
  $bytes = [IO.File]::ReadAllBytes($Path)
  if ([Array]::IndexOf($bytes, [byte]13) -ge 0) {
    throw "Shell file contains CR bytes; LF is required: $Path"
  }
}

function Test-NativePackageFile([string]$Store, [string]$PackagePattern, [string]$FilePattern) {
  foreach ($package in @(Get-ChildItem -LiteralPath $Store -Directory -Filter $PackagePattern -ErrorAction SilentlyContinue)) {
    if (@(Get-ChildItem -LiteralPath $package.FullName -Recurse -File -Filter $FilePattern -ErrorAction SilentlyContinue).Count -gt 0) {
      return $true
    }
  }
  return $false
}

function Assert-PublicIgnoredClean {
  $ignored = @(git ls-files --others --ignored --exclude-standard -- apps/classroom/public)
  if ($LASTEXITCODE -ne 0) { throw 'git ignored-file scan failed' }
  $generatedPrefix = 'apps/classroom/public/vendor/maic-importer/'
  $unexpected = @($ignored | Where-Object { -not $_.StartsWith($generatedPrefix, [StringComparison]::Ordinal) })
  if ($unexpected.Count -ne 0) {
    throw "Ignored public content would be packaged: $($unexpected -join ', ')"
  }
}

try {
  Set-Location $repo
  $ErrorActionPreference = 'Continue'
  $dirty = @(git status --porcelain --untracked-files=all -- . ':(exclude).agents/**')
  if ($LASTEXITCODE -ne 0) { throw 'git status failed' }
  $sha = (git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($sha)) { throw 'git rev-parse failed' }
  $committedAt = (git show -s --format=%cI $sha).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($committedAt)) { throw 'git show failed' }
  $ErrorActionPreference = 'Stop'
  if ($dirty.Count -ne 0) { throw 'Release sources are dirty or untracked; commit before building a release.' }
  Assert-PublicIgnoredClean

  Get-ChildItem -LiteralPath (Join-Path $repo 'scripts\deploy') -Filter '*.sh' -File |
    ForEach-Object { Assert-LfFile $_.FullName }

  $workDir = Join-Path $deployRoot ".release-build-$sha-$([Guid]::NewGuid().ToString('N'))"
  New-Item -ItemType Directory -Force -Path $workDir | Out-Null

  # Windows 只会默认安装本机 optionalDependency；standalone 部署目标是 Linux。
  # pnpm --force 会按 lockfile 补齐不符合当前 OS/CPU 的 optionalDependency，随后
  # Next 的 output-file-tracing 才能把 Linux sharp/libvips 一并收进不可变 release。
  $pnpmStore = Join-Path $classroom 'node_modules\.pnpm'
  $linuxNativeReady =
    (Test-NativePackageFile $pnpmStore '@img+sharp-linux-x64@*' 'sharp-linux-x64.node') -and
    (Test-NativePackageFile $pnpmStore '@img+sharp-libvips-linux-x64@*' 'libvips-cpp.so.*')
  if (-not $linuxNativeReady) {
    Set-Location $classroom
    & pnpm install --frozen-lockfile --force
    if ($LASTEXITCODE -ne 0) { throw "Cross-platform dependency install failed: $LASTEXITCODE" }
  }

  foreach ($name in $envNames) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
  $env:NEXT_PUBLIC_PERSISTENCE = '1'

  Set-Location $classroom
  $nextOutput = Join-Path $classroom '.next'
  if (Test-Path -LiteralPath $nextOutput) { Remove-Item -LiteralPath $nextOutput -Recurse -Force }
  & pnpm build
  if ($LASTEXITCODE -ne 0) { throw "Production build failed: $LASTEXITCODE" }
  Set-Location $repo
  Assert-PublicIgnoredClean
  Set-Location $classroom

  $buildId = (Get-Content (Join-Path $classroom '.next\BUILD_ID') -Raw).Trim()
  if ([string]::IsNullOrWhiteSpace($buildId)) { throw 'Production build did not produce a BUILD_ID.' }
  $standalone = Join-Path $classroom '.next\standalone'
  if (-not (Test-Path -LiteralPath (Join-Path $standalone 'server.js') -PathType Leaf)) {
    throw 'Production build did not produce .next/standalone/server.js.'
  }
  $webPackage = Join-Path $workDir "classroom-next-$sha.tgz"
  $enginePackage = Join-Path $workDir "agent-engine-$sha.tgz"

  $standaloneStore = Join-Path $standalone 'node_modules\.pnpm'
  foreach ($requirement in @(
    @('@img+sharp-linux-x64@*', 'sharp-linux-x64.node'),
    @('@img+sharp-libvips-linux-x64@*', 'libvips-cpp.so.*')
  )) {
    if (-not (Test-NativePackageFile $standaloneStore $requirement[0] $requirement[1])) {
      throw "Standalone release is missing Linux native dependency: $($requirement[0])/$($requirement[1])"
    }
  }

  $startupWrapper = @'
import http from 'node:http';

const requestTimeout = Number(process.env.UPLOAD_REQUEST_TIMEOUT_MS || 1_800_000);
if (!Number.isFinite(requestTimeout) || requestTimeout <= 0) {
  throw new Error('UPLOAD_REQUEST_TIMEOUT_MS must be a positive number');
}
const createServer = http.createServer;
http.createServer = function createServerWithUploadTimeout(...args) {
  const server = createServer.apply(this, args);
  server.requestTimeout = requestTimeout;
  server.headersTimeout = Math.min(120_000, requestTimeout);
  return server;
};
process.env.HOSTNAME ||= '127.0.0.1';
process.env.PORT ||= '3210';
await import('./server.js');
'@
  [IO.File]::WriteAllText(
    (Join-Path $workDir 'start-standalone.mjs'),
    $startupWrapper,
    [Text.UTF8Encoding]::new($false)
  )
  # Python tarfile lets us rewrite build-machine absolute pnpm links in archive metadata
  # without creating privileged Windows symlinks or dereferencing the dependency graph.
  $packageScript = Join-Path $workDir 'package-standalone.py'
  $packageSource = @'
import datetime
import os
import posixpath
import sys
import tarfile

standalone, app_root, static_root, public_root, wrapper, output, committed_at = sys.argv[1:]
standalone = os.path.abspath(standalone)
app_root = os.path.abspath(app_root)
epoch = int(datetime.datetime.fromisoformat(committed_at.replace("Z", "+00:00")).timestamp())
added = set()

def inside(base, value):
    try:
        return os.path.commonpath([base, value]) == base
    except ValueError:
        return False

def excluded(name):
    return (
        name == "data" or name.startswith("data/") or
        name == "public" or name.startswith("public/") or
        name == ".next/static" or name.startswith(".next/static/") or
        name == ".next/cache" or name.startswith(".next/cache/") or
        name.endswith(".map")
    )

def normalize(info):
    info.uid = info.gid = 0
    info.uname = info.gname = "root"
    info.mtime = epoch
    if info.isdir():
        info.mode = 0o755
    elif info.issym():
        info.mode = 0o777
    else:
        info.mode = (info.mode & 0o755) or 0o644
        info.mode &= ~0o022
    return info

def add_path(handle, source, arcname, source_base, rewrite_links):
    arcname = arcname.replace(os.sep, "/").strip("/")
    if not arcname or (rewrite_links and excluded(arcname)) or arcname in added:
        return
    info = handle.gettarinfo(source, arcname)
    # pnpm's content-addressable store uses NTFS hardlinks. Archive them as regular
    # files so their linkname never points to an un-packaged build-machine path.
    if info.islnk():
        info.type = tarfile.REGTYPE
        info.linkname = ""
        info.size = os.stat(source).st_size
    info = normalize(info)
    added.add(arcname)
    if info.issym() and rewrite_links:
        target = os.path.realpath(source)
        if inside(standalone, target):
            target_arc = os.path.relpath(target, standalone).replace(os.sep, "/")
        elif inside(app_root, target):
            target_arc = os.path.relpath(target, app_root).replace(os.sep, "/")
        else:
            raise SystemExit(f"standalone link escapes build roots: {source}")
        if excluded(target_arc):
            raise SystemExit(f"standalone link targets excluded mutable content: {source} -> {target_arc}")
        # Next on Windows may trace the symlink but omit its .pnpm target because the
        # absolute build-machine link was resolvable during build. Close that graph here.
        if target_arc not in added:
            if not os.path.lexists(target):
                raise SystemExit(f"standalone link target is missing: {source} -> {target}")
            add_path(handle, target, target_arc, app_root, True)
        if target_arc not in added:
            raise SystemExit(f"standalone link target was not packaged: {source} -> {target_arc}")
        info.linkname = posixpath.relpath(target_arc, posixpath.dirname(arcname) or ".")
        handle.addfile(info)
        return
    if info.isdir():
        handle.addfile(info)
        for entry in sorted(os.scandir(source), key=lambda item: item.name):
            add_path(handle, entry.path, f"{arcname}/{entry.name}", source_base, rewrite_links)
        return
    if info.isfile():
        with open(source, "rb") as stream:
            handle.addfile(info, stream)
        return
    raise SystemExit(f"unsupported standalone entry: {source}")

def add_empty_dir(handle, arcname):
    info = tarfile.TarInfo(arcname)
    info.type = tarfile.DIRTYPE
    normalize(info)
    added.add(arcname)
    handle.addfile(info)

with tarfile.open(output, "w:gz", compresslevel=9) as handle:
    # Next's Windows trace over-includes the whole source tree because several runtime
    # readers use process.cwd(). Ship only the executable closure plus the exact prompt
    # assets those readers open; dependency symlinks recursively pull their own targets.
    for name in (".next", "node_modules", "package.json", "server.js"):
        source = os.path.join(standalone, name)
        if not os.path.lexists(source):
            raise SystemExit(f"standalone root entry is missing: {name}")
        add_path(handle, source, name, standalone, True)
    for relative_asset in (
        "lib/prompts/snippets",
        "lib/prompts/templates",
        "lib/pbl/v2/prompts",
    ):
        source = os.path.join(app_root, *relative_asset.split("/"))
        add_path(handle, source, relative_asset, app_root, False)
    add_path(handle, static_root, ".next/static", static_root, False)
    add_path(handle, public_root, "public", public_root, False)
    add_path(handle, wrapper, "start-standalone.mjs", os.path.dirname(wrapper), False)
    add_empty_dir(handle, "data")
    add_empty_dir(handle, ".next/cache")
'@
  [IO.File]::WriteAllText($packageScript, $packageSource, [Text.UTF8Encoding]::new($false))
  & python $packageScript $standalone $classroom (Join-Path $classroom '.next\static') `
    (Join-Path $classroom 'public') (Join-Path $workDir 'start-standalone.mjs') `
    $webPackage $committedAt
  if ($LASTEXITCODE -ne 0) { throw 'Web standalone package creation failed.' }
  & tar.exe -czf $enginePackage --exclude='__pycache__' --exclude='*.pyc' -C $engine `
    app backend requirements.txt requirements.production.txt requirements.production.lock `
    scripts/build_embedding_index.py `
    scripts/compute_kc_coverage.py `
    scripts/derive_kc_gold.py `
    scripts/po_to_markdown.py `
    scripts/rst_to_markdown.py
  if ($LASTEXITCODE -ne 0) { throw 'Engine package creation failed.' }
  Remove-Item -LiteralPath $packageScript, (Join-Path $workDir 'start-standalone.mjs') -Force

  foreach ($source in @(
    (Join-Path $repo 'scripts\deploy\jizhi-engine-hardening.conf'),
    (Join-Path $repo 'scripts\deploy\jizhi-web-hardening.conf'),
    (Join-Path $repo 'scripts\deploy\apply-release.sh')
  )) {
    Copy-Item -LiteralPath $source -Destination $workDir -Force
  }

  & python (Join-Path $repo 'scripts\scan-package-hygiene.py') $webPackage --strict
  if ($LASTEXITCODE -ne 0) { throw 'Web package hygiene gate failed.' }
  & python (Join-Path $repo 'scripts\scan-package-hygiene.py') $enginePackage --strict
  if ($LASTEXITCODE -ne 0) { throw 'Engine package hygiene gate failed.' }

  Set-Location $repo
  $ErrorActionPreference = 'Continue'
  $finalDirty = @(git status --porcelain --untracked-files=all -- . ':(exclude).agents/**')
  if ($LASTEXITCODE -ne 0) { throw 'final git status failed' }
  $finalSha = (git rev-parse HEAD).Trim()
  if ($LASTEXITCODE -ne 0 -or [string]::IsNullOrWhiteSpace($finalSha)) { throw 'final git rev-parse failed' }
  $ErrorActionPreference = 'Stop'
  if ($finalSha -ne $sha -or $finalDirty.Count -ne 0) {
    $dirtySummary = if ($finalDirty.Count -eq 0) { 'clean' } else { $finalDirty -join '; ' }
    throw "Release sources changed while the build was running: initial=$sha final=$finalSha dirty=$dirtySummary"
  }

  $payloadFiles = Get-ChildItem -LiteralPath $workDir -File | Sort-Object Name
  $payloadHashes = [ordered]@{}
  foreach ($file in $payloadFiles) {
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()
    $payloadHashes[$file.Name] = $hash
  }
  $manifest = [ordered]@{
    schemaVersion = 4
    webLayout = 'next-standalone-v1'
    gitSha = $sha
    buildId = $buildId
    trackedDirty = $false
    createdAt = $committedAt
    files = $payloadHashes
  }
  $manifestPath = Join-Path $workDir 'manifest.json'
  $manifest | ConvertTo-Json -Depth 4 | Set-Content -LiteralPath $manifestPath -Encoding UTF8

  $releaseFiles = Get-ChildItem -LiteralPath $workDir -File | Sort-Object Name
  $releaseHashes = [ordered]@{}
  $sumLines = @()
  foreach ($file in $releaseFiles) {
    $hash = (Get-FileHash -Algorithm SHA256 -LiteralPath $file.FullName).Hash.ToLowerInvariant()
    $releaseHashes[$file.Name] = $hash
    $sumLines += "$hash  $($file.Name)"
  }
  $sumsPath = Join-Path $workDir 'SHA256SUMS'
  $sumLines | Set-Content -LiteralPath $sumsPath -Encoding ASCII
  $packageHash = (Get-FileHash -Algorithm SHA256 -LiteralPath $sumsPath).Hash.ToLowerInvariant()
  $releaseId = "$sha-$($packageHash.Substring(0, 12))"

  $finalDir = if ([string]::IsNullOrWhiteSpace($OutputDir)) {
    Join-Path $deployRoot "release-$releaseId"
  } else {
    if ([IO.Path]::IsPathRooted($OutputDir)) { [IO.Path]::GetFullPath($OutputDir) }
    else { [IO.Path]::GetFullPath((Join-Path $repo $OutputDir)) }
  }
  if (Test-Path -LiteralPath $finalDir) {
    $existingSums = (Get-Content (Join-Path $finalDir 'SHA256SUMS') -Raw).Trim()
    $newSums = (Get-Content $sumsPath -Raw).Trim()
    $existingNames = @(Get-ChildItem -LiteralPath $finalDir -File -Force | ForEach-Object Name | Sort-Object)
    $expectedNames = @($releaseHashes.Keys) + 'SHA256SUMS' | Sort-Object
    $nameDifference = @(Compare-Object $expectedNames $existingNames)
    if ($existingSums -ne $newSums -or $nameDifference.Count -ne 0 -or
      @(Get-ChildItem -LiteralPath $finalDir -Directory -Force).Count -ne 0) {
      throw "Release output exists with different contents: $finalDir"
    }
    foreach ($name in $releaseHashes.Keys) {
      $existingHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $finalDir $name)).Hash.ToLowerInvariant()
      if ($existingHash -ne $releaseHashes[$name]) {
        throw "Release output exists with different contents: $finalDir"
      }
    }
  } else {
    Move-Item -LiteralPath $workDir -Destination $finalDir
  }

  Write-Host "RELEASE_SHA=$sha"
  Write-Host "RELEASE_ID=$releaseId"
  Write-Host "BUILD_ID=$buildId"
  Write-Host "OUTPUT=$finalDir"
} finally {
  foreach ($name in $envNames) {
    $value = $savedEnv[$name]
    if ($null -eq $value) { Remove-Item "Env:$name" -ErrorAction SilentlyContinue }
    else { [Environment]::SetEnvironmentVariable($name, $value, 'Process') }
  }
  Set-Location $savedDirectory
  if (-not [string]::IsNullOrWhiteSpace($workDir) -and (Test-Path -LiteralPath $workDir)) {
    $resolvedWork = [IO.Path]::GetFullPath($workDir)
    $resolvedDeploy = [IO.Path]::GetFullPath($deployRoot) + [IO.Path]::DirectorySeparatorChar
    if (-not $resolvedWork.StartsWith($resolvedDeploy, [StringComparison]::OrdinalIgnoreCase)) {
      throw "Refusing to remove unexpected work directory: $resolvedWork"
    }
    Remove-Item -LiteralPath $resolvedWork -Recurse -Force
  }
}

# 停掉 start-local.ps1 起的那两个服务，按 .local-pids.json 里记的 PID 停，
# 连同它们派生的子进程（cmd -> pnpm -> node 这条链）。不按进程名杀：这台机器上
# 同时还有别的 node / python 在跑。
#
# 用法：
#   .\experiments\scheduling\stop-local.ps1            # 两个都停
#   .\experiments\scheduling\stop-local.ps1 -Only classroom

param([ValidateSet('all', 'engine', 'classroom')][string]$Only = 'all')

$ErrorActionPreference = 'Continue'
$pidFile = Join-Path $PSScriptRoot '.local-pids.json'
if (-not (Test-Path $pidFile)) {
    Write-Host "没有 $pidFile，没什么可停的" -ForegroundColor Yellow
    exit 0
}
$pids = Get-Content $pidFile -Raw | ConvertFrom-Json

function Stop-Tree($rootPid, $label) {
    if (-not $rootPid) { return }
    $targets = New-Object System.Collections.Generic.List[int]
    $frontier = New-Object System.Collections.Generic.List[int]
    $frontier.Add([int]$rootPid)
    while ($frontier.Count -gt 0) {
        $current = $frontier[0]; $frontier.RemoveAt(0)
        $targets.Add($current)
        Get-CimInstance Win32_Process -Filter "ParentProcessId=$current" -ErrorAction SilentlyContinue |
            ForEach-Object { $frontier.Add([int]$_.ProcessId) }
    }
    # 先停子后停父，免得父进程一走子进程被接管就找不着了
    [array]::Reverse($targets)
    foreach ($target in $targets) {
        try {
            Stop-Process -Id $target -Force -ErrorAction Stop
            Write-Host "[停止] $label pid=$target" -ForegroundColor Green
        } catch {
            Write-Host "[跳过] $label pid=$target（已经不在了）" -ForegroundColor Yellow
        }
    }
}

if ($Only -in @('all', 'classroom')) { Stop-Tree $pids.classroom 'classroom' }
if ($Only -in @('all', 'engine')) { Stop-Tree $pids.engine 'engine' }

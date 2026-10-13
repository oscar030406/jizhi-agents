# 六个 cell 一个接一个跑完，每跑完一个就地汇总、归档、比对模拟器。
#
# 引擎只起一次，课堂每个 cell 重起一次（调度参数是进程启动时读的环境变量）。
# 一个 cell 的产物在它跑完的当场就落到论文仓，所以中途崩最多丢一个 cell。
#
# 用法：
#   .\experiments\scheduling\run-all.ps1
#   .\experiments\scheduling\run-all.ps1 -Only full-guard-completed-r2   # 只跑一个
#
# 收工用 stop-local.ps1。

param(
    [string]$Only = '',
    [int]$Jobs = 100,
    [int]$Users = 20,
    [int]$MaxSeconds = 4200,
    [string]$PaperRecords = 'D:\UserData\Desktop\图神经网络\prechecks\platform_testbed\records',
    [string]$PaperRoot = 'D:\UserData\Desktop\图神经网络'
)

$ErrorActionPreference = 'Continue'
$here = $PSScriptRoot
$root = Split-Path (Split-Path $here -Parent) -Parent
$records = Join-Path $here 'records'
New-Item -ItemType Directory -Force -Path $records, $PaperRecords | Out-Null

# 全部 cell 共用的一组参数：k=2，承诺 G=400 s，上限 L=170 s（带练）/25 s（蓝图），
# 预算形状取论文物理实验用过的那一档（B0=30 s, eta=0.5, gamma=0）。
# 作业类顺序固定，六个 cell 的同一个位置是同一类。
$PATTERN = 'guide,guide,blueprint,blueprint,blueprint,blueprint,blueprint,blueprint'
$SEED = 20260923
$ARRIVALS = Join-Path $here 'arrivals_deadline_burst_100.csv'

$cells = @(
    @{ name = 'full-fcfs-r2';                policy = 'fcfs';  charging = 'completed';   think = 'independent'; slope = 0 }
    @{ name = 'full-spjf-r2';                policy = 'spjf';  charging = 'completed';   think = 'independent'; slope = 0 }
    @{ name = 'full-guard-completed-r2';     policy = 'guard'; charging = 'completed';   think = 'independent'; slope = 0 }
    @{ name = 'full-guard-reservation-r2';   policy = 'guard'; charging = 'reservation'; think = 'independent'; slope = 0 }
    @{ name = 'full-guard-completed-r1open'; policy = 'guard'; charging = 'completed';   think = 'open';        slope = 0 }
    @{ name = 'full-guard-completed-r3';     policy = 'guard'; charging = 'completed';   think = 'wait-scaled'; slope = 0.5 }
)
if ($Only) { $cells = $cells | Where-Object { $_.name -eq $Only } }
if (-not $cells) { Write-Host "[错误] 没有匹配的 cell：$Only" -ForegroundColor Red; exit 1 }

function Wait-Ready([int]$seconds) {
    $deadline = (Get-Date).AddSeconds($seconds)
    while ((Get-Date) -lt $deadline) {
        try {
            $a = Invoke-WebRequest -Uri 'http://127.0.0.1:8001/health' -TimeoutSec 5 -UseBasicParsing
            $b = Invoke-WebRequest -Uri 'http://127.0.0.1:3210/api/health' -TimeoutSec 10 -UseBasicParsing
            if ($a.StatusCode -eq 200 -and $b.StatusCode -eq 200) { return $true }
        } catch { }
        Start-Sleep -Seconds 5
    }
    return $false
}

function Warm-Routes {
    # 先用两个必然被参数校验挡下来的请求把路由编译出来，不花模型钱
    foreach ($path in '/api/practice-guide', '/api/adaptive/blueprint') {
        try {
            Invoke-WebRequest -Uri "http://127.0.0.1:3210$path" -Method Post -Body '{}' `
                -ContentType 'application/json' -TimeoutSec 120 -UseBasicParsing | Out-Null
        } catch { }
    }
}

function Invoke-PaperPython([string[]]$scriptArgs) {
    # 与 CLAUDE.md 里那条 env -u 的写法等价：uv 的 trampoline 会把 PYTHONHOME 传给子进程，
    # 不清掉的话 venv 里的 python 会去加载错的标准库。
    $saved = @{}
    foreach ($name in 'PYTHONHOME', 'PYTHONPATH', 'UV_INTERNAL__PYTHONHOME') {
        $saved[$name] = [System.Environment]::GetEnvironmentVariable($name)
        [System.Environment]::SetEnvironmentVariable($name, $null)
    }
    Push-Location $PaperRoot
    try {
        & uv run --no-sync python @scriptArgs
    } finally {
        Pop-Location
        foreach ($name in $saved.Keys) { [System.Environment]::SetEnvironmentVariable($name, $saved[$name]) }
    }
}

$engineLog = Join-Path $records 'engine.err.log'
$overall = [System.Diagnostics.Stopwatch]::StartNew()
$done = @()

foreach ($cell in $cells) {
    $name = $cell.name
    $attempt = 0
    $ok = $false

    while (-not $ok -and $attempt -lt 2) {
        $attempt += 1
        Write-Host "`n=== $name 第 $attempt 次 ===" -ForegroundColor Cyan

        # 上一次的残留先清掉，免得重试把两次的行混在一起
        foreach ($stale in "jobs-$name.jsonl", "decisions-$name.jsonl", "client-$name.jsonl", "manifest-$name.json") {
            Remove-Item -Force (Join-Path $records $stale) -ErrorAction SilentlyContinue
        }

        & (Join-Path $here 'stop-local.ps1') -Only classroom | Out-Null
        Start-Sleep -Seconds 4
        & (Join-Path $here 'start-local.ps1') -K 2 -Policy $cell.policy -Charging $cell.charging `
            -ScoreMode proxy -LimitMs 170000 -PromiseMs 400000 -B0Ms 30000 -Eta 0.5 -Cell $name

        if (-not (Wait-Ready 180)) {
            Write-Host "[失败] $name 服务没起来" -ForegroundColor Red
            continue
        }
        Warm-Routes

        $engineOffset = if (Test-Path $engineLog) { (Get-Item $engineLog).Length } else { 0 }

        $genArgs = @(
            (Join-Path $here 'run-cell.mjs'),
            '--cell', $name,
            '--users', "$Users",
            '--jobs', "$Jobs",
            '--think', $cell.think,
            '--think-mean', '20',
            '--think-slope', "$($cell.slope)",
            '--pattern', $PATTERN,
            '--seed', "$SEED",
            '--max-seconds', "$MaxSeconds",
            '--out', $records
        )
        if ($cell.think -eq 'open') { $genArgs += @('--schedule', $ARRIVALS) }

        $genLog = Join-Path $records "gen-$name.log"
        Push-Location $root
        & node @genArgs *> $genLog
        $code = $LASTEXITCODE
        Pop-Location
        Get-Content $genLog -Tail 4 | ForEach-Object { Write-Host "  $_" }

        if ($code -ne 0) {
            Write-Host "[失败] $name 负载发生器退出码 $code" -ForegroundColor Red
            continue
        }
        $ok = $true
    }

    if (-not $ok) {
        Write-Host "`n[中止] $name 连跑两次都没成，服务留在停止状态" -ForegroundColor Red
        & (Join-Path $here 'stop-local.ps1') | Out-Null
        exit 1
    }

    # ---- 这个 cell 的当场收尾：切引擎日志、汇总、归档、喂模拟器 ----
    if (Test-Path $engineLog) {
        $stream = [System.IO.File]::Open($engineLog, 'Open', 'Read', 'ReadWrite')
        $stream.Seek($engineOffset, 'Begin') | Out-Null
        $reader = New-Object System.IO.StreamReader($stream)
        $slice = $reader.ReadToEnd()
        $reader.Close(); $stream.Close()
        ($slice -split "`n" | Where-Object { $_ -match 'sched-usage|call deadline' }) -join "`n" |
            Out-File -FilePath (Join-Path $records "usage-$name.log") -Encoding utf8
    }

    Push-Location $root
    & node (Join-Path $here 'summarize.mjs') --json (Join-Path $PaperRecords 'summary.json') --append `
        (Join-Path $records "jobs-$name.jsonl") | Out-Null
    Pop-Location

    foreach ($artefact in "jobs-$name.jsonl", "decisions-$name.jsonl", "client-$name.jsonl", "manifest-$name.json", "usage-$name.log") {
        $src = Join-Path $records $artefact
        if (Test-Path $src) { Copy-Item $src (Join-Path $PaperRecords $artefact) -Force }
    }

    Invoke-PaperPython @(
        'prechecks/platform_testbed/replay_simulator.py', '--append',
        (Join-Path $PaperRecords "jobs-$name.jsonl")
    ) | Out-Null

    $done += $name
    Write-Host "[完成] $name（累计 $($overall.Elapsed.ToString('hh\:mm\:ss'))）" -ForegroundColor Green
}

Write-Host "`n=== 六轮跑完，用时 $($overall.Elapsed.ToString('hh\:mm\:ss')) ===" -ForegroundColor Cyan
Write-Host ($done -join ', ')

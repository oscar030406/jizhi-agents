# 起本机的两个服务（引擎 8001 + 课堂 3210），并把这一轮的调度参数交给课堂进程。
#
# 与 scripts\start-demo.ps1 的差别只有两处，都是排队实验需要的：
#   1. 不把 LLM_TIMEOUT_SECONDS 压到 10 秒——带练路线一次要 90-230 秒，压到 10 秒
#      就根本生成不出来；
#   2. 课堂进程多带一组 SCHED_* 变量，决定这一轮用哪种策略、几个槽、承诺多少。
#      不传 -K 时 SCHED_K 不设，课堂行为与改造前一致。
#
# 两个进程的 PID 写进 .local-pids.json，停服务用 stop-local.ps1，按 PID 停，
# 不按进程名杀。
#
# 用法：
#   .\experiments\scheduling\start-local.ps1 -K 2 -Policy guard -Cell smoke-guard

param(
    [int]$K = 0,
    [ValidateSet('fcfs', 'spjf', 'guard')][string]$Policy = 'fcfs',
    [ValidateSet('completed', 'reservation')][string]$Charging = 'completed',
    [ValidateSet('proxy', 'inverted', 'random')][string]$ScoreMode = 'proxy',
    [int]$LimitMs = 170000,
    [int]$PromiseMs = 900000,
    [int]$B0Ms = 0,
    [double]$Gamma = 0,
    [double]$Eta = 0,
    [string]$Cell = 'unlabelled',
    [int]$ClassroomPort = 3210,
    [int]$EnginePort = 8001,
    # 回放实验：课堂进程的文件账号后端改指这个目录（seed-accounts.mjs 建的测试账号）
    [string]$AccountsDir = '',
    # 回放实验的执行体是 sleep，不调引擎：不起引擎，也不读引擎的 .env
    [switch]$NoEngine
)

$ErrorActionPreference = 'Continue'
$root = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$here = $PSScriptRoot
$records = Join-Path $here 'records'
New-Item -ItemType Directory -Force -Path $records | Out-Null

function Test-Port($port) {
    $null -ne (Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue)
}

# 已经记过的 PID 先读回来：只重起课堂时，引擎那条不该被覆盖掉
$pidFile = Join-Path $here '.local-pids.json'
$pids = @{}
if (Test-Path $pidFile) {
    (Get-Content $pidFile -Raw | ConvertFrom-Json).PSObject.Properties |
        ForEach-Object { $pids[$_.Name] = $_.Value }
}

# --- 引擎 ---------------------------------------------------------------
if ($NoEngine) {
    Write-Host "[skip] engine (-NoEngine)" -ForegroundColor Yellow
} else {
    # 密钥与模型路由在 apps\agent-engine\.env 里，照 start-demo.ps1 的做法读进当前进程
    # 的环境变量再传给子进程；本脚本不打印其中任何一项。
    $envFile = Join-Path $root 'apps\agent-engine\.env'
    if (Test-Path $envFile) {
        Get-Content $envFile | ForEach-Object {
            if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
                [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim('"'))
            }
        }
    }
    $env:AGENT_GENERATION_MODE = 'api'
    $env:AI_SERVICE_TOKEN = 'demo-internal-token'
    # 单次模型调用的读超时。真正的逐 job 上限由 x-sched-deadline-ms 在引擎侧生效，
    # 这里只要不比它小就行。
    $env:LLM_TIMEOUT_SECONDS = '300'

    if (Test-Port $EnginePort) {
        Write-Host "[跳过] 引擎已在 $EnginePort 端口运行" -ForegroundColor Yellow
    } else {
        $enginePython = Join-Path $root 'apps\agent-engine\.venv\Scripts\python.exe'
        if (-not (Test-Path $enginePython)) {
            Write-Host "[错误] 引擎虚拟环境不存在：$enginePython" -ForegroundColor Red
            exit 1
        }
        $p = Start-Process -FilePath $enginePython `
            -ArgumentList @('-m', 'uvicorn', 'app.main:app', '--port', "$EnginePort", '--host', '127.0.0.1') `
            -WorkingDirectory (Join-Path $root 'apps\agent-engine') `
            -RedirectStandardOutput (Join-Path $records 'engine.out.log') `
            -RedirectStandardError (Join-Path $records 'engine.err.log') `
            -WindowStyle Hidden -PassThru
        $pids['engine'] = $p.Id
        Write-Host "[启动] 引擎 pid=$($p.Id) -> :$EnginePort" -ForegroundColor Green
    }
}

# --- 课堂 ---------------------------------------------------------------
if (Test-Port $ClassroomPort) {
    Write-Host "[错误] $ClassroomPort 端口已被占用；先 stop-local.ps1 再起" -ForegroundColor Red
    exit 1
}
if ($K -gt 0) {
    $env:SCHED_K = "$K"
    $env:SCHED_POLICY = $Policy
    $env:SCHED_CHARGING = $Charging
    $env:SCHED_SCORE_MODE = $ScoreMode
    $env:SCHED_L_MS = "$LimitMs"
    $env:SCHED_G_MS = "$PromiseMs"
    $env:SCHED_B0_MS = "$B0Ms"
    $env:SCHED_GAMMA = "$Gamma"
    $env:SCHED_ETA = "$Eta"
    $env:SCHED_CELL = $Cell
    $env:SCHED_RECORD = Join-Path $records "jobs-$Cell.jsonl"
    $env:SCHED_DECISIONS = Join-Path $records "decisions-$Cell.jsonl"
    Write-Host "[调度] k=$K policy=$Policy charging=$Charging score=$ScoreMode L=${LimitMs}ms G=${PromiseMs}ms cell=$Cell" -ForegroundColor Cyan
} else {
    foreach ($name in 'SCHED_K', 'SCHED_POLICY', 'SCHED_CHARGING', 'SCHED_SCORE_MODE', 'SCHED_L_MS', 'SCHED_G_MS', 'SCHED_B0_MS', 'SCHED_GAMMA', 'SCHED_ETA', 'SCHED_CELL', 'SCHED_RECORD', 'SCHED_DECISIONS') {
        [System.Environment]::SetEnvironmentVariable($name, $null)
    }
    Write-Host "[调度] 未开启（SCHED_K 未设），课堂行为与改造前一致" -ForegroundColor Yellow
}

if ($AccountsDir) {
    $env:ACCOUNTS_DIR = (Resolve-Path $AccountsDir).Path
    Write-Host "[accounts] ACCOUNTS_DIR=$($env:ACCOUNTS_DIR)" -ForegroundColor Cyan
}

$classroomLog = Join-Path $records "classroom-$Cell.log"
$p = Start-Process -FilePath 'cmd' `
    -ArgumentList @('/c', "pnpm dev --port $ClassroomPort > `"$classroomLog`" 2>&1") `
    -WorkingDirectory (Join-Path $root 'apps\classroom') `
    -WindowStyle Hidden -PassThru
$pids['classroom'] = $p.Id
Write-Host "[启动] 课堂 pid=$($p.Id) -> :$ClassroomPort，日志 $classroomLog" -ForegroundColor Green

($pids | ConvertTo-Json) | Out-File -FilePath $pidFile -Encoding utf8
Write-Host "PID 记在 $pidFile" -ForegroundColor Cyan

# 挑战杯项目 · 一键启动演示环境
# 用法：右键「使用 PowerShell 运行」，或在 PowerShell 里执行 .\启动演示.ps1
#
# 起两个服务：
#   8001  ai-service —— 多智能体引擎（学情诊断 / 知识检索 / 反馈决策）
#   3210  OpenMAIC   —— 改造版课堂前端（主线演示）
# 加 -WithLegacy 参数会额外起版本 A（学径 3100 + 引擎 8000）

param([switch]$WithLegacy)

$ErrorActionPreference = 'Continue'
# 脚本在 scripts/ 下，项目根是它的上一级
$root = Split-Path $PSScriptRoot -Parent

function Test-Port($port) {
    $conn = Get-NetTCPConnection -LocalPort $port -State Listen -ErrorAction SilentlyContinue
    return $null -ne $conn
}

function Start-Svc($name, $exe, $argList, $workDir, $port) {
    if (Test-Port $port) {
        Write-Host "[跳过] $name 已在 $port 端口运行" -ForegroundColor Yellow
        return
    }
    if (-not (Test-Path $workDir)) {
        Write-Host "[错误] 找不到目录：$workDir" -ForegroundColor Red
        return
    }
    Start-Process -FilePath $exe -ArgumentList $argList -WorkingDirectory $workDir -WindowStyle Hidden
    Write-Host "[启动] $name -> :$port" -ForegroundColor Green
}

Write-Host "`n=== 挑战杯演示环境 ===`n" -ForegroundColor Cyan

# 1. 多智能体引擎（两个版本共用）
# 先加载 apps/agent-engine/.env（LLM 路由与密钥）——不加载的话 fast 档会路由到
# 默认的 dashscope/qwen-flash 且无 key，诊断/反馈决策静默退回 if-else 规则，
# UI 上 engine 字段永远是 deterministic（踩过：环境缺配比代码短路更隐蔽）。
$envFile = Join-Path $root 'apps\agent-engine\.env'
if (Test-Path $envFile) {
    Get-Content $envFile | ForEach-Object {
        if ($_ -match '^\s*([A-Za-z_][A-Za-z0-9_]*)=(.*)$') {
            [System.Environment]::SetEnvironmentVariable($Matches[1], $Matches[2].Trim('"'))
        }
    }
}
# 演示口径：真协同决策（LLM 优先、失败自动降级规则），超时压到 10s 保住现场体验
$env:AGENT_GENERATION_MODE = 'api'
$env:LLM_TIMEOUT_SECONDS = '10'
$env:AI_SERVICE_TOKEN = 'demo-internal-token'
Start-Svc '多智能体引擎 ai-service' 'python' `
    @('-m', 'uvicorn', 'app.main:app', '--port', '8001', '--host', '127.0.0.1') `
    (Join-Path $root 'apps\agent-engine') 8001

# 2. 改造版课堂（主线）
$maicDir = Join-Path $root 'apps\classroom'
if (-not (Test-Path (Join-Path $maicDir '.env.local'))) {
    Write-Host "[警告] OpenMAIC 缺 .env.local —— 请先复制 .env.example.tzb 并填入 API Key" -ForegroundColor Red
}
Start-Svc '改造版课堂 OpenMAIC' 'cmd' `
    @('/c', 'pnpm dev --port 3210 > openmaic-dev.log 2>&1') $maicDir 3210

if ($WithLegacy) {
    $env:LLM_TIMEOUT_SECONDS = '300'
    Start-Svc '学径引擎 API' 'python' `
        @('-m', 'uvicorn', 'backend.main:app', '--port', '8000', '--host', '127.0.0.1') `
        (Join-Path $root 'apps\agent-engine') 8000
    Start-Svc '学径前端 web-next' 'cmd' `
        @('/c', 'npx next dev --port 3100') `
        (Join-Path $root 'apps\legacy-platform\web-next') 3100
}

Write-Host "`n等待服务就绪..." -ForegroundColor Cyan
Start-Sleep -Seconds 18

Write-Host "`n=== 状态 ===" -ForegroundColor Cyan
$checks = @(
    @{ Name = '多智能体引擎'; Port = 8001; Url = 'http://127.0.0.1:8001/docs' },
    @{ Name = '改造版课堂'; Port = 3210; Url = 'http://127.0.0.1:3210' }
)
if ($WithLegacy) {
    $checks += @{ Name = '学径引擎'; Port = 8000; Url = 'http://127.0.0.1:8000/docs' }
    $checks += @{ Name = '学径前端'; Port = 3100; Url = 'http://127.0.0.1:3100' }
}

foreach ($c in $checks) {
    if (Test-Port $c.Port) {
        Write-Host ("  OK   {0,-16} {1}" -f $c.Name, $c.Url) -ForegroundColor Green
    } else {
        Write-Host ("  FAIL {0,-16} 未监听 :{1}" -f $c.Name, $c.Port) -ForegroundColor Red
    }
}

# 引擎桥自检：端口通不等于桥通。personalize 路由 404/鉴权失败时，课堂会静默降级成
# 裸生成（评分表最低档）且页面看不出异常——彩排忘起引擎就是这么翻车的。这里当场戳破。
Write-Host "`n=== 引擎桥自检 ===" -ForegroundColor Cyan
try {
    $probe = Invoke-WebRequest -Uri 'http://127.0.0.1:8001/internal/v1/personalize/skill-map' `
        -Headers @{ 'x-internal-token' = $env:AI_SERVICE_TOKEN } -TimeoutSec 8 -UseBasicParsing
    if ($probe.StatusCode -eq 200) {
        Write-Host "  OK   personalize 桥可用（画像/接地/反馈决策都走它）" -ForegroundColor Green
    } else {
        Write-Host "  FAIL personalize 桥返回 $($probe.StatusCode) —— 课堂将静默降级为裸生成！" -ForegroundColor Red
    }
} catch {
    Write-Host "  FAIL personalize 桥不可达（$($_.Exception.Message.Split("`n")[0])）" -ForegroundColor Red
    Write-Host "       课堂仍能出课，但画像/接地/审核证据/反馈决策全部失效=裸生成模式。" -ForegroundColor Red
    Write-Host "       检查 8001 起没起、AI_SERVICE_TOKEN 是否与课堂 GROUNDING_TOKEN 一致。" -ForegroundColor Red
}

# 协同决策引擎探针：端口通、桥通都不够——LLM 路由缺配时决策会静默退回 if-else，
# engine 字段是唯一真话。演示前必须看到 llm，deterministic 说明 .env 没被加载。
try {
    $body = '{"quiz_score":0.4,"current_difficulty":"L2","confidence":2}'
    $qd = Invoke-RestMethod -Uri 'http://127.0.0.1:8001/internal/v1/personalize/quiz-decision' `
        -Method Post -ContentType 'application/json' -Body $body `
        -Headers @{ 'x-internal-token' = $env:AI_SERVICE_TOKEN } -TimeoutSec 30
    $eng = $qd.data.engine
    if ($eng -eq 'llm') {
        Write-Host "  OK   协同决策引擎      engine=llm（真 LLM 协同，失败自动降级规则）" -ForegroundColor Green
    } else {
        Write-Host "  WARN 协同决策引擎      engine=$eng —— LLM 未接通，决策在走确定性规则" -ForegroundColor Yellow
        Write-Host "       检查 apps/agent-engine/.env 的 LLM_PROVIDER_FAST/SILICONFLOW_API_KEY 是否被加载" -ForegroundColor Yellow
    }
} catch {
    Write-Host "  WARN 协同决策引擎      探针失败（$($_.Exception.Message.Split("`n")[0])）" -ForegroundColor Yellow
}

# 桥探活：端口在听不等于桥通。token 配错/路由没挂时四个引擎桥会静默降级成裸生成
# （评分表最低档），页面看不出异常。/api/health 的 engineBridge 字段是真探针。
try {
    $health = Invoke-RestMethod -Uri 'http://127.0.0.1:3210/api/health' -TimeoutSec 10
    $bridge = $health.data.engineBridge
    if ($bridge -eq 'ok') {
        Write-Host "  OK   引擎桥            四桥可用（画像/接地/审核/反馈）" -ForegroundColor Green
    } elseif ($bridge -eq 'unconfigured') {
        Write-Host "  WARN 引擎桥            未配 GROUNDING_URL——课堂将以裸生成运行" -ForegroundColor Yellow
    } else {
        Write-Host "  FAIL 引擎桥            不通（引擎没起或 token 错）" -ForegroundColor Red
        Write-Host "       *** 课堂会静默退化成裸生成 = 评分表最低档，别带这个状态上场演示 ***" -ForegroundColor Red
    }
} catch {
    Write-Host "  FAIL 引擎桥            课堂 /api/health 无响应，无法判断" -ForegroundColor Red
}

Write-Host "`n演示入口（务必用 Edge，且用 127.0.0.1 不要用 localhost）：" -ForegroundColor Cyan
Write-Host "  主线课堂   http://127.0.0.1:3210"
Write-Host "  协同控制台 http://127.0.0.1:3210/agents"
Write-Host "  学情报告   http://127.0.0.1:3210/report"
if ($WithLegacy) { Write-Host "  学径工作台 http://127.0.0.1:3100" }
Write-Host "`n关闭：结束对应的 python.exe / node.exe 进程，或直接重启机器。`n"

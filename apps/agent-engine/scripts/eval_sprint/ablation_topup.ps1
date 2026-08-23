# 消融爬升补样：每档补到 n 门，四档串行。
#
# 为什么要脚本：四档的开关是**服务端进程的 env**，脚本改不了运行中的进程，
# 每换一档都得起一个新服务。手工来回起停四次、每次跑几门，必然记错哪门属于哪档。
#
# 为什么不动 3210：那个实例另一个会话在用来走管理端 UI。
#
# ## 一档一个端口，不复用
#
# 第一版四档共用一个端口，杀掉上一档再起下一档。结果档 1、档 2 的服务日志都是 0 字节、
# 两门课全 ECONNREFUSED，而脚本还打印了「服务就绪」——**探到的是上一档正在死的那个进程**。
# 杀了立刻重绑同一个端口天生有竞态，失败形态还是「就绪了然后连不上」，最难查。
#
# 现在一档一个端口、一档一个 distDir，从根上没有重绑这回事。
# 就绪判据也换了：不光端口答话，还要**这个服务自己的日志里出现 `Ready in`**——
# 证明答话的是我们刚起的那个，不是别人。
#
# 跑法（在 apps/classroom 下）：
#   pwsh -File ..\agent-engine\scripts\eval_sprint\ablation_topup.ps1 -PerRung 2
#   pwsh -File ..\agent-engine\scripts\eval_sprint\ablation_topup.ps1 -PerRung 2 -OnlyRungs 1,2,3
#
# -PerRung 是**每档补几门**，不是总数。

param(
    [int]$PerRung = 2,
    [int]$BasePort = 3211,
    [double]$Budget = 1.0,
    # 写成字符串自己切，不用 [int[]]：`powershell -File x.ps1 -OnlyRungs 1,2,3`
    # 会把逗号吃掉、绑成单个整数 123，四档一个都不跑——而且不报错。
    [string]$OnlyRungs = '0,1,2,3',
    [string]$LogDir = "$env:TEMP\ablation-topup"
)

$ErrorActionPreference = 'Continue'   # next dev 往 stderr 写正常日志，别当错误

# 四档与各自要设的 env。与 b_ablation.mjs 的 RUNGS 表一字对应——
# 那边是真源，这里改了两边就会分叉，改之前先对一遍。
$Rungs = @(
    @{ N = 0; Name = '裸生成';    Env = @{ LECTURE_SCENE_MODE = '0'; SLIDE_TEMPLATE_MODE = '0'; AUDIT_GATE = '0'; COURSE_COHERENCE = '0' } },
    @{ N = 1; Name = '+模板池';   Env = @{ AUDIT_GATE = '0'; COURSE_COHERENCE = '0' } },
    @{ N = 2; Name = '+审核门';   Env = @{ COURSE_COHERENCE = '0' } },
    @{ N = 3; Name = '+蓝图连贯'; Env = @{} }
)

$wanted = @($OnlyRungs -split '[,\s]+' | Where-Object { $_ } | ForEach-Object { [int]$_ })
if (-not $wanted) { throw "-OnlyRungs 解析不出任何档：收到「$OnlyRungs」" }
Write-Host ("要跑的档：" + ($wanted -join '、') + "，每档 $PerRung 门")

New-Item -ItemType Directory -Force $LogDir | Out-Null

function Stop-OnPort([int]$p) {
    foreach ($c in (Get-NetTCPConnection -LocalPort $p -State Listen -ErrorAction SilentlyContinue)) {
        try { Stop-Process -Id $c.OwningProcess -Force -ErrorAction Stop } catch {}
    }
}

function Wait-Ours([string]$url, [string]$log, $proc, [int]$TimeoutSec = 300) {
    # 三个条件同时成立才算就绪：进程还活着、日志里有 next 自己打的 Ready、端口答话。
    # 只看端口会把「上一档正在死的进程」当成就绪——第一版就是这么栽的。
    $deadline = (Get-Date).AddSeconds($TimeoutSec)
    while ((Get-Date) -lt $deadline) {
        if ($proc.HasExited) {
            Write-Host "  服务进程已退出（exit $($proc.ExitCode)）"
            return $false
        }
        $text = (Get-Content $log -Raw -ErrorAction SilentlyContinue)
        if ($text -and ($text -match 'Ready in')) {
            try {
                Invoke-WebRequest -Uri $url -TimeoutSec 10 -UseBasicParsing | Out-Null
                return $true
            } catch { }
        }
        Start-Sleep -Seconds 3
    }
    Write-Host "  等就绪超时"
    return $false
}

$ranCourses = 0
foreach ($rung in $Rungs) {
    if ($wanted -notcontains $rung.N) { continue }

    $port = $BasePort + $rung.N          # 一档一个端口，不复用
    $base = "http://localhost:$port"
    Write-Host ""
    Write-Host "======== 档 $($rung.N) $($rung.Name)  端口 $port ========"

    Stop-OnPort $port                    # 这个口本该是空的；不空说明上次跑残了

    $envPairs = @()
    foreach ($k in $rung.Env.Keys) { $envPairs += "$k=$($rung.Env[$k])" }
    Write-Host ("  env：" + $(if ($envPairs) { $envPairs -join ' ' } else { '(全用产品默认)' }))

    foreach ($k in $rung.Env.Keys) { Set-Item -Path "Env:$k" -Value $rung.Env[$k] }
    $env:PORT = "$port"
    # next dev 锁 .next/dev，同目录起不了第二个实例。一档一个 distDir，
    # 与 3210 上别人在用的那个互不干扰（next.config.ts 读 NEXT_DIST_DIR）。
    $env:NEXT_DIST_DIR = ".next-ablation-$($rung.N)"

    # 每档从干净的构建目录起。上一次跑到一半被打断会留下半成品 distDir，
    # 再起服务时 `/` 一路 500——实测档 1 就是这么卡住的（探针跑过 -PerRung 0，
    # 起了一下就杀，留下半个 .next-ablation-1）。多花一分钟编译，换掉一整类怪问题。
    $dist = Join-Path (Get-Location) ".next-ablation-$($rung.N)"
    if (Test-Path $dist) {
        Write-Host "  清掉上次的构建目录 $dist"
        Remove-Item $dist -Recurse -Force -ErrorAction SilentlyContinue
    }

    $log = Join-Path $LogDir "dev-rung$($rung.N).log"
    Remove-Item $log, "$log.err" -ErrorAction SilentlyContinue
    # 必须点名 pnpm.cmd：PATH 上排在前面的 pnpm.ps1 不是 Win32 可执行文件，
    # Start-Process 会报「%1 is not a valid Win32 application」。
    $pnpm = (Get-Command pnpm.cmd -ErrorAction SilentlyContinue).Source
    if (-not $pnpm) { throw '找不到 pnpm.cmd' }
    $proc = Start-Process -FilePath $pnpm -ArgumentList 'dev' -PassThru -NoNewWindow `
        -RedirectStandardOutput $log -RedirectStandardError "$log.err"
    # 设完就摘掉，免得下一档继承上一档的开关——这正是最容易出的那种假档间差。
    foreach ($k in $rung.Env.Keys) { Remove-Item -Path "Env:$k" -ErrorAction SilentlyContinue }

    if (-not (Wait-Ours $base $log $proc)) {
        Write-Host "  这一档跳过。日志：$log"
        try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch {}
        Stop-OnPort $port
        continue
    }
    Write-Host "  服务就绪 $base（PID $($proc.Id)）"

    for ($i = 1; $i -le $PerRung; $i++) {
        Write-Host "  --- 第 $i/$PerRung 门 ---"
        node --import tsx ..\agent-engine\scripts\eval_sprint\b_ablation.mjs `
            --rung $rung.N --base-url $base --budget $Budget
        if ($LASTEXITCODE -ne 0) { Write-Host "  这一门非零退出（$LASTEXITCODE），继续下一门" }
        else { $ranCourses++ }
    }

    try { Stop-Process -Id $proc.Id -Force -ErrorAction Stop } catch {}
    Stop-OnPort $port
}

Write-Host ""
# 一门都没跑成还打印「补完」退出 0，是最坏的形态：上游会当成补样做完了。
if ($ranCourses -eq 0) {
    Write-Host "一门都没跑成。日志在 $LogDir，别把这次当成补完。"
    exit 1
}
Write-Host "补完 $ranCourses 门。读数汇总跑：node --import tsx ..\agent-engine\scripts\eval_sprint\b_ablation.mjs --judge"

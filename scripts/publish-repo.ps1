<#
  发布公开仓库 jizhi-agents（产品形态导出）。

  用法：
    .\scripts\publish-repo.ps1                 # 导出 + 扫描 + 提交 + 推送
    .\scripts\publish-repo.ps1 -NoPush         # 只导出与扫描，不推送
    .\scripts\publish-repo.ps1 -Message "..."  # 自定义提交说明

  原理：把工作区里属于产品的部分镜像到 $Stage（默认桌面 jizhi-agents），
  在那里维护 git 历史并推 GitHub。本地工作区（研发区/语料/工作文档）不动。
  每次发布都重跑本脚本，不要手工挑文件——手工必漏。
#>

param(
    [string]$Stage = "$env:USERPROFILE\Desktop\jizhi-agents",
    [string]$Message = "",
    [switch]$NoPush
)

$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
if (-not $Message) { $Message = "进度快照 " + (Get-Date -Format 'yyyy-MM-dd') }

# ---- 护栏：Stage 不许落在拷贝源里面 -----------------------------------------
# 2026-08-17 事故：某次自定义 -Stage 指到了源树内部，robocopy /MIR 边拷边把
# 自己拷进去，嵌出 5 层 `publish-stage/scratchpad/publish-stage/...`、46572 个文件、
# 33 GB（每层还各带一个 6.7 GB 的包）。默认 Stage 在 C 盘不会犯，但提交日一旦手改
# 参数就会。这里在动手拷之前拦住——递归拷贝没有安全的失败方式。
$rootFull  = [System.IO.Path]::GetFullPath($root).TrimEnd('\')
$stageFull = [System.IO.Path]::GetFullPath($Stage).TrimEnd('\')
if ($stageFull -eq $rootFull -or $stageFull.StartsWith($rootFull + '\', [StringComparison]::OrdinalIgnoreCase)) {
    Write-Host "[错误] -Stage 落在源树内部，会被 robocopy /MIR 递归自拷。" -ForegroundColor Red
    Write-Host "       源树 : $rootFull"
    Write-Host "       Stage: $stageFull"
    Write-Host "       换一个源树外的目录（默认值 $env:USERPROFILE\Desktop\jizhi-agents 就在源树外）。"
    exit 1
}

Write-Host "`n=== 导出产品树 → $Stage ===`n" -ForegroundColor Cyan

# ---- 排除清单（与产品无关的一律不出门）--------------------------------------
# 目录名（任意层级命中即排除；.git 同时保护了 Stage 自己的仓库目录不被 /MIR 清掉）
$excludeDirs = @(
    '.git', 'node_modules', '.next', '__pycache__', '.pytest_cache', '.venv', 'venv',
    '.turbo', '.swc', 'build', 'dist', '.serena', '.claude', '.cursor', '.codex',
    '.vscode', '.idea', 'reference_repos'
)
# 根级目录（只排根下的这些；引擎研发区/旧平台/参考仓/语料/临时区都不属于产品）
# 画像\：插画的**出图原件**堆放处，47 个文件全叫「ChatGPT Image 2026年8月16日 08_19_41.png」，
# 共 62 MB。上屏用的成品另有一份在 apps\classroom\public\ 下，这堆原件不是产品。
# 2026-08-17 核对时它一条排除规则都没命中——文件名本身就是痕迹，而痕迹扫描只读
# .md/.ts/.tsx/.py/.json/.ps1 的内容，不看文件名，它会一路无声地推上公开仓。
$excludeTopDirs = @('tmp', 'archive', 'data', 'references', 'node_modules', '画像')
# 全路径排除：语料/账单目录。不能按目录名盲排——classroom 里 lib/usage、
# app/api/usage 是正经代码（实测撞过名）。
# 2026-08-04 引擎合并：apps\engine 已并入 apps\agent-engine。原先靠排掉整个
# apps\engine 挡住的研发件（评测脚本、测试、评测产物）现在住在产品目录里，
# 只能逐项排除。发布产物形态与合并前保持一致——要不要改由人决定，别让它自己变。
$excludeAppDirs = @(
    'apps\legacy-platform', 'docs\archive',
    'apps\agent-engine\scripts', 'apps\agent-engine\tests', 'apps\agent-engine\frontend',
    'apps\agent-engine\data\knowledge_base', 'apps\agent-engine\data\curriculum',
    'apps\agent-engine\data\eval', 'apps\agent-engine\data\runs',
    'apps\agent-engine\data\experiments', 'apps\agent-engine\data\demo_runs',
    'apps\agent-engine\data\studio_runs', 'apps\agent-engine\data\outlines',
    'apps\agent-engine\data\exams', 'apps\agent-engine\data\archive',
    'apps\agent-engine\data\reference_repos', 'apps\agent-engine\data\.lesson_cache',
    'apps\classroom\data\usage',
    # 账户库：密码哈希 + 会话令牌。2026-08-15 核验发现它一直不在任何排除清单里，
    # 当时盘上有 2 个账号 7 个会话令牌——推一次就全出门了。
    'apps\classroom\data\accounts'
)
# 文件（协作者本地工作文件、密钥、日志、快照类文档）
$excludeFiles = @(
    'CLAUDE.md', 'AGENTS.md', '.mcp.json', '*.log', '.env', '.env.local', '.env.*.local',
    # 环境备份是穿了马甲的密钥文件（.env.local.bak-* 实测藏过真 key），一律不出门
    '.env*.bak*', '*.bak',
    '接手指南.md', 'HANDOFF-*.md', 'codex.md', 'product-provenance.md',
    'curation_discipline.md', 'external-assets-index.md',
    'personalization-handover-questions.md', 'repo_tidy_plan.md',
    'metric_protocol_questions.md', '赛题原文-XH-202630.pdf', 'make-package.ps1',
    'publish-repo.ps1', 'build-submission.ps1', 'PLAYBOOK.md', '.gitignore',
    # 交付卫生扫描器：和上面三个打包脚本同类，是我们自己的工具，不是产品。
    # 它还必须排除——词表里写着 `由 Claude 编写` 这种字面量，下面那道痕迹扫描
    # 会照直命中自己的尺子，把整次发布拦死（2026-08-17 实测）。
    'scan-package-hygiene.py'
)

$rc = @()
foreach ($d in $excludeDirs)    { $rc += '/XD'; $rc += $d }
foreach ($d in $excludeTopDirs) { $rc += '/XD'; $rc += (Join-Path $root $d) }
foreach ($d in $excludeAppDirs) { $rc += '/XD'; $rc += (Join-Path $root $d) }
foreach ($f in $excludeFiles)   { $rc += '/XF'; $rc += $f }

robocopy $root $Stage /MIR /NFL /NDL /NJH /NJS /NP @rc | Out-Null
if ($LASTEXITCODE -ge 8) { Write-Host "[错误] robocopy 失败，码 $LASTEXITCODE" -ForegroundColor Red; exit 1 }

# Stage 用自己的干净 .gitignore（工作区那份是本地策展清单，不出门）
@"
node_modules/
.next/
__pycache__/
*.pyc
.env
.env.local
*.log
"@ | Out-File -FilePath (Join-Path $Stage '.gitignore') -Encoding utf8

# ---- 扫描一：密钥（公开仓零容忍，任何命中即阻断）-----------------------------
Write-Host "扫描密钥..." -ForegroundColor Yellow
$keyPattern = 'sk-[A-Za-z0-9]{32,}|gho_[A-Za-z0-9]{30,}|ghp_[A-Za-z0-9]{30,}|AIza[A-Za-z0-9_\-]{30,}'
# 全文件面扫（不按扩展名挑——.env.local.bak-日期 这种改名马甲实测漏过），
# 只跳过二进制类与压缩产物
$keyHits = Get-ChildItem -Path $Stage -Recurse -File -ErrorAction SilentlyContinue |
           Where-Object { $_.Name -notmatch '\.(png|jpg|jpeg|gif|webp|ico|svg|woff2?|ttf|otf|wasm|zip|npz|pdf|mp4|min\.js|min\.css)$' } |
           Select-String -Pattern $keyPattern -List -ErrorAction SilentlyContinue
if ($keyHits) {
    Write-Host "[阻断] 发现密钥形状的内容，未发布：" -ForegroundColor Red
    $keyHits | ForEach-Object { Write-Host ("  " + $_.Path.Replace($Stage, '')) -ForegroundColor Red }
    exit 1
}
Write-Host "  无密钥" -ForegroundColor Green

# ---- 扫描二：协作痕迹（词表精确匹配，防误伤正常技术名词）--------------------
Write-Host "扫描协作痕迹..." -ForegroundColor Yellow
$tracePattern = 'Generated with \[?Claude|Co-Authored-By: Claude|作为 ?AI ?助手|由 Claude 编写|claude\.ai/code|HANDOFF-2026'
$traceHits = Get-ChildItem -Path $Stage -Recurse -File -Include *.md,*.ts,*.tsx,*.py,*.json,*.ps1 -ErrorAction SilentlyContinue |
             Select-String -Pattern $tracePattern -List -ErrorAction SilentlyContinue
if ($traceHits) {
    Write-Host "[阻断] 发现协作痕迹，未发布：" -ForegroundColor Red
    $traceHits | ForEach-Object { Write-Host ("  " + $_.Path.Replace($Stage, '') + " : " + $_.Line.Trim()) -ForegroundColor Red }
    exit 1
}
Write-Host "  干净" -ForegroundColor Green

# ---- git 提交与推送 ----------------------------------------------------------
Push-Location $Stage
if (-not (Test-Path (Join-Path $Stage '.git'))) {
    git init -b main | Out-Null
    Write-Host "已初始化 git 仓库" -ForegroundColor Green
}
git add -A
$pending = git status --porcelain
if (-not $pending) {
    Write-Host "没有变更，无需提交。" -ForegroundColor Yellow
} else {
    git commit -m $Message | Out-Null
    Write-Host "已提交：$Message" -ForegroundColor Green
}
if (-not $NoPush) {
    $hasRemote = git remote | Select-String origin
    if (-not $hasRemote) {
        Write-Host "首次发布：gh repo create jizhi-agents --public --source . --push" -ForegroundColor Yellow
        gh repo create jizhi-agents --public --source . --push
    } else {
        git push origin main
    }
}
Pop-Location

Write-Host "`n=== 完成 ===`n" -ForegroundColor Cyan

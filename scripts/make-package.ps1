<#
  打包项目给团队成员看（网盘分发用）。

  用法：
    .\scripts\make-package.ps1                    # 打到桌面
    .\scripts\make-package.ps1 -OutDir D:\tmp     # 指定输出目录
    .\scripts\make-package.ps1 -KeepGit           # 保留 git 历史（体积 +105M）

  每次分发都重跑这个脚本，不要手工挑文件——手工每次都会漏。
#>

param(
    [string]$OutDir = "$env:USERPROFILE\Desktop",
    [switch]$KeepGit
)

$ErrorActionPreference = 'Continue'
$root = Split-Path $PSScriptRoot -Parent
$stamp = Get-Date -Format 'yyyyMMdd'
$name = "jizhi-agents-$stamp"
$stage = Join-Path $env:TEMP $name

Write-Host "`n=== 打包 $name ===`n" -ForegroundColor Cyan

if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

# ---- 排除清单 ----------------------------------------------------------------
# 只排两类：装得回来的（依赖、构建产物）和 agent 工作文件。
# 语料、书库、参考仓全部随包走——网盘分发不卡体积，收件人拿到就是完整的。
$excludeDirs = @(
    'node_modules', '.next', '__pycache__', '.pytest_cache', '.venv', 'venv',
    '.turbo', '.swc', 'build', '.serena', '.claude', '.vscode', '.idea'
)
# tmp/ 装的是上游对照的 git worktree（等于 apps/classroom 源码再来一份）和跑批日志，
# 两样都不该进交付包。见 tmp/README.md。
$excludeTopLevel = @('tmp')
# agent 工作文件，不进对外包
# `.env*.bak*`：换 key 前留的环境备份，里面是**过期但仍有效**的真 key，而队友一个都用不上。
# 2026-08-17 扫本脚本自己打出来的包，捞出 apps\agent-engine\.env.bak-20260816-before-token
# 与 apps\classroom\.env.local.bak-20260730 两份，各含一条 SILICONFLOW_API_KEY。
# publish-repo.ps1 早就排了这一类（注释写着「穿了马甲的密钥文件」），这里一直没跟上。
$excludeFiles = @('CLAUDE.md', 'AGENTS.md', 'codex.md', '.mcp.json', 'openmaic-dev.log',
                  '.env*.bak*')
if (-not $KeepGit) { $excludeDirs += '.git' }

# ---- 复制 --------------------------------------------------------------------
$xd = @()
foreach ($d in $excludeDirs) { $xd += '/XD'; $xd += $d }
foreach ($p in $excludeTopLevel) { $xd += '/XD'; $xd += (Join-Path $root ($p -replace '/', '\')) }
$xf = @()
foreach ($f in $excludeFiles) { $xf += '/XF'; $xf += $f }
# 注意：.env.local 随包分发（团队共用同一个硅基流动 key，收件人不用各自申请）。
# 代价是这个压缩包等同于凭证——网盘链接必须带提取码、只发队内，不要公开分享。

robocopy $root $stage /MIR /NFL /NDL /NJH /NJS /NP @xd @xf | Out-Null
# robocopy 退出码 0-7 是成功/信息，>=8 才是真失败
if ($LASTEXITCODE -ge 8) { Write-Host "[错误] robocopy 失败，码 $LASTEXITCODE" -ForegroundColor Red; exit 1 }

# ---- 扫描：密钥 --------------------------------------------------------------
Write-Host "扫描密钥..." -ForegroundColor Yellow
# 只认真正 key 形状的串。踩过的坑：
#   - AKIA[0-9A-Z]{16} 在 base64/wasm blob 里随机撞出上百次（上游 vendored 的 maic-importer）
#   - XXX_API_KEY=\S+ 会把占位符（=<...>）和读取代码（startswith("XXX_API_KEY=")）全算进去
$keyPattern = 'sk-[A-Za-z0-9]{32,}|gho_[A-Za-z0-9]{30,}|ghp_[A-Za-z0-9]{30,}'
# `.env*` 与 `*.bak*` 必须在名单里：按扩展名挑文件的话，`.env.local.bak-20260730` 这种
# 改了名的密钥文件一个字都不会被读到——扫描器看不见的文件，"扫过了"就是一句空话。
$scanned = Get-ChildItem -Path $stage -Recurse -File -Include *.ts,*.tsx,*.py,*.json,*.md,*.ps1,*.yml,*.yaml,*.env,.env*,*.bak* -ErrorAction SilentlyContinue |
           Where-Object { $_.FullName -notmatch '\\(vendor|dist)\\' -and $_.Name -notmatch '\.min\.' } |
           Select-String -Pattern $keyPattern -List -ErrorAction SilentlyContinue

# 三层：
#   .env* —— 有意随包分发（团队共用 key），只提示不拦
#   第三方材料（references/、data/ 下载来的课件）自带的 key —— 不是我们的，也无权改，只提示
#   其余我方代码/文档里出现 key —— 阻断，那是不该硬编码的
$envHits = $scanned | Where-Object { $_.Path -match '\\\.env' }
$theirs  = $scanned | Where-Object { $_.Path -notmatch '\\\.env' -and $_.Path.Replace($stage, '') -match '^\\(references|data)\\' }
$ours    = $scanned | Where-Object { $_.Path -notmatch '\\\.env' -and $_.Path.Replace($stage, '') -notmatch '^\\(references|data)\\' }

if ($ours) {
    Write-Host "[阻断] 我方代码里硬编码了密钥，未打包：" -ForegroundColor Red
    $ours | ForEach-Object { Write-Host ("  " + $_.Path.Replace($stage, '')) -ForegroundColor Red }
    exit 1
}
Write-Host "  我方代码无硬编码密钥" -ForegroundColor Green
if ($envHits) {
    Write-Host "  [注意] 包内含可用 API Key（.env 随包走，团队共用）：" -ForegroundColor Yellow
    $envHits | ForEach-Object { Write-Host ("    " + $_.Path.Replace($stage, '')) -ForegroundColor Yellow }
    Write-Host "           网盘链接请带提取码、只发队内，不要公开分享。" -ForegroundColor Yellow
}
if ($theirs) {
    Write-Host "  [提示] 第三方材料自带 key（非我方，随原材料分发）：" -ForegroundColor DarkGray
    $theirs | ForEach-Object { Write-Host ("    " + $_.Path.Replace($stage, '')) -ForegroundColor DarkGray }
}

# ---- 扫描：AI 痕迹 -----------------------------------------------------------
Write-Host "扫描 AI 痕迹..." -ForegroundColor Yellow
# 精确匹配，避免误伤正常技术名词（Agent / RAG / LoRA 等都是合法术语）
$aiPattern = 'Generated with \[?Claude|Co-Authored-By: Claude|作为 ?AI ?助手|以下是我为你生成|由 Claude 编写'
$aiHits = Get-ChildItem -Path $stage -Recurse -File -Include *.md,*.ts,*.tsx,*.py,*.json -ErrorAction SilentlyContinue |
          Select-String -Pattern $aiPattern -List -ErrorAction SilentlyContinue
if ($aiHits) {
    Write-Host "[警告] 发现 AI 痕迹，请人工确认：" -ForegroundColor Yellow
    $aiHits | ForEach-Object { Write-Host ("  " + $_.Path.Replace($stage, '') + " : " + $_.Line.Trim()) -ForegroundColor Yellow }
} else {
    Write-Host "  无 AI 痕迹" -ForegroundColor Green
}

# ---- 压缩 --------------------------------------------------------------------
# 用 Python zipfile 而不是 Compress-Archive：后者会把办公软件的 ~$ 锁文件打进包
$zip = Join-Path $OutDir "$name.zip"
if (Test-Path $zip) { Remove-Item -Force $zip }
Write-Host "压缩中..." -ForegroundColor Yellow
$py = @"
import zipfile, os, sys
stage, zippath, top = sys.argv[1], sys.argv[2], sys.argv[3]
n = 0
# 包里大头是 PDF/PNG/wasm，本来就压不动，用最低压缩级别换速度
with zipfile.ZipFile(zippath, 'w', zipfile.ZIP_DEFLATED, compresslevel=1) as z:
    for base, dirs, files in os.walk(stage):
        for f in files:
            if f.startswith('~$'):
                continue
            full = os.path.join(base, f)
            z.write(full, os.path.join(top, os.path.relpath(full, stage)))
            n += 1
print(n)
"@
$pyFile = Join-Path $env:TEMP "zip_$stamp.py"
Set-Content -LiteralPath $pyFile -Value $py -Encoding utf8
$count = python $pyFile $stage $zip $name
Remove-Item -Force $pyFile

$size = [Math]::Round((Get-Item $zip).Length / 1MB, 1)
Remove-Item -Recurse -Force $stage

Write-Host "`n=== 完成 ===" -ForegroundColor Cyan
Write-Host "  $zip"
Write-Host "  $count 个文件，$size MB"
Write-Host "`n收件人拿到后：解压 → 读 README.md → 按 docs/01-start/ 装依赖`n"

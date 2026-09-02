<#
  作品提交包装配器（赛题「作品提交形式」三件套）。

  每次提交前重跑本脚本，不手工拼包——手工每次都会漏。
  流程：清 stage → ①材料文档 ②软件模块 ③测试数据 → 密钥/痕迹双扫描（阻断制）→ zip。

  用法：
    .\scripts\build-submission.ps1                 # 打到 dist\
    .\scripts\build-submission.ps1 -SkipVideoCheck # 视频还没录好时允许缺
#>

param(
    [string]$OutDir = "",
    [switch]$SkipVideoCheck
)

$ErrorActionPreference = 'Continue'
# 2026-08-31 环境重整后 PATH 上的 python 是 WindowsApps 占位符（exit 49），显式指向 ml-env
$py = 'D:\environment\tools\ml-env\python.exe'
if (-not (Test-Path $py)) { $py = 'python' }
$root = Split-Path $PSScriptRoot -Parent
$stamp = Get-Date -Format 'yyyyMMdd'
if (-not $OutDir) { $OutDir = Join-Path $root 'dist' }
$stage = Join-Path $OutDir "submission-$stamp"
$defense = Join-Path $root 'docs\06-defense'

Write-Host "`n=== 装配提交包 submission-$stamp ===`n" -ForegroundColor Cyan
if (Test-Path $stage) { Remove-Item -Recurse -Force $stage }
New-Item -ItemType Directory -Force -Path $stage | Out-Null

# ---- ① 材料文档 --------------------------------------------------------------
$mat = Join-Path $stage '01-材料文档'
New-Item -ItemType Directory -Force -Path $mat | Out-Null
# 方案文档真源 = 技术实现文档-历程版.docx；design-implementation.md 是前身草稿，
# 不再入包，避免两份技术文档口径分裂。
$techDoc = Join-Path $defense 'v8\技术实现文档-v8.docx'
if (-not (Test-Path $techDoc)) {
    Write-Host "[阻断] 未找到技术实现文档（docs\06-defense\技术实现文档-历程版.docx）" -ForegroundColor Red; exit 1
}
Copy-Item $techDoc (Join-Path $mat '技术实现文档.docx')
$required = @('product-intro.md')
$missing = @()
foreach ($f in $required) {
    $src = Join-Path $defense $f
    if (-not (Test-Path $src)) { $missing += $f; continue }
    $content = Get-Content $src -Raw -Encoding utf8
    if ($content -match '待写|TODO') { $missing += "$f（还是待写状态）"; continue }
    Copy-Item $src (Join-Path $mat $f)
}
if ($missing.Count) {
    Write-Host "[阻断] 材料文档缺失或未完成：" -ForegroundColor Red
    $missing | ForEach-Object { Write-Host "  $_" -ForegroundColor Red }
    Write-Host "  真源目录：docs\06-defense\（写完再打包）" -ForegroundColor Yellow
    exit 1
}
$ppt = Join-Path $defense 'v8\集智答辩-v8.pptx'
if (Test-Path $ppt) { Copy-Item $ppt $mat } else {
    Write-Host "[阻断] 未找到答辩 PPT（docs\06-defense\集智答辩-v7-销冠版.pptx）" -ForegroundColor Red; exit 1
}
$video = Get-ChildItem $defense -Filter '*.mp4' -ErrorAction SilentlyContinue
if ($video) { $video | ForEach-Object { Copy-Item $_.FullName $mat } }
elseif (-not $SkipVideoCheck) {
    Write-Host "[阻断] 未找到演示视频（docs\06-defense\*.mp4）。视频未录好可用 -SkipVideoCheck 先出包。" -ForegroundColor Red
    exit 1
} else { Write-Host "  [警告] 无演示视频（-SkipVideoCheck）" -ForegroundColor Yellow }

# ---- ② 软件模块 --------------------------------------------------------------
$mod = Join-Path $stage '02-软件模块'
New-Item -ItemType Directory -Force -Path $mod | Out-Null
@"
# 源代码与线上实例

- 开源仓库：https://github.com/oscar030406/jizhi-agents
- 线上实例：https://jizhi.chenmingkun.cn （未登录即可访问示例课程与审核记录）
- 知识库数据包（教材语料）因版权按书单登记制发放，仓库 README 有说明。
"@ | Out-File (Join-Path $mod '源代码与在线地址.md') -Encoding utf8
Copy-Item (Join-Path $defense 'deployment.md') (Join-Path $mod '部署说明.md')
Copy-Item (Join-Path $defense 'unit-tests.md') (Join-Path $mod '单元测试用例说明.md')

# ---- ③ 测试数据（调用 python 装配器，从归档 run 抽真实 IO）--------------------
Write-Host "导出测试数据..." -ForegroundColor Yellow
$dataOut = Join-Path $stage '03-测试数据'
& $py (Join-Path $root 'scripts\export-submission-data.py') --out $dataOut
if ($LASTEXITCODE -ne 0) { Write-Host "[阻断] 测试数据导出失败" -ForegroundColor Red; exit 1 }

# ---- 数字对账（对外数字位 vs metrics.json 真源，作废读数零容忍）----------------
Write-Host "数字对账..." -ForegroundColor Yellow
& $py (Join-Path $root 'scripts\audit_outward_numbers.py') --pptx
if ($LASTEXITCODE -ne 0) { Write-Host "[阻断] 对外文档存在作废读数（见上方输出）" -ForegroundColor Red; exit 1 }

# ---- 扫描（与 publish-repo 同口径：密钥零容忍 + 协作痕迹词表）------------------
Write-Host "扫描密钥..." -ForegroundColor Yellow
$keyPattern = 'sk-[A-Za-z0-9]{32,}|gho_[A-Za-z0-9]{30,}|ghp_[A-Za-z0-9]{30,}|AIza[A-Za-z0-9_\-]{30,}'
$keyHits = Get-ChildItem -Path $stage -Recurse -File |
           Where-Object { $_.Name -notmatch '\.(png|jpg|jpeg|gif|webp|ico|mp4|zip|pdf)$' } |
           Select-String -Pattern $keyPattern -List -ErrorAction SilentlyContinue
if ($keyHits) {
    Write-Host "[阻断] 密钥形状内容：" -ForegroundColor Red
    $keyHits | ForEach-Object { Write-Host ("  " + $_.Path.Replace($stage, '')) -ForegroundColor Red }
    exit 1
}
Write-Host "扫描协作痕迹..." -ForegroundColor Yellow
$tracePattern = 'Generated with \[?Claude|Co-Authored-By: Claude|作为 ?AI ?助手|由 Claude 编写|claude\.ai/code|HANDOFF-2026'
$traceHits = Get-ChildItem -Path $stage -Recurse -File -Include *.md,*.json,*.jsonl,*.csv |
             Select-String -Pattern $tracePattern -List -ErrorAction SilentlyContinue
if ($traceHits) {
    Write-Host "[阻断] 协作痕迹：" -ForegroundColor Red
    $traceHits | ForEach-Object { Write-Host ("  " + $_.Path.Replace($stage, '') + " : " + $_.Line.Trim()) -ForegroundColor Red }
    exit 1
}

# ---- 打包 --------------------------------------------------------------------
$zip = "$stage.zip"
if (Test-Path $zip) { Remove-Item $zip }
Compress-Archive -Path (Join-Path $stage '*') -DestinationPath $zip
Write-Host "`n完成：" -ForegroundColor Green
Write-Host "  $stage"
Write-Host "  $zip ($([math]::Round((Get-Item $zip).Length/1MB,1)) MB)"

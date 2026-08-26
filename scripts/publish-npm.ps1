# dsh-pwsh-progress — npm 发布脚本
#
# 前置：
#   1. 已注册 npm 账号（https://www.npmjs.com/signup）
#   2. 已登录：npm login --registry=https://registry.npmjs.org
#      （本机默认 registry 是 npmmirror，发布必须走官方源，脚本已强制 --registry）
#   3. 网络：直连 registry.npmjs.org 若超时，脚本会提示设置 HTTPS_PROXY=127.0.0.1:7891
#
# 执行：pwsh scripts/publish-npm.ps1
$ErrorActionPreference = 'Stop'
$Here = Split-Path -Parent $PSScriptRoot

Write-Host "==> 1/4 检查 npm 登录状态（官方 registry）"
$who = npm whoami --registry=https://registry.npmjs.org 2>&1
if ($LASTEXITCODE -ne 0) {
    Write-Host "    未登录。请先执行: npm login --registry=https://registry.npmjs.org"
    Write-Host "    （若直连超时，先执行: `$env:HTTPS_PROXY='http://127.0.0.1:7891'）"
    exit 1
}
Write-Host "    已登录: $who"

Write-Host "==> 2/4 确认包名未被占用"
$view = npm view dsh-pwsh-progress version --registry=https://registry.npmjs.org 2>&1
if ($LASTEXITCODE -eq 0) {
    Write-Host "    包名已被占用（现有版本 $view），中止发布。"
    exit 1
}
Write-Host "    包名可用"

Write-Host "==> 3/4 打包预检"
npm pack --dry-run --registry=https://registry.npmjs.org 2>&1 | Select-Object -Last 12
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host "==> 4/4 发布"
npm publish --registry=https://registry.npmjs.org 2>&1 | Select-Object -Last 5
if ($LASTEXITCODE -ne 0) { exit 1 }

Write-Host ""
Write-Host "✅ 发布完成: https://www.npmjs.com/package/dsh-pwsh-progress"
Write-Host "安装验证: npm add dsh-pwsh-progress && dsh plugin --profile web add dsh-pwsh-progress"

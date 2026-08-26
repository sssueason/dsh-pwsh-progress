# dsh-pwsh-progress — GitHub 发布脚本
#
# 前置：
#   1. gh CLI 已安装且已登录：`gh auth login`（浏览器授权或粘贴 token）
#   2. 提供你的 GitHub 用户名作为第一个参数
#   3. 已把 README.md / README.en.md 中的 `<owner>` 占位替换为你的用户名
#      （本脚本会先检查，未替换则中止）
#
# 执行：pwsh scripts/publish-github.ps1 <你的GitHub用户名>
param(
    [Parameter(Mandatory = $true)]
    [string]$Owner
)

$ErrorActionPreference = 'Stop'
$Repo = "$Owner/dsh-pwsh-progress"
$Here = Split-Path -Parent $PSScriptRoot

Write-Host "==> 1/5 检查 gh 登录状态"
gh auth status | Out-String | Write-Host
if ($LASTEXITCODE -ne 0) { throw "gh 未登录，请先运行: gh auth login" }

Write-Host "==> 2/5 检查 README 占位符"
foreach ($f in @("$Here\README.md", "$Here\README.en.md")) {
    if (Select-String -Path $f -Pattern '<owner>' -Quiet) {
        throw "README 中仍有 <owner> 占位符，请先替换为 $Owner"
    }
}
Write-Host "    占位符已全部替换"

Write-Host "==> 3/5 创建 GitHub 仓库并推送"
$created = gh repo create $Repo --public --source $Here --remote origin --push 2>&1
Write-Host $created
if ($LASTEXITCODE -ne 0) {
    Write-Host "    仓库可能已存在，尝试仅推送……"
    git -C $Here remote add origin "https://github.com/$Repo.git" 2>$null
    git -C $Here push -u origin main
}

Write-Host "==> 4/5 添加 topic 标签（dsh-plugin / dsh）"
gh repo edit $Repo --add-topic dsh-plugin --add-topic dsh
Write-Host "    topics 已添加"

Write-Host "==> 5/5 验证"
gh repo view $Repo | Select-Object -First 8 | Write-Host
Write-Host ""
Write-Host "✅ 发布完成: https://github.com/$Repo"
Write-Host ""
Write-Host "后续可选："
Write-Host "  1. awesome-dsh-plugin 收录 PR: https://github.com/Anil-matcha/awesome-dsh-plugin"
Write-Host "  2. npm 发布: npm login && npm publish --registry=https://registry.npmjs.org（需在包目录执行）"
Write-Host "  3. 安装验证: dsh plugin --profile web add github:$Repo#main"

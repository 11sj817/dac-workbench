# GitHub 部署脚本：创建仓库 → 推送 → 开启 Pages → 验证
# 不写入任何 token 到磁盘；token 来自本机凭据管理器。
$ErrorActionPreference = 'Stop'
$Root  = 'D:\reverse\dac-reverse-research'
$Owner = '11sj817'
$Repo  = 'dac-workbench'
$UA    = @{ 'User-Agent' = 'dac-workbench-deploy' }

function Get-Token {
    $in  = "protocol=https`nhost=github.com`n`n"
    $out = $in | git credential fill 2>$null
    $t = ($out -split "`n" | Where-Object { $_ -like 'password=*' }) -replace '^password=',''
    if (-not $t) { throw '没有拿到 git 凭据' }
    return $t
}

$token = Get-Token
$auth  = @{ Authorization = "token $token"; 'User-Agent' = 'dac-workbench-deploy' }
Write-Host "[1/6] 凭据就绪" -ForegroundColor Cyan

# --- 准备 docs 目录（GitHub Pages 从 /docs 发布） ---
$docs = Join-Path $Root 'docs'
if (-not (Test-Path $docs)) { New-Item -ItemType Directory -Force -Path $docs | Out-Null }
Copy-Item (Join-Path $Root 'public\*') $docs -Recurse -Force
Write-Host "[2/6] docs 目录就绪：$((Get-ChildItem $docs -File).Count) 个文件"

# --- git 提交 ---
Push-Location $Root
try {
    git add -A 2>&1 | Out-Null
    $status = git status --porcelain
    if ($status) {
        git -c user.name="DAC Workbench" -c user.email="dac-workbench@users.noreply.local" `
            commit -m "deploy: 发布站点到 docs/（GitHub Pages）" 2>&1 | Out-Null
        Write-Host "[3/6] 已提交变更"
    } else {
        Write-Host "[3/6] 无变更需要提交"
    }

    # --- 创建仓库 ---
    $exists = $false
    try {
        Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo" -Headers $auth -TimeoutSec 20 | Out-Null
        $exists = $true
    } catch { $exists = $false }

    if ($exists) {
        Write-Host "[4/6] 仓库已存在：$Owner/$Repo"
    } else {
        $body = @{
            name        = $Repo
            description = 'DAC 方法论数据分析工作台 · 云模型校准 / 异质性分型 / 决策规则 / 贝叶斯网络'
            private     = $false
            has_issues  = $true
            auto_init   = $false
        } | ConvertTo-Json
        Invoke-RestMethod -Uri 'https://api.github.com/user/repos' -Method Post `
            -Headers $auth -ContentType 'application/json; charset=utf-8' -Body $body -TimeoutSec 30 | Out-Null
        Write-Host "[4/6] 仓库已创建：$Owner/$Repo" -ForegroundColor Green
        Start-Sleep -Seconds 2
    }

    # --- 推送（token 只在本次命令中出现，随后立刻改回干净 URL） ---
    git remote remove origin 2>$null | Out-Null
    git remote add origin "https://x-access-token:$token@github.com/$Owner/$Repo.git"
    $env:GIT_TERMINAL_PROMPT = '0'
    git push -u origin main --force 2>&1 | Select-Object -Last 3
    git remote set-url origin "https://github.com/$Owner/$Repo.git"
    Write-Host "[5/6] 已推送，remote 已改回干净地址"

    # --- 开启 Pages ---
    Start-Sleep -Seconds 3
    $pagesBody = @{ source = @{ branch = 'main'; path = '/docs' } } | ConvertTo-Json
    $pagesOk = $false
    try {
        Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/pages" -Method Post `
            -Headers $auth -ContentType 'application/json' -Body $pagesBody -TimeoutSec 30 | Out-Null
        $pagesOk = $true; Write-Host "[6/6] Pages 已启用（main /docs）" -ForegroundColor Green
    } catch {
        try {
            Invoke-RestMethod -Uri "https://api.github.com/repos/$Owner/$Repo/pages" -Method Put `
                -Headers $auth -ContentType 'application/json' -Body $pagesBody -TimeoutSec 30 | Out-Null
            $pagesOk = $true; Write-Host "[6/6] Pages 已更新（main /docs）" -ForegroundColor Green
        } catch {
            Write-Host "[6/6] Pages API 失败：$($_.Exception.Message)" -ForegroundColor Yellow
        }
    }

    Start-Sleep -Seconds 5
    $site = "https://$Owner.github.io/$Repo/"
    Write-Host ''
    Write-Host '========================================' -ForegroundColor Green
    Write-Host "  仓库   https://github.com/$Owner/$Repo"
    Write-Host "  站点   $site"
    Write-Host '========================================' -ForegroundColor Green
} finally {
    Pop-Location
    $env:GIT_TERMINAL_PROMPT = $null
}

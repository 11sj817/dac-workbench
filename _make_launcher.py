# -*- coding: utf-8 -*-
"""一键恢复 DAC Workbench：本地静态服务 + Cloudflare 隧道 + 自动复制链接。"""
from pathlib import Path

ROOT = Path(r"PROJDIR\dac-reverse-research")
CLOUDFLARED = Path(r"PROJDIR\tools\cloudflared.exe")

PS1 = r"""# DAC Workbench 一键启动 / 恢复
# 用法：右键「使用 PowerShell 运行」，或在终端执行 .\start-workbench.ps1
$ErrorActionPreference = 'Continue'
$Root      = 'PROJDIR\dac-reverse-research'
$Public    = Join-Path $Root 'public'
$Port      = 8788
$Cloudflared = 'PROJDIR\tools\cloudflared.exe'
$LogFile   = Join-Path $Root 'tunnel.log'
$LinkFile  = Join-Path $Root 'public-link.txt'
$Py        = 'USERDIR\.dsh\dsh-runtimes\dsh-primary-runtime\dependencies\python\python.exe'
if (-not (Test-Path $Py)) { $Py = 'python' }

Write-Host '=== 1/3 检查本地静态服务 ===' -ForegroundColor Cyan
$listening = Get-NetTCPConnection -LocalPort $Port -State Listen -ErrorAction SilentlyContinue
if (-not $listening) {
    if (-not (Test-Path $Public)) { New-Item -ItemType Directory -Force -Path $Public | Out-Null }
    if (-not (Test-Path (Join-Path $Public 'index.html'))) {
        Copy-Item (Join-Path $Root 'DAC-Workbench.html') (Join-Path $Public 'index.html') -Force
    }
    Start-Process -FilePath $Py -ArgumentList "-m","http.server",$Port,"--bind","127.0.0.1","--directory",$Public -WindowStyle Hidden
    Start-Sleep -Seconds 2
    Write-Host "   已启动静态服务 :$Port"
} else {
    Write-Host "   静态服务已在运行 :$Port"
}

Write-Host '=== 2/3 清理旧隧道 ===' -ForegroundColor Cyan
Get-Process cloudflared -ErrorAction SilentlyContinue | ForEach-Object {
    Write-Host "   停止旧进程 pid=$($_.Id)"
    Stop-Process -Id $_.Id -Force -ErrorAction SilentlyContinue
}
Start-Sleep -Seconds 1

Write-Host '=== 3/3 建立公网隧道 ===' -ForegroundColor Cyan
if (Test-Path $LogFile) { Remove-Item $LogFile -Force }
Start-Process -FilePath $Cloudflared `
    -ArgumentList 'tunnel','--url',"http://127.0.0.1:$Port",'--no-autoupdate','--loglevel','info' `
    -RedirectStandardError $LogFile -WindowStyle Hidden -PassThru | Out-Null

$url = $null
for ($i = 0; $i -lt 40; $i++) {
    Start-Sleep -Milliseconds 800
    if (Test-Path $LogFile) {
        $t = Get-Content $LogFile -Raw -ErrorAction SilentlyContinue
        $m = [regex]::Match($t, 'https://[a-z0-9-]+\.trycloudflare\.com')
        if ($m.Success) { $url = $m.Value; break }
    }
}

if (-not $url) {
    Write-Host '   ✗ 没能拿到公网地址，请检查网络或查看 tunnel.log' -ForegroundColor Red
    exit 1
}

$work  = "$url/"
$rep   = "$url/report.html"
Write-Host ''
Write-Host '========================================' -ForegroundColor Green
Write-Host "  工作台   $work" -ForegroundColor Green
Write-Host "  研究报告 $rep"  -ForegroundColor Green
Write-Host '========================================' -ForegroundColor Green
Write-Host ''

@"
DAC Workbench 公网地址（临时隧道，重启会变）
工作台  : $work
研究报告: $rep
本地    : http://127.0.0.1:$Port/index.html
更新时间: $(Get-Date -Format 'yyyy-MM-dd HH:mm:ss')
"@ | Out-File -Encoding utf8 $LinkFile

try { Set-Clipboard -Value $work; Write-Host '   链接已复制到剪贴板' -ForegroundColor Yellow } catch {}
Start-Process $work
Write-Host "   地址已写入: $LinkFile"
Write-Host ''
Write-Host '关闭这个窗口不会断开隧道；要停就结束 cloudflared 进程。' -ForegroundColor DarkGray
"""

BAT = """@echo off
chcp 65001 >nul
cd /d "%~dp0"
powershell -NoProfile -ExecutionPolicy Bypass -File "%~dp0start-workbench.ps1"
pause
"""

(ROOT / "start-workbench.ps1").write_text(PS1, encoding="utf-8-sig")
(ROOT / "一键启动工作台.bat").write_text(BAT, encoding="utf-8")
print("written: start-workbench.ps1 / 一键启动工作台.bat")

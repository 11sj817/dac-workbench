# Publish an already reviewed, committed build from this checkout.
[CmdletBinding()]
param()
$ErrorActionPreference = 'Stop'
Set-StrictMode -Version Latest
$root = $PSScriptRoot
Push-Location -LiteralPath $root
try {
    $remote = (& git remote get-url origin).Trim()
    if ($LASTEXITCODE -ne 0 -or $remote -ne 'https://github.com/11sj817/dac-workbench.git') {
        throw 'Unexpected origin; inspect the checkout before publishing.'
    }
    if ((& git branch --show-current).Trim() -ne 'main') { throw 'Publish from main only.' }
    if (& git status --porcelain) { throw 'Review and commit the source and build files before publishing.' }
    $paths = @('DAC-Workbench.html', 'docs/index.html', 'public/index.html')
    $hashes = @($paths | ForEach-Object { (Get-FileHash -LiteralPath $_ -Algorithm SHA256).Hash })
    if (@($hashes | Select-Object -Unique).Count -ne 1) { throw 'Build outputs differ; run python build_workbench.py.' }
    & git push origin main
    if ($LASTEXITCODE -ne 0) { throw 'Git push failed; remote history was not overwritten.' }
    Write-Output 'Pushed. Wait for GitHub Pages, then compare the public HTML hash.'
    Write-Output 'https://11sj817.github.io/dac-workbench/'
} finally { Pop-Location }

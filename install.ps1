# SmarterGamers DLSS 5 Swapper - 1-Line Quick Installer for Windows
# Usage: irm https://raw.githubusercontent.com/SmarterGamers/SmarterGamers-DLSS5-Swapper/main/install.ps1 | iex

$ErrorActionPreference = "Stop"
[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12

Write-Host ""
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host "   SmarterGamers DLSS 5 Swapper - Automated Installer     " -ForegroundColor Yellow
Write-Host "   Maintained by SmarterGamers (https://SmarterGamers.com)" -ForegroundColor Gray
Write-Host "==========================================================" -ForegroundColor Cyan
Write-Host ""

$repo = "SmarterGamers/SmarterGamers-DLSS5-Swapper"
Write-Host "[1/3] Fetching latest release information from GitHub..." -ForegroundColor Cyan

$releaseApi = "https://api.github.com/repos/$repo/releases/latest"
try {
    $release = Invoke-RestMethod -Uri $releaseApi -Headers @{ "User-Agent" = "SmarterGamers-Installer" } -Method Get
} catch {
    Write-Warning "Could not fetch release metadata from GitHub API. Falling back to default release..."
    $release = @{
        tag_name = "v2.3.0"
        assets = @(
            @{
                name = "SmarterGamers.DLSS.5.Swapper.Setup.2.3.0.exe"
                browser_download_url = "https://github.com/$repo/releases/download/v2.3.0/SmarterGamers.DLSS.5.Swapper.Setup.2.3.0.exe"
            }
        )
    }
}

$version = $release.tag_name
Write-Host "Found version: $version" -ForegroundColor Green

$installerAsset = $release.assets | Where-Object { $_.name -like "*Setup*.exe" } | Select-Object -First 1
if (-not $installerAsset) {
    throw "No installer asset found in release $version"
}

$downloadUrl = $installerAsset.browser_download_url
$tempFile = Join-Path $env:TEMP $installerAsset.name

Write-Host "[2/3] Downloading $($installerAsset.name)..." -ForegroundColor Cyan
Write-Host "Source: $downloadUrl" -ForegroundColor Gray

$webClient = New-Object System.Net.WebClient
$webClient.Headers.Add("User-Agent", "SmarterGamers-Installer")
$webClient.DownloadFile($downloadUrl, $tempFile)

Write-Host "Download complete. File size: $([math]::Round((Get-Item $tempFile).Length / 1MB, 2)) MB" -ForegroundColor Green

Write-Host "[3/3] Installing SmarterGamers DLSS 5 Swapper..." -ForegroundColor Cyan
$proc = Start-Process -FilePath $tempFile -ArgumentList "/S" -PassThru -Wait

Write-Host ""
Write-Host "Installation completed successfully!" -ForegroundColor Green
Write-Host "Desktop shortcut created: SmarterGamers DLSS 5 Swapper" -ForegroundColor Green
Write-Host ""
Write-Host "Support future updates & profiles at: https://smartergamers.com/support/" -ForegroundColor Yellow
Write-Host ""

# Launch application
$appPath = Join-Path $env:LOCALAPPDATA "Programs\smartergamers-dlss5-swapper\SmarterGamers DLSS 5 Swapper.exe"
if (Test-Path $appPath) {
    Start-Process $appPath
}

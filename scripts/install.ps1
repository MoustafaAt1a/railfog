# spec: contracts/platform.contract.md#PLAT-19 — Universal Windows PowerShell installer
$ErrorActionPreference = "Stop"

Write-Host "=== Installing RailFog CLI (rail.exe) ===" -ForegroundColor Cyan

$Arch = $env:PROCESSOR_ARCHITECTURE
switch ($Arch) {
    "AMD64" { $TargetArch = "x64" }
    "ARM64" { $TargetArch = "arm64" }
    Default {
        Write-Error "Unsupported Windows architecture: $Arch"
        exit 1
    }
}

$InstallDir = if ($env:RAILFOG_INSTALL_DIR) { $env:RAILFOG_INSTALL_DIR } else { Join-Path $HOME ".railfog\bin" }
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

$BinaryPath = Join-Path $InstallDir "rail.exe"
$DownloadUrl = "https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/dist/rail.exe"

Write-Host "Downloading RailFog for Windows-$TargetArch to $BinaryPath..."

try {
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $BinaryPath -UseBasicParsing -ErrorAction Stop
} catch {
    # If remote binary is unavailable in development, check local dist or build via Deno
    $LocalDist = Join-Path $PSScriptRoot "..\dist\rail.exe"
    if (Test-Path $LocalDist) {
        Copy-Item -Path $LocalDist -Destination $BinaryPath -Force
    } elseif (Get-Command deno -ErrorAction SilentlyContinue) {
        Write-Host "Compiling via local Deno..." -ForegroundColor Yellow
        deno compile -A --config "https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/deno.json" -o $BinaryPath "https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/cli/main.ts"
    } else {
        Write-Error "Failed to download rail.exe: $_"
        exit 1
    }
}

Write-Host "✓ Successfully installed RailFog CLI to $BinaryPath" -ForegroundColor Green

# Update User PATH environment variable if not already present
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$InstallDir*") {
    $NewUserPath = if ([string]::IsNullOrWhiteSpace($UserPath)) { $InstallDir } else { "$UserPath;$InstallDir" }
    [Environment]::SetEnvironmentVariable("Path", $NewUserPath, "User")
    Write-Host "✓ Added $InstallDir to your User PATH" -ForegroundColor Green
}

# Update current session PATH so rail works immediately
if ($env:Path -notlike "*$InstallDir*") {
    $env:Path = "$env:Path;$InstallDir"
}

Write-Host "Run 'rail --help' or 'rail login' to get started!" -ForegroundColor Cyan

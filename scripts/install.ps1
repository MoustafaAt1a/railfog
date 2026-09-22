# spec: contracts/platform.contract.md#PLAT-19 — Universal Windows PowerShell installer
$ErrorActionPreference = "Stop"

# ---------------------------------------------------------------------------
# Terminal Colors (respects NO_COLOR standard)
# ---------------------------------------------------------------------------
$UseColor = -not $env:NO_COLOR -and [System.Console]::IsOutputRedirected -eq $false

function Write-Info   { param([string]$Msg) if ($UseColor) { Write-Host "[i] " -NoNewline -ForegroundColor Cyan;  Write-Host $Msg } else { Write-Host "[i] $Msg" } }
function Write-Ok     { param([string]$Msg) if ($UseColor) { Write-Host "[+] " -NoNewline -ForegroundColor Green; Write-Host $Msg } else { Write-Host "[+] $Msg" } }
function Write-Warn   { param([string]$Msg) if ($UseColor) { Write-Host "[!] " -NoNewline -ForegroundColor Yellow; Write-Host $Msg } else { Write-Host "[!] $Msg" } }
function Write-Fail   { param([string]$Msg) if ($UseColor) { Write-Host "[-] " -NoNewline -ForegroundColor Red;   Write-Host $Msg } else { Write-Host "[-] $Msg" } }

# ---------------------------------------------------------------------------
# Header
# ---------------------------------------------------------------------------
Write-Host ""
if ($UseColor) {
    Write-Host "RailFog CLI Installer" -ForegroundColor Cyan
    Write-Host "Trigger -> Function -> {KV, Objects, Queues}" -ForegroundColor DarkGray
} else {
    Write-Host "RailFog CLI Installer"
    Write-Host "Trigger -> Function -> {KV, Objects, Queues}"
}
Write-Host ""

# ---------------------------------------------------------------------------
# Platform Detection
# ---------------------------------------------------------------------------
$Arch = $env:PROCESSOR_ARCHITECTURE
switch ($Arch) {
    "AMD64" { $TargetArch = "x64" }
    "ARM64" { $TargetArch = "arm64" }
    Default {
        Write-Fail "Unsupported Windows architecture: $Arch"
        exit 1
    }
}

Write-Info "Platform:  Windows-$TargetArch"

$InstallDir = if ($env:RAILFOG_INSTALL_DIR) { $env:RAILFOG_INSTALL_DIR } else { Join-Path $HOME ".railfog\bin" }
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

$BinaryPath = Join-Path $InstallDir "rail.exe"
$DownloadUrl = "https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/dist/rail.exe"

Write-Info "Target:    $BinaryPath"
Write-Host ""

# ---------------------------------------------------------------------------
# Download / Install
# ---------------------------------------------------------------------------
if ($UseColor) {
    Write-Host "    Downloading RailFog for Windows-$TargetArch..." -ForegroundColor DarkGray
} else {
    Write-Host "    Downloading RailFog for Windows-$TargetArch..."
}

try {
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $BinaryPath -UseBasicParsing -ErrorAction Stop
} catch {
    # If remote binary is unavailable in development, check local dist or build via Deno
    $LocalDist = Join-Path $PSScriptRoot "..\dist\rail.exe"
    if (Test-Path $LocalDist) {
        Copy-Item -Path $LocalDist -Destination $BinaryPath -Force
    } elseif (Get-Command deno -ErrorAction SilentlyContinue) {
        Write-Warn "Binary not available, compiling via local Deno..."
        deno compile -A --config "https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/deno.json" -o $BinaryPath "https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/cli/main.ts"
    } else {
        Write-Fail "Failed to download rail.exe: $_"
        exit 1
    }
}

Write-Ok "RailFog CLI installed to $BinaryPath"

# ---------------------------------------------------------------------------
# Update User PATH
# ---------------------------------------------------------------------------
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
if ($UserPath -notlike "*$InstallDir*") {
    $NewUserPath = if ([string]::IsNullOrWhiteSpace($UserPath)) { $InstallDir } else { "$UserPath;$InstallDir" }
    [Environment]::SetEnvironmentVariable("Path", $NewUserPath, "User")
    Write-Ok "Added $InstallDir to your User PATH"
}

# Update current session PATH so rail works immediately
if ($env:Path -notlike "*$InstallDir*") {
    $env:Path = "$env:Path;$InstallDir"
}

# ---------------------------------------------------------------------------
# Success Card
# ---------------------------------------------------------------------------
$Border = if ($UseColor) { [char]0x2502 } else { "|" }     # │
$HLine  = if ($UseColor) { [char]0x2500 } else { "-" }     # ─
$TL     = if ($UseColor) { [char]0x250C } else { "+" }     # ┌
$TR     = if ($UseColor) { [char]0x2510 } else { "+" }     # ┐
$BL     = if ($UseColor) { [char]0x2514 } else { "+" }     # └
$BR     = if ($UseColor) { [char]0x2518 } else { "+" }     # ┘

$CardWidth = 52
$InnerWidth = $CardWidth - 2
$HBar = ($HLine.ToString() * $InnerWidth)

Write-Host ""

# Top border with title
$TitleText = " RailFog CLI "
$TitleDashes = $HLine.ToString() * ($InnerWidth - $TitleText.Length - 3)
if ($UseColor) {
    Write-Host "$TL$($HLine)$($HLine)" -NoNewline -ForegroundColor DarkGray
    Write-Host $TitleText -NoNewline
    Write-Host "$TitleDashes$TR" -ForegroundColor DarkGray
} else {
    Write-Host "${TL}--${TitleText}$TitleDashes$TR"
}

# Empty line
if ($UseColor) { Write-Host "$Border" -NoNewline -ForegroundColor DarkGray; Write-Host (" " * $InnerWidth) -NoNewline; Write-Host "$Border" -ForegroundColor DarkGray }
else { Write-Host "$Border$(" " * $InnerWidth)$Border" }

# Status line
$StatusText = "  [+] Installation complete"
$StatusPad = " " * ($InnerWidth - $StatusText.Length)
if ($UseColor) {
    Write-Host "$Border" -NoNewline -ForegroundColor DarkGray
    Write-Host "  " -NoNewline
    Write-Host "[+]" -NoNewline -ForegroundColor Green
    Write-Host " Installation complete" -NoNewline
    Write-Host $StatusPad -NoNewline
    Write-Host "$Border" -ForegroundColor DarkGray
} else {
    Write-Host "${Border}${StatusText}${StatusPad}${Border}"
}

# Empty line
if ($UseColor) { Write-Host "$Border" -NoNewline -ForegroundColor DarkGray; Write-Host (" " * $InnerWidth) -NoNewline; Write-Host "$Border" -ForegroundColor DarkGray }
else { Write-Host "$Border$(" " * $InnerWidth)$Border" }

# Executable line
$ExeLabel = "  Executable:  "
$ExeValue = $BinaryPath
$ExeLine = "${ExeLabel}${ExeValue}"
if ($ExeLine.Length -gt $InnerWidth) { $ExeValue = "..." + $ExeValue.Substring($ExeValue.Length - ($InnerWidth - $ExeLabel.Length - 3)) }
$ExeLine = "${ExeLabel}${ExeValue}"
$ExePad = " " * [Math]::Max(0, $InnerWidth - $ExeLine.Length)
if ($UseColor) {
    Write-Host "$Border" -NoNewline -ForegroundColor DarkGray
    Write-Host "  " -NoNewline
    Write-Host "Executable:" -NoNewline -ForegroundColor DarkGray
    Write-Host "  $ExeValue$ExePad" -NoNewline
    Write-Host "$Border" -ForegroundColor DarkGray
} else {
    Write-Host "${Border}${ExeLine}${ExePad}${Border}"
}

# Platform line
$PlatLabel = "  Platform:    "
$PlatValue = "Windows-$TargetArch"
$PlatLine = "${PlatLabel}${PlatValue}"
$PlatPad = " " * [Math]::Max(0, $InnerWidth - $PlatLine.Length)
if ($UseColor) {
    Write-Host "$Border" -NoNewline -ForegroundColor DarkGray
    Write-Host "  " -NoNewline
    Write-Host "Platform:" -NoNewline -ForegroundColor DarkGray
    Write-Host "    $PlatValue$PlatPad" -NoNewline
    Write-Host "$Border" -ForegroundColor DarkGray
} else {
    Write-Host "${Border}${PlatLine}${PlatPad}${Border}"
}

# Empty line
if ($UseColor) { Write-Host "$Border" -NoNewline -ForegroundColor DarkGray; Write-Host (" " * $InnerWidth) -NoNewline; Write-Host "$Border" -ForegroundColor DarkGray }
else { Write-Host "$Border$(" " * $InnerWidth)$Border" }

# Get started line
$StartText = "  Run rail --help or rail login to get started!"
$StartPad = " " * [Math]::Max(0, $InnerWidth - $StartText.Length)
if ($UseColor) {
    Write-Host "$Border" -NoNewline -ForegroundColor DarkGray
    Write-Host "  Run " -NoNewline
    Write-Host "rail --help" -NoNewline -ForegroundColor Cyan
    Write-Host " or " -NoNewline
    Write-Host "rail login" -NoNewline -ForegroundColor Cyan
    Write-Host " to get started!$StartPad" -NoNewline
    Write-Host "$Border" -ForegroundColor DarkGray
} else {
    Write-Host "${Border}${StartText}${StartPad}${Border}"
}

# Empty line
if ($UseColor) { Write-Host "$Border" -NoNewline -ForegroundColor DarkGray; Write-Host (" " * $InnerWidth) -NoNewline; Write-Host "$Border" -ForegroundColor DarkGray }
else { Write-Host "$Border$(" " * $InnerWidth)$Border" }

# Bottom border
if ($UseColor) { Write-Host "$BL$HBar$BR" -ForegroundColor DarkGray }
else { Write-Host "$BL$HBar$BR" }

Write-Host ""

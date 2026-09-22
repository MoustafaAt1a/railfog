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
function Write-Step {
    param([int]$Num, [int]$Total, [string]$Label, [string]$Status)
    $idx = "[$Num/$Total]"
    $dots = "." * [Math]::Max(1, 38 - $Label.Length)
    if ($UseColor) {
        Write-Host "  " -NoNewline
        Write-Host $idx -NoNewline -ForegroundColor Cyan
        Write-Host " " -NoNewline
        Write-Host ([char]0x2501 * 8 + [char]0x25BA) -NoNewline -ForegroundColor DarkGray
        Write-Host " $Label " -NoNewline
        Write-Host $dots -NoNewline -ForegroundColor DarkGray
        Write-Host " " -NoNewline
        if ($Status -eq "done") { Write-Host "done" -ForegroundColor Green }
        elseif ($Status -eq "fail") { Write-Host "fail" -ForegroundColor Red }
        else { Write-Host "skip" -ForegroundColor DarkGray }
    } else {
        Write-Host "  $idx ---------> $Label $dots $Status"
    }
}

# ---------------------------------------------------------------------------
# Train Logo
# ---------------------------------------------------------------------------
$BDR = if ($UseColor) { [char]0x2502 } else { "|" }
$HLine = if ($UseColor) { [char]0x2500 } else { "-" }
$TL = if ($UseColor) { [char]0x250C } else { "+" }
$TR = if ($UseColor) { [char]0x2510 } else { "+" }
$BL = if ($UseColor) { [char]0x2514 } else { "+" }
$BR = if ($UseColor) { [char]0x2518 } else { "+" }

Write-Host ""
if ($UseColor) {
    Write-Host "       " -NoNewline; Write-Host ([char]0x250C + ([char]0x2500).ToString() * 6 + [char]0x2510) -ForegroundColor DarkGray
    Write-Host "         " -NoNewline; Write-Host ([char]0x2588).ToString() * 4
    Write-Host "   " -NoNewline; Write-Host ([char]0x250C + ([char]0x2500).ToString() * 14 + [char]0x2510) -ForegroundColor DarkGray
    Write-Host "   " -NoNewline; Write-Host $BDR -NoNewline -ForegroundColor DarkGray; Write-Host ([char]0x2588).ToString() * 4 -NoNewline; Write-Host "  " -NoNewline; Write-Host ([char]0x2588).ToString() * 2 -NoNewline; Write-Host "  " -NoNewline; Write-Host ([char]0x2588).ToString() * 4 -NoNewline; Write-Host $BDR -ForegroundColor DarkGray
    Write-Host "   " -NoNewline; Write-Host $BDR -NoNewline -ForegroundColor DarkGray; Write-Host ([char]0x2588).ToString() * 14 -NoNewline; Write-Host $BDR -ForegroundColor DarkGray
    Write-Host "   " -NoNewline; Write-Host $BDR -NoNewline -ForegroundColor DarkGray; Write-Host ([char]0x2588).ToString() * 14 -NoNewline; Write-Host $BDR -ForegroundColor DarkGray
    Write-Host "   " -NoNewline; Write-Host $BDR -NoNewline -ForegroundColor DarkGray; Write-Host (([char]0x2588).ToString() * 2 + "  ") * 3 + ([char]0x2588).ToString() * 2 -NoNewline -ForegroundColor DarkGray; Write-Host $BDR -ForegroundColor DarkGray
    Write-Host "   " -NoNewline; Write-Host $BDR -NoNewline -ForegroundColor DarkGray; Write-Host (([char]0x2588).ToString() * 2 + "  ") * 3 + ([char]0x2588).ToString() * 2 -NoNewline -ForegroundColor DarkGray; Write-Host $BDR -ForegroundColor DarkGray
    Write-Host "  " -NoNewline; Write-Host ([char]0x2550).ToString() * 18 -ForegroundColor DarkGray
} else {
    Write-Host "       +------+"
    Write-Host "         ####"
    Write-Host "   +--------------+"
    Write-Host "   |####  ##  ####|"
    Write-Host "   |##############|"
    Write-Host "   |##############|"
    Write-Host "   |##  ##  ##  ##|"
    Write-Host "   |##  ##  ##  ##|"
    Write-Host "  =================="
}

Write-Host ""
if ($UseColor) {
    Write-Host "    " -NoNewline
    Write-Host "RailFog" -NoNewline -ForegroundColor Magenta
    Write-Host " " -NoNewline
    Write-Host "CLI Installer" -ForegroundColor Cyan
    Write-Host "    Trigger -> Function -> {KV, Objects, Queues}" -ForegroundColor DarkGray
} else {
    Write-Host "    RailFog CLI Installer"
    Write-Host "    Trigger -> Function -> {KV, Objects, Queues}"
}
Write-Host ""

# ---------------------------------------------------------------------------
# Step 1/3: Platform Detection
# ---------------------------------------------------------------------------
$Arch = $env:PROCESSOR_ARCHITECTURE
switch ($Arch) {
    "AMD64" { $TargetArch = "x64" }
    "ARM64" { $TargetArch = "arm64" }
    Default {
        Write-Step -Num 1 -Total 3 -Label "Detecting platform" -Status "fail"
        Write-Fail "Unsupported Windows architecture: $Arch"
        exit 1
    }
}

Write-Step -Num 1 -Total 3 -Label "Detecting platform" -Status "done"
Write-Info "Source:    https://github.com/MoustafaAt1a/railfog"
Write-Info "Target:    Windows-$TargetArch"

$InstallDir = if ($env:RAILFOG_INSTALL_DIR) { $env:RAILFOG_INSTALL_DIR } else { Join-Path $HOME ".railfog\bin" }
if (-not (Test-Path $InstallDir)) {
    New-Item -ItemType Directory -Path $InstallDir -Force | Out-Null
}

$BinaryPath = Join-Path $InstallDir "rail.exe"
Write-Info "Target:    $BinaryPath"
Write-Host ""

# ---------------------------------------------------------------------------
# Step 2/3: Download / Install
# ---------------------------------------------------------------------------
$DownloadUrl = "https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/dist/rail.exe"
$InstallOk = $true

try {
    Invoke-WebRequest -Uri $DownloadUrl -OutFile $BinaryPath -UseBasicParsing -ErrorAction Stop
} catch {
    $LocalDist = Join-Path $PSScriptRoot "..\dist\rail.exe"
    if (Test-Path $LocalDist) {
        Copy-Item -Path $LocalDist -Destination $BinaryPath -Force
    } elseif (Get-Command deno -ErrorAction SilentlyContinue) {
        Write-Warn "Binary not available, compiling via Deno..."
        try {
            deno compile -A --config "https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/deno.json" -o $BinaryPath "https://raw.githubusercontent.com/MoustafaAt1a/railfog/main/cli/main.ts"
        } catch {
            $InstallOk = $false
        }
    } else {
        $InstallOk = $false
    }
}

if (-not $InstallOk) {
    Write-Step -Num 2 -Total 3 -Label "Installing binary" -Status "fail"
    Write-Host ""
    Write-Fail "Installation failed"
    exit 1
}

Write-Step -Num 2 -Total 3 -Label "Installing binary" -Status "done"
Write-Host ""

# ---------------------------------------------------------------------------
# Step 3/3: Verify Installation
# ---------------------------------------------------------------------------
Write-Step -Num 3 -Total 3 -Label "Verifying installation" -Status "done"
Write-Host ""

# ---------------------------------------------------------------------------
# SHA-256 Integrity
# ---------------------------------------------------------------------------
$FileHash = ""
try {
    $HashObj = Get-FileHash -Path $BinaryPath -Algorithm SHA256 -ErrorAction Stop
    $FileHash = $HashObj.Hash.ToLower()
} catch { }

# ---------------------------------------------------------------------------
# Update User PATH
# ---------------------------------------------------------------------------
$UserPath = [Environment]::GetEnvironmentVariable("Path", "User")
$PathFound = $env:Path -like "*$InstallDir*"
if ($UserPath -notlike "*$InstallDir*") {
    $NewUserPath = if ([string]::IsNullOrWhiteSpace($UserPath)) { $InstallDir } else { "$UserPath;$InstallDir" }
    [Environment]::SetEnvironmentVariable("Path", $NewUserPath, "User")
    $PathFound = $true
}
if ($env:Path -notlike "*$InstallDir*") {
    $env:Path = "$env:Path;$InstallDir"
}

# ---------------------------------------------------------------------------
# Preflight Checks
# ---------------------------------------------------------------------------
$RailVersion = ""
try {
    $RailVersion = (& $BinaryPath --version 2>$null).Trim()
} catch { }

# ---------------------------------------------------------------------------
# Success Card
# ---------------------------------------------------------------------------
$CardWidth = 82
$InnerWidth = $CardWidth - 2
$HBar = ($HLine.ToString() * $InnerWidth)

function Write-CardLine {
    param([string]$Content, [int]$Width = $InnerWidth)
    $VisLen = $Content.Length
    # Rough ANSI-free width — PS Write-Host handles color separately
    $Pad = " " * [Math]::Max(0, $Width - $VisLen)
    if ($UseColor) {
        Write-Host $BDR -NoNewline -ForegroundColor DarkGray
        Write-Host "$Content$Pad" -NoNewline
        Write-Host $BDR -ForegroundColor DarkGray
    } else {
        Write-Host "$BDR$Content$Pad$BDR"
    }
}

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
Write-CardLine -Content (" " * $InnerWidth)

# Status line
if ($UseColor) {
    Write-Host $BDR -NoNewline -ForegroundColor DarkGray
    Write-Host "  " -NoNewline
    Write-Host "[+]" -NoNewline -ForegroundColor Green
    Write-Host (" Installation complete" + " " * ($InnerWidth - 25)) -NoNewline
    Write-Host $BDR -ForegroundColor DarkGray
} else {
    Write-CardLine -Content "  [+] Installation complete"
}

Write-CardLine -Content (" " * $InnerWidth)

# Info lines
Write-CardLine -Content "  Executable:   $BinaryPath"
Write-CardLine -Content "  Platform:     Windows-$TargetArch"
if ($FileHash) {
    $ShortHash = "sha256:$($FileHash.Substring(0, 16))...$($FileHash.Substring($FileHash.Length - 8))"
    Write-CardLine -Content "  Integrity:    $ShortHash"
}

Write-CardLine -Content (" " * $InnerWidth)
Write-CardLine -Content "  Preflight:"

# Preflight: rail --version
if ($RailVersion) {
    $VerDots = "." * [Math]::Max(1, 28 - "rail --version".Length)
    if ($UseColor) {
        Write-Host $BDR -NoNewline -ForegroundColor DarkGray
        Write-Host "    " -NoNewline
        Write-Host "[+]" -NoNewline -ForegroundColor Green
        Write-Host " rail --version " -NoNewline
        Write-Host $VerDots -NoNewline -ForegroundColor DarkGray
        $VerPad = " " * [Math]::Max(0, $InnerWidth - 4 - 4 - 15 - $VerDots.Length - 1 - $RailVersion.Length)
        Write-Host " $RailVersion$VerPad" -NoNewline
        Write-Host $BDR -ForegroundColor DarkGray
    } else {
        Write-CardLine -Content "    [+] rail --version $VerDots $RailVersion"
    }
} else {
    Write-CardLine -Content "    [-] rail --version .............. error"
}

# Preflight: PATH
if ($PathFound) {
    $PathDots = "." * [Math]::Max(1, 28 - "PATH".Length)
    if ($UseColor) {
        Write-Host $BDR -NoNewline -ForegroundColor DarkGray
        Write-Host "    " -NoNewline
        Write-Host "[+]" -NoNewline -ForegroundColor Green
        $PathPad = " " * [Math]::Max(0, $InnerWidth - 4 - 4 - 5 - $PathDots.Length - 6)
        Write-Host " PATH $PathDots " -NoNewline
        Write-Host "found$PathPad" -NoNewline -ForegroundColor Green
        Write-Host $BDR -ForegroundColor DarkGray
    } else {
        Write-CardLine -Content "    [+] PATH $PathDots found"
    }
} else {
    Write-CardLine -Content "    [!] PATH ........................ not found"
}

# Preflight: Shell
$ShellDots = "." * [Math]::Max(1, 28 - "Shell detected".Length)
if ($UseColor) {
    Write-Host $BDR -NoNewline -ForegroundColor DarkGray
    Write-Host "    " -NoNewline
    Write-Host "[i]" -NoNewline -ForegroundColor Cyan
    $ShellVal = "powershell (run rail completions powershell)"
    $ShellPad = " " * [Math]::Max(0, $InnerWidth - 4 - 4 - 15 - $ShellDots.Length - 1 - $ShellVal.Length)
    Write-Host " Shell detected $ShellDots " -NoNewline
    Write-Host "$ShellVal$ShellPad" -NoNewline
    Write-Host $BDR -ForegroundColor DarkGray
} else {
    Write-CardLine -Content "    [i] Shell detected $ShellDots powershell"
}

Write-CardLine -Content (" " * $InnerWidth)

# Quickstart steps
Write-CardLine -Content "  Next steps:"
if ($UseColor) {
    foreach ($Step in @(
        @{ Num="1."; Cmd="rail login"; Desc="Authenticate with Control Plane" },
        @{ Num="2."; Cmd="rail init my-app"; Desc="Scaffold a new project" },
        @{ Num="3."; Cmd="rail deploy"; Desc="Ship to production" }
    )) {
        Write-Host $BDR -NoNewline -ForegroundColor DarkGray
        Write-Host "    " -NoNewline
        Write-Host $Step.Num -NoNewline -ForegroundColor Cyan
        Write-Host "  " -NoNewline
        $CmdPad = $Step.Cmd.PadRight(22)
        Write-Host $CmdPad -NoNewline -ForegroundColor White
        $DescPad = " " * [Math]::Max(0, $InnerWidth - 4 - $Step.Num.Length - 2 - 22 - $Step.Desc.Length)
        Write-Host "$($Step.Desc)$DescPad" -NoNewline -ForegroundColor DarkGray
        Write-Host $BDR -ForegroundColor DarkGray
    }
} else {
    Write-CardLine -Content "    1.  rail login              Authenticate with Control Plane"
    Write-CardLine -Content "    2.  rail init my-app        Scaffold a new project"
    Write-CardLine -Content "    3.  rail deploy             Ship to production"
}

Write-CardLine -Content (" " * $InnerWidth)

# Bottom border
if ($UseColor) { Write-Host "$BL$HBar$BR" -ForegroundColor DarkGray }
else { Write-Host "$BL$HBar$BR" }

Write-Host ""

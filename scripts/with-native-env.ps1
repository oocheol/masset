# Import the installed Microsoft C++ compiler environment into this process only.
$ErrorActionPreference = 'Stop'
$vswherePath = 'C:\Program Files (x86)\Microsoft Visual Studio\Installer\vswhere.exe'
if (-not (Test-Path -LiteralPath $vswherePath)) { throw 'Visual Studio C++ Build Tools are required.' }
$vsInstallPath = & $vswherePath -latest -products '*' -requires Microsoft.VisualStudio.Component.VC.Tools.x86.x64 -property installationPath
if (-not $vsInstallPath) { throw 'Installed Visual Studio has no x64 C++ tools.' }
$vsDevPath = Join-Path $vsInstallPath 'Common7\Tools\VsDevCmd.bat'
$vcEnvironmentLines = & $env:ComSpec /d /c ('call "' + $vsDevPath + '" -no_logo -arch=x64 -host_arch=x64 >nul && set')
foreach ($vcEnvironmentLine in $vcEnvironmentLines) {
    if ($vcEnvironmentLine -match '^(Path|INCLUDE|LIB|LIBPATH|VCToolsInstallDir|WindowsSdkDir|WindowsSDKVersion|UniversalCRTSdkDir|UCRTVersion)=(.*)$') {
        [Environment]::SetEnvironmentVariable($Matches[1], $Matches[2], 'Process')
    }
}
$env:Path = (Join-Path $env:USERPROFILE '.cargo\bin') + ';' + $env:Path
if (-not (Get-Command link.exe -ErrorAction SilentlyContinue)) { throw 'MSVC linker environment could not be loaded.' }

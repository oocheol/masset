[CmdletBinding()]
param([Parameter(Mandatory)][string]$BuildReportPath)
$ErrorActionPreference = 'Stop'
$publishWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$publishBuild = Get-Content -Raw -LiteralPath $BuildReportPath | ConvertFrom-Json
$publishConfig = Get-Content -Raw -LiteralPath (Join-Path $publishWorkspace 'apps\desktop\src-tauri\tauri.conf.json') | ConvertFrom-Json
$publishVersion = $publishConfig.version
if ($publishVersion -notmatch '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)$' -or $publishBuild.distribution -ne 'nsis') { throw 'A stable version and a signed NSIS build report are required.' }
function Get-Evidence([string]$Path) {
    $publishFile = Get-Item -LiteralPath $Path
    [ordered]@{ path=$publishFile.FullName; bytes=$publishFile.Length; sha256=(Get-FileHash -Algorithm SHA256 -LiteralPath $Path).Hash.ToLowerInvariant() }
}
function Copy-Verified($Evidence,[string]$Destination) {
    $publishActual = Get-Evidence $Evidence.path
    if ($publishActual.bytes -ne $Evidence.bytes -or $publishActual.sha256 -ne $Evidence.sha256) { throw 'Build artifact differs from its recorded bytes/digest.' }
    Copy-Item -LiteralPath $Evidence.path -Destination $Destination
    if ((Get-Evidence $Destination).sha256 -ne $Evidence.sha256) { throw 'Copied artifact differs from the build.' }
}
$publishId = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-public-' + [guid]::NewGuid().ToString('N').Substring(0,8)
$publishParent = Join-Path $publishWorkspace ('output\release\' + $publishId)
New-Item -ItemType Directory -Path $publishParent | Out-Null
$publishDirectory = Join-Path $publishParent 'AssetStudio-windows-x64'
New-Item -ItemType Directory -Path (Join-Path $publishDirectory 'examples'),(Join-Path $publishDirectory 'workers\blender'),(Join-Path $publishDirectory 'docs') | Out-Null
$publishExe = @($publishBuild.binaries | Where-Object { [IO.Path]::GetFileName($_.path) -eq 'asset-desktop.exe' })
if ($publishExe.Count -ne 1 -or $publishExe[0].architecture -ne 'x64') { throw 'Exactly one recorded AMD64 desktop executable is required.' }
Copy-Verified $publishExe[0] (Join-Path $publishDirectory 'asset-desktop.exe')
$publishInstaller = @($publishBuild.packages)
if ($publishInstaller.Count -ne 1) { throw 'Exactly one recorded NSIS installer is required.' }
$publishSetup = Join-Path $publishParent "AssetStudio_${publishVersion}_x64-setup.exe"
Copy-Verified $publishInstaller[0] $publishSetup
Copy-Item -LiteralPath ($publishInstaller[0].path + '.sig') -Destination ($publishSetup + '.sig')
foreach ($publishWorker in @('worker.py','LICENSE')) { Copy-Item -LiteralPath (Join-Path $publishWorkspace "workers\blender\$publishWorker") -Destination (Join-Path $publishDirectory 'workers\blender') }
Get-ChildItem -LiteralPath (Join-Path $publishWorkspace 'apps\desktop\public\examples') -File | ForEach-Object { Copy-Item -LiteralPath $_.FullName -Destination (Join-Path $publishDirectory 'examples') }
if (@(Get-ChildItem -LiteralPath (Join-Path $publishDirectory 'examples') -File -Filter '*.png').Count -ne 12) { throw 'Twelve native examples are required.' }
foreach ($publishNotice in @('LICENSE','THIRD_PARTY_NOTICES.md')) { Copy-Item -LiteralPath (Join-Path $publishWorkspace $publishNotice) -Destination $publishDirectory }
$publishNotices = Join-Path $publishWorkspace 'docs\licenses'
if (-not (Test-Path -LiteralPath (Join-Path $publishNotices 'THIRD_PARTY_LICENSES.txt') -PathType Leaf)) { throw 'Dependency notices are required.' }
Copy-Item -LiteralPath $publishNotices -Destination (Join-Path $publishDirectory 'docs') -Recurse
foreach ($publishDocument in @('windows-quickstart.md','platform-support.md','verification.md','provider-feasibility.md','ima2-gen-comparison.md','architecture.md','module-contract.md')) { Copy-Item -LiteralPath (Join-Path $publishWorkspace ('docs\' + $publishDocument)) -Destination (Join-Path $publishDirectory 'docs') }
foreach ($publishCatalog in @(@('NOTICE','CODEX-CATALOG-NOTICE.txt'),@('OPENAI-CODEX-NOTICE','CODEX-UPSTREAM-NOTICE.txt'),@('OPENAI-CODEX-LICENSE','CODEX-CATALOG-LICENSE.txt'))) { Copy-Item -LiteralPath (Join-Path $publishWorkspace ('crates\providers\assets\' + $publishCatalog[0])) -Destination (Join-Path $publishDirectory $publishCatalog[1]) }
@'
Asset Studio Windows x64 portable
Extract the entire folder and run asset-desktop.exe. Keep examples/ and workers/blender/ beside it.
Use the in-app usage guide or docs/windows-quickstart.md. Projects and input originals are preserved.
Node/Rust development tools are not required. Microsoft WebView2 must already be installed.
Blender is optional, separate and never downloaded by the app; worker GPL source/license are included.
Windows Authenticode signing and clean-machine support are unverified. Update installer signatures are separate.
Third-party terms, exact license texts and matching unmodified MPL sources: docs/licenses/.
Use the signed NSIS installer for the standard installation/update path.
'@ | Set-Content -LiteralPath (Join-Path $publishDirectory 'PORTABLE-README.txt') -Encoding utf8NoBOM
$publishFiles = @(Get-ChildItem -LiteralPath $publishDirectory -Recurse -File | ForEach-Object { $publishRecord=Get-Evidence $_.FullName; $publishRecord.path=$_.FullName.Substring($publishDirectory.Length+1).Replace('\','/'); $publishRecord })
$publishZip = Join-Path $publishParent 'AssetStudio-windows-x64-portable.zip'
Compress-Archive -LiteralPath $publishDirectory -DestinationPath $publishZip
$publishExtracted = Join-Path $publishParent 'verify-extracted'
Expand-Archive -LiteralPath $publishZip -DestinationPath $publishExtracted
foreach ($publishFile in $publishFiles) {
    $publishActual = Get-Evidence (Join-Path $publishExtracted ('AssetStudio-windows-x64\' + $publishFile.path))
    if ($publishActual.bytes -ne $publishFile.bytes -or $publishActual.sha256 -ne $publishFile.sha256) { throw ('ZIP roundtrip mismatch: ' + $publishFile.path) }
}
if (@(Get-ChildItem -LiteralPath (Join-Path $publishExtracted 'AssetStudio-windows-x64') -Recurse -File).Count -ne $publishFiles.Count) { throw 'Unexpected ZIP entries.' }
$publishSetupEvidence = Get-Evidence $publishSetup
$publishZipEvidence = Get-Evidence $publishZip
$publishReleaseRoot = 'https://github.com/oocheol/masset/releases'
$publishLatest = [ordered]@{ version=$publishVersion; notes='큰 글씨와 사용 가이드, GPT-6.1 Sol 고정, 서명된 Windows 앱 내부 업데이트'; pub_date=[DateTimeOffset]::UtcNow.ToString('o'); platforms=[ordered]@{ 'windows-x86_64'=[ordered]@{ url="$publishReleaseRoot/download/v$publishVersion/AssetStudio_${publishVersion}_x64-setup.exe"; signature=[IO.File]::ReadAllText($publishSetup+'.sig').Trim(); bytes=$publishSetupEvidence.bytes; sha256=$publishSetupEvidence.sha256 } } }
$publishLatest | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $publishParent 'latest.json') -Encoding utf8NoBOM
($publishSetupEvidence.sha256+'  '+[IO.Path]::GetFileName($publishSetup)+"`n"+$publishZipEvidence.sha256+'  '+[IO.Path]::GetFileName($publishZip)+"`n") | Set-Content -LiteralPath (Join-Path $publishParent 'SHA256SUMS.txt') -Encoding utf8NoBOM
$publishReport = [ordered]@{ version=$publishVersion; createdAt=[DateTimeOffset]::UtcNow.ToString('o'); directory=$publishDirectory; installer=$publishSetupEvidence; zip=$publishZipEvidence; executable=$publishExe[0]; zipFilesVerified=$publishFiles.Count; portableFiles=$publishFiles; sourceBuildReport=[IO.Path]::GetFullPath($BuildReportPath); signatureVerificationPending=$true; nativeChecksPending=$true }
$publishReport | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $publishParent 'release-candidate.json') -Encoding utf8NoBOM
$publishReport | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath (Join-Path $publishWorkspace "output\release\windows-x64-$publishVersion-candidate.json") -Encoding utf8NoBOM
[pscustomobject]$publishReport | Select-Object version,directory,installer,zip,executable,zipFilesVerified | ConvertTo-Json -Depth 6

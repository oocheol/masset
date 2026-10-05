[CmdletBinding()]
param(
    [switch]$SkipInstall,
    [switch]$SkipChecks,
    [ValidateSet('Portable', 'Nsis')][string]$Distribution = 'Portable',
    [switch]$AllowBundlerDownload,
    [string]$SigningKeyPath,
    [string]$VcRuntimeDirectory,
    [string]$CargoBin = "$env:USERPROFILE\.cargo\bin"
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This script builds Windows x64 distributions.' }
$qaWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
$qaPreviousLocation = Get-Location
$qaEnvironmentNames = @('Path', 'INCLUDE', 'LIB', 'LIBPATH', 'VCToolsInstallDir', 'WindowsSdkDir', 'WindowsSDKVersion', 'UniversalCRTSdkDir', 'UCRTVersion', 'TAURI_SIGNING_PRIVATE_KEY', 'TAURI_SIGNING_PRIVATE_KEY_PASSWORD')
$qaPreviousEnvironment = @{}
foreach ($qaName in $qaEnvironmentNames) { $qaPreviousEnvironment[$qaName] = [Environment]::GetEnvironmentVariable($qaName, 'Process') }

function Invoke-Checked([string]$Command, [string[]]$Arguments) {
    & $Command @Arguments
    if ($LASTEXITCODE -ne 0) { throw "$Command failed with exit code $LASTEXITCODE" }
}
function Get-FileEvidence([string]$Path) {
    $qaFile = Get-Item -LiteralPath $Path
    return [ordered]@{ path = $qaFile.FullName; bytes = $qaFile.Length; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $qaFile.FullName).Hash.ToLowerInvariant() }
}
function Get-ExecutableEvidence([string]$Path, [switch]$RequireX64) {
    $qaEvidence = Get-FileEvidence $Path
    $qaStream = [IO.File]::OpenRead($Path)
    $qaReader = [IO.BinaryReader]::new($qaStream)
    try {
        if ($qaReader.ReadUInt16() -ne 0x5a4d -or $qaStream.Length -lt 64) { throw "Invalid MZ executable: $Path" }
        $qaStream.Position = 0x3c
        $qaPeOffset = $qaReader.ReadUInt32()
        if ($qaPeOffset -gt $qaStream.Length - 26) { throw "Invalid PE header offset: $Path" }
        $qaStream.Position = $qaPeOffset
        if ($qaReader.ReadUInt32() -ne 0x00004550) { throw "Invalid PE signature: $Path" }
        $qaMachine = $qaReader.ReadUInt16()
        if ($RequireX64 -and $qaMachine -ne 0x8664) { throw "App executable is not AMD64: $Path" }
        $qaEvidence.machine = ('0x{0:x4}' -f $qaMachine)
        $qaEvidence.architecture = switch ($qaMachine) { 0x8664 {'x64'} 0x014c {'x86'} 0xaa64 {'arm64'} default {'unknown'} }
    } finally { $qaReader.Dispose(); $qaStream.Dispose() }
    $qaSignature = Get-AuthenticodeSignature -LiteralPath $Path
    $qaEvidence.signatureStatus = "$($qaSignature.Status)"
    $qaEvidence.signer = if ($qaSignature.SignerCertificate) { $qaSignature.SignerCertificate.Subject } else { $null }
    return $qaEvidence
}

try {
    Set-Location -LiteralPath $qaWorkspace
    . (Join-Path $qaWorkspace 'scripts\with-native-env.ps1')
    $env:Path = "$CargoBin;$env:Path"
    $qaSdkVersion = ([string]$env:WindowsSDKVersion).TrimEnd('\')
    $qaUcrtVersion = ([string]$env:UCRTVersion).TrimEnd('\')
    if (-not $env:WindowsSdkDir -or -not $qaSdkVersion -or -not $env:UniversalCRTSdkDir -or -not $qaUcrtVersion) {
        throw 'Windows SDK/UCRT environment is missing. Install the approved Microsoft Windows SDK and reopen the compiler environment.'
    }
    $qaSdkFiles = @(
        (Join-Path $env:WindowsSdkDir "Include\$qaSdkVersion\um\Windows.h"),
        (Join-Path $env:WindowsSdkDir "Lib\$qaSdkVersion\um\x64\kernel32.lib"),
        (Join-Path $env:WindowsSdkDir "Lib\$qaSdkVersion\um\x64\uuid.lib"),
        (Join-Path $env:UniversalCRTSdkDir "Include\$qaUcrtVersion\ucrt\corecrt.h"),
        (Join-Path $env:UniversalCRTSdkDir "Lib\$qaUcrtVersion\ucrt\x64\ucrt.lib")
    )
    foreach ($qaSdkFile in $qaSdkFiles) { if (-not (Test-Path -LiteralPath $qaSdkFile -PathType Leaf)) { throw "Windows SDK prerequisite is missing: $qaSdkFile" } }
    $qaTools = [ordered]@{}
    foreach ($qaTool in @('cl.exe', 'link.exe', 'rc.exe', 'cargo.exe', 'rustc.exe', 'node.exe', 'npm.cmd')) { $qaTools[$qaTool] = (Get-Command $qaTool -CommandType Application -ErrorAction Stop).Source }
    $qaNsisCache = Join-Path $env:LOCALAPPDATA 'tauri\NSIS'
    if ($Distribution -eq 'Nsis' -and -not $AllowBundlerDownload) {
        $qaRequiredNsis = @('makensis.exe', 'Bin/makensis.exe', 'Stubs/lzma-x86-unicode', 'Stubs/lzma_solid-x86-unicode', 'Plugins/x86-unicode/additional/nsis_tauri_utils.dll', 'Include/MUI2.nsh', 'Include/FileFunc.nsh', 'Include/x64.nsh', 'Include/nsDialogs.nsh', 'Include/WinMessages.nsh', 'Include/Win/COM.nsh', 'Include/Win/Propkey.nsh', 'Include/Win/RestartManager.nsh')
        $qaMissingNsis = @($qaRequiredNsis | Where-Object { -not (Test-Path -LiteralPath (Join-Path $qaNsisCache $_) -PathType Leaf) })
        if ($qaMissingNsis.Count -gt 0) { throw 'NSIS tools are not cached. Use the portable build, or obtain consent for the documented NSIS downloads before passing -Distribution Nsis -AllowBundlerDownload.' }
        $qaPluginHash = (Get-FileHash -Algorithm SHA256 -LiteralPath (Join-Path $qaNsisCache 'Plugins\x86-unicode\additional\nsis_tauri_utils.dll')).Hash.ToLowerInvariant()
        if ($qaPluginHash -ne '5ba143b5db4a87d32d6e7802e033330aae56cbceabe0d1e3ba41948385ad4709') { throw 'Cached NSIS plugin differs from the documented 0.5.3 hash. Do not silently replace/download executables.' }
    }
    if (-not $SkipInstall) { Invoke-Checked 'npm.cmd' @('ci') }
    $qaResourceManifestText = & 'node.exe' (Join-Path $qaWorkspace 'scripts\copy-windows-resources.mjs') '--workspace' $qaWorkspace '--plan' '--check-windows-notices'
    if ($LASTEXITCODE -ne 0) { throw 'The Tauri resource plan or Windows license inventory failed validation before native compilation.' }
    $qaResourceManifest = $qaResourceManifestText | ConvertFrom-Json
    $qaRunId = [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)
    $qaReportDirectory = Join-Path $qaWorkspace ("output\release\$qaRunId")
    New-Item -ItemType Directory -Path $qaReportDirectory | Out-Null
    $qaFrozenResourcePath = Join-Path $qaReportDirectory 'resources-frozen.json'
    $qaResourceManifestText | Set-Content -LiteralPath $qaFrozenResourcePath -Encoding utf8
    if (-not $SkipChecks) {
        Invoke-Checked 'cargo.exe' @('test', '--workspace')
        Invoke-Checked 'npm.cmd' @('run', 'typecheck')
        Invoke-Checked 'npm.cmd' @('test')
    }
    $qaCliVersion = (Get-Content -Raw -LiteralPath (Join-Path $qaWorkspace 'node_modules\@tauri-apps\cli\package.json') | ConvertFrom-Json).version
    if ($Distribution -eq 'Nsis' -and $qaCliVersion -ne '2.12.1') { throw 'The NSIS download inventory is pinned to Tauri CLI 2.12.1; update its source/version/hash record before using a different CLI.' }
    # Build the shipped binaries once with embedded production assets. Proof
    # executables are built explicitly by QA; they are not installer programs.
    Invoke-Checked 'npm.cmd' @('run', 'build')
    Invoke-Checked 'cargo.exe' @('build', '-p', 'asset-desktop', '--bin', 'asset-desktop', '--bin', 'asset-cli', '--release', '--features', 'tauri/custom-protocol')
    $qaBundleDirectory = Join-Path $qaWorkspace 'target\release\bundle\nsis'
    $qaBeforeBundles = @{}
    if (Test-Path -LiteralPath $qaBundleDirectory) {
        foreach ($qaOld in Get-ChildItem -LiteralPath $qaBundleDirectory -File -Filter '*.exe') { $qaBeforeBundles[$qaOld.FullName] = [ordered]@{ ticks = $qaOld.LastWriteTimeUtc.Ticks; sha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $qaOld.FullName).Hash } }
    }
    if ($SigningKeyPath) {
        if (-not (Test-Path -LiteralPath $SigningKeyPath -PathType Leaf)) { throw 'The private signing key must exist outside the repository.' }
        $qaSigningPath = (Resolve-Path -LiteralPath $SigningKeyPath).Path
        if ($qaSigningPath.StartsWith($qaWorkspace.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Keep the private signing key outside the source workspace.' }
        $env:TAURI_SIGNING_PRIVATE_KEY = [IO.File]::ReadAllText($qaSigningPath).Trim()
        $env:TAURI_SIGNING_PRIVATE_KEY_PASSWORD = ''
    }
    if ($Distribution -eq 'Nsis' -and -not $env:TAURI_SIGNING_PRIVATE_KEY) { throw 'A private updater signing key is required for an update-enabled NSIS release.' }
    if ($Distribution -eq 'Nsis') {
        Invoke-Checked 'npm.cmd' @('run', 'tauri', '--workspace', '@local-assets/desktop', '--', 'bundle', '--bundles', 'nsis')
        $qaInstallerScript = Join-Path $qaWorkspace 'target\release\nsis\x64\installer.nsi'
        $qaInstallerScriptText = Get-Content -Raw -LiteralPath $qaInstallerScript
        if ($qaInstallerScriptText -match '(?im)^\s*File\b[^\r\n]*\b(?:codex-setup-proof|image3d-proof|provider-proof|update-proof)\.exe\b') {
            throw 'Developer proof executables must not be included in a public installer.'
        }
    }
    $qaAfterBuildPlanText = & 'node.exe' (Join-Path $qaWorkspace 'scripts\copy-windows-resources.mjs') '--workspace' $qaWorkspace '--plan' '--expected-plan' $qaFrozenResourcePath '--check-windows-notices'
    if ($LASTEXITCODE -ne 0) { throw 'Resource sources/configuration or Windows notices changed during the native build. Preserve this failed build; do not package it.' }
    $qaResourceManifest = $qaAfterBuildPlanText | ConvertFrom-Json
    $qaBinaries = @(
        (Get-ExecutableEvidence (Join-Path $qaWorkspace 'target\release\asset-desktop.exe') -RequireX64),
        (Get-ExecutableEvidence (Join-Path $qaWorkspace 'target\release\asset-cli.exe') -RequireX64)
    )
    $qaPortableFiles = @()
    $qaPackages = @()
    if ($Distribution -eq 'Portable') {
        $qaPortableDirectory = Join-Path $qaReportDirectory 'AssetStudio-windows-x64'
        New-Item -ItemType Directory -Path $qaPortableDirectory | Out-Null
        Copy-Item -LiteralPath (Join-Path $qaWorkspace 'target\release\asset-desktop.exe') -Destination $qaPortableDirectory
        $qaCopiedResourceText = & 'node.exe' (Join-Path $qaWorkspace 'scripts\copy-windows-resources.mjs') '--workspace' $qaWorkspace '--destination' $qaPortableDirectory '--expected-plan' $qaFrozenResourcePath '--check-windows-notices'
        if ($LASTEXITCODE -ne 0) { throw 'Portable Tauri resources failed exclusive copying or digest verification.' }
        $qaCopiedResources = $qaCopiedResourceText | ConvertFrom-Json
        $qaResourceManifest = $qaCopiedResources
        if (-not (Test-Path -LiteralPath (Join-Path $qaPortableDirectory 'docs\licenses\THIRD_PARTY_LICENSES.txt') -PathType Leaf)) { throw 'Third-party license texts are missing. Regenerate the notices before packaging a public release.' }
        if ($VcRuntimeDirectory) {
            $qaRuntimePath = (Resolve-Path -LiteralPath $VcRuntimeDirectory).Path
            $qaRuntimeDlls = @(Get-ChildItem -LiteralPath $qaRuntimePath -File -Filter '*.dll')
            if ($qaRuntimeDlls.Count -eq 0) { throw 'The supplied VC runtime directory contains no DLLs.' }
            foreach ($qaRuntimeDll in $qaRuntimeDlls) { Get-ExecutableEvidence $qaRuntimeDll.FullName -RequireX64 | Out-Null; Copy-Item -LiteralPath $qaRuntimeDll.FullName -Destination $qaPortableDirectory }
        }
        @'
Asset Studio Windows x64 portable
Extract the entire folder and run asset-desktop.exe. Keep examples/, workers/, licenses/ and docs/ beside it.
Read docs/windows-quickstart.md for the Korean usage guide; related provider/platform/verification documents are beside it.
This unsigned build is not a completed clean-machine install/upgrade/uninstall certification.
Microsoft WebView2 is required. Native DLL dependencies must be audited separately; no runtime is downloaded by this build path.
Blender is optional and must be installed separately with consent. Its GPL worker source/license are included.
Windows x64 image-to-3D uses an app-managed CPython3.12 CPU runtime. The first preparation requires explicit download consent (~1.89GiB); model weights are not bundled. Blender, at least 16GB RAM and Microsoft Visual C++ 2015-2022 x64 runtime are required. See docs/model-quality.md and the release's native verification record.
Resolved dependency license texts and copyright notices are in docs/licenses/THIRD_PARTY_LICENSES.txt.
The backend QA CLI remains a developer test binary and is not included in this portable application.
'@ | Set-Content -LiteralPath (Join-Path $qaPortableDirectory 'PORTABLE-README.txt') -Encoding utf8
        $qaPortableFiles = @(Get-ChildItem -LiteralPath $qaPortableDirectory -Recurse -File | ForEach-Object {
            $qaFileRecord = Get-FileEvidence $_.FullName
            $qaFileRecord.path = $_.FullName.Substring($qaPortableDirectory.Length + 1).Replace('\', '/')
            $qaFileRecord
        })
        if (@($qaPortableFiles | Where-Object { $_.path -like 'examples/*.png' }).Count -ne 12) { throw 'Portable resource layout does not contain all 12 example PNGs.' }
        $qaPortableZip = Join-Path $qaReportDirectory 'AssetStudio-windows-x64-portable.zip'
        Compress-Archive -LiteralPath $qaPortableDirectory -DestinationPath $qaPortableZip
        $qaPackages = @((Get-FileEvidence $qaPortableZip))
    } else {
        $qaBundles = @(Get-ChildItem -LiteralPath $qaBundleDirectory -File -Filter '*.exe' | Where-Object {
            $qaOld = $qaBeforeBundles[$_.FullName]
            -not $qaOld -or $_.LastWriteTimeUtc.Ticks -ne $qaOld.ticks -or (Get-FileHash -Algorithm SHA256 -LiteralPath $_.FullName).Hash -ne $qaOld.sha256
        })
        if ($qaBundles.Count -eq 0) { throw 'Build exited successfully but no new or regenerated NSIS package was found.' }
        foreach ($qaSignedBundle in $qaBundles) {
            if (-not (Test-Path -LiteralPath ($qaSignedBundle.FullName + '.sig') -PathType Leaf)) { throw 'The installer updater signature was not created.' }
        }
        $qaPackages = @($qaBundles | ForEach-Object {
            $qaSavedBundle = Join-Path $qaReportDirectory $_.Name
            Copy-Item -LiteralPath $_.FullName -Destination $qaSavedBundle
            Copy-Item -LiteralPath ($_.FullName + '.sig') -Destination ($qaSavedBundle + '.sig')
            Get-ExecutableEvidence $qaSavedBundle
        })
    }
    $qaReport = [ordered]@{
        checkedAt = [DateTimeOffset]::UtcNow.ToString('o')
        appVersion = $qaResourceManifest.appVersion
        platform = 'windows-x64'
        distribution = $Distribution.ToLowerInvariant()
        tauriCliVersion = $qaCliVersion
        windowsSdkVersion = $qaSdkVersion
        compilerTools = $qaTools
        sdkPrerequisiteFiles = $qaSdkFiles
        checksSkipped = [bool]$SkipChecks
        bundlerDownloadAllowed = [bool]$AllowBundlerDownload
        binaries = $qaBinaries
        packages = $qaPackages
        portableFiles = $qaPortableFiles
        resourceManifest = $qaResourceManifest
        frozenResourcePlan = $qaFrozenResourcePath
        resourcePlanVerifiedAfterBuild = $true
        vcRuntimeDirectory = $VcRuntimeDirectory
        packageCreated = $true
        nativeWindowTested = $false
        cleanMachineRuntimeTested = $false
        installerLifecycleTested = $false
        note = 'Actual output bytes/digests and PE architecture are recorded. Launch, dependency resolution, installation, upgrade and uninstall require separate execution evidence.'
    }
    $qaReportText = $qaReport | ConvertTo-Json -Depth 8
    $qaReportText | Set-Content -LiteralPath (Join-Path $qaReportDirectory 'windows-x64-build.json') -Encoding utf8
    $qaReportText | Set-Content -LiteralPath (Join-Path $qaWorkspace 'output\release\windows-x64-build.json') -Encoding utf8
    $qaReportText
}
finally {
    foreach ($qaName in $qaEnvironmentNames) { [Environment]::SetEnvironmentVariable($qaName, $qaPreviousEnvironment[$qaName], 'Process') }
    Set-Location -LiteralPath $qaPreviousLocation.Path
}

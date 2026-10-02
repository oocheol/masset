[CmdletBinding()]
param(
    [string]$Executable,
    [string]$OutputDirectory,
    [switch]$WithBlender,
    [switch]$NativeWindow,
    [switch]$Native3D,
    [ValidateRange(0, 3600)][int]$TimeoutSeconds = 0
)
$ErrorActionPreference = 'Stop'
if ($env:OS -ne 'Windows_NT') { throw 'This native smoke harness runs Windows executables.' }
function Get-ComparableWindowsPath([string]$Path) {
    $qaPath = $Path.Replace('/', '\')
    if ($qaPath.StartsWith('\\?\UNC\', [StringComparison]::OrdinalIgnoreCase)) { $qaPath = '\\' + $qaPath.Substring(8) }
    elseif ($qaPath.StartsWith('\\?\') -and $qaPath.Substring(4) -match '^[A-Za-z]:\\') { $qaPath = $qaPath.Substring(4) }
    return [IO.Path]::GetFullPath($qaPath)
}
$qaWorkspace = [IO.Path]::GetFullPath((Join-Path $PSScriptRoot '..'))
if ($Native3D) { $NativeWindow = $true }
if ($NativeWindow -and $WithBlender) { throw '-NativeWindow checks WebView startup; use a separate -WithBlender backend smoke for model production.' }
if (-not $Executable) {
    $qaBinary = if ($NativeWindow) {'asset-desktop.exe'} else {'asset-cli.exe'}
    $Executable = Join-Path $qaWorkspace ('target\release\' + $qaBinary)
    if (-not (Test-Path -LiteralPath $Executable)) { $Executable = Join-Path $qaWorkspace ('target\debug\' + $qaBinary) }
}
if (-not $OutputDirectory) { $OutputDirectory = Join-Path $qaWorkspace ('output\native-smoke\' + [DateTime]::UtcNow.ToString('yyyyMMdd-HHmmss') + '-' + [guid]::NewGuid().ToString('N').Substring(0, 8)) }
$qaExe = (Resolve-Path -LiteralPath $Executable).Path
$qaWorkingDirectory = if ($NativeWindow) { [IO.Path]::GetDirectoryName($qaExe) } else { $qaWorkspace }
$qaOutput = [IO.Path]::GetFullPath($OutputDirectory)
$qaStdout = $qaOutput + '.stdout.log'
$qaStderr = $qaOutput + '.stderr.log'
$qaOutcome = $qaOutput + '.qa.json'
foreach ($qaFreshPath in @($qaOutput, $qaStdout, $qaStderr, $qaOutcome)) {
    if (Test-Path -LiteralPath $qaFreshPath) { throw 'Smoke output and sidecar logs must be fresh; existing project files are preserved.' }
}
if ($TimeoutSeconds -eq 0) { $TimeoutSeconds = if ($Native3D) {300} elseif ($NativeWindow) {150} else {900} }
New-Item -ItemType Directory -Path ([IO.Path]::GetDirectoryName($qaOutput)) -Force | Out-Null
$qaSummary = [ordered]@{
    checkedAt = [DateTimeOffset]::UtcNow.ToString('o')
    mode = if ($NativeWindow) {'native-webview'} else {'native-backend'}
    executable = $qaExe
    executableBytes = (Get-Item -LiteralPath $qaExe).Length
    executableSha256 = (Get-FileHash -Algorithm SHA256 -LiteralPath $qaExe).Hash.ToLowerInvariant()
    workingDirectory = $qaWorkingDirectory
    output = $qaOutput
    stdout = $qaStdout
    stderr = $qaStderr
    timeoutSeconds = $TimeoutSeconds
    withBlender = [bool]$WithBlender
    native3DRequested = [bool]$Native3D
    passed = $false
    installerLifecycleTested = $false
    cleanMachineRuntimeTested = $false
}
try {
    # Start-Process joins argument arrays; quote the Windows output path explicitly.
    $qaQuotedOutput = '"' + $qaOutput + '"'
    $qaArguments = if ($Native3D) { @('--ui-smoke-3d', $qaQuotedOutput) } elseif ($NativeWindow) { @('--ui-smoke', $qaQuotedOutput) } else { @('--smoke', $qaQuotedOutput) }
    if ($WithBlender) { $qaArguments += '--with-blender' }
    $qaProcess = Start-Process -FilePath $qaExe -ArgumentList $qaArguments -WorkingDirectory $qaWorkingDirectory -PassThru -WindowStyle Hidden -RedirectStandardOutput $qaStdout -RedirectStandardError $qaStderr
    $qaSummary.pid = $qaProcess.Id
    $qaDeadline = [DateTime]::UtcNow.AddSeconds($TimeoutSeconds)
    while (-not $qaProcess.WaitForExit(30000)) {
        if ([DateTime]::UtcNow -gt $qaDeadline) {
            Stop-Process -Id $qaProcess.Id -ErrorAction SilentlyContinue
            throw 'Native smoke timed out; only the process launched by this harness was stopped.'
        }
    }
    $qaProcess.Refresh()
    $qaSummary.exitCode = $qaProcess.ExitCode
    if ($qaProcess.ExitCode -ne 0) { throw "Native smoke process exited with code $($qaProcess.ExitCode). See retained stdout/stderr." }
    $qaEvidence = Join-Path $qaOutput $(if ($NativeWindow) {'native-window.json'} else {'smoke.json'})
    if (-not (Test-Path -LiteralPath $qaEvidence -PathType Leaf)) { throw 'Native process exited without its evidence report.' }
    $qaReport = Get-Content -Raw -LiteralPath $qaEvidence | ConvertFrom-Json
    $qaSummary.sourceReport = $qaEvidence
    if ($qaReport.providerLiveGeneration -ne $false) { throw 'This local fixture smoke does not authorize or certify live provider generation.' }
    if ($NativeWindow) {
        $qaExpectedAssets = if ($Native3D) {13} else {12}
        if ($qaReport.nativeWindow -ne $true -or $qaReport.platform -ne 'windows' -or $qaReport.pid -ne $qaProcess.Id -or $qaReport.assets -ne $qaExpectedAssets -or $qaReport.webview.domReady -ne $true -or $qaReport.webview.decodedImages -lt 8 -or $qaReport.webview.ipcEnvironment.native -ne $true) {
            throw 'Native report did not establish this Windows process, rendered DOM, 12 fixture assets, decoded asset-protocol images and real native IPC.'
        }
        if ($Native3D) {
            $qa3D = $qaReport.webview.native3D
            if ($qaReport.withNativeModel -ne $true -or $qaReport.fixtureAssets -ne 12 -or $qaReport.modelAssets -ne 1 -or $qa3D.requested -ne $true -or $qa3D.passed -ne $true -or $qa3D.generator -cne 'Blender' -or $qa3D.blenderUsed -ne $true -or $qa3D.modelJobSucceeded -ne $true -or $qa3D.externalProviderCalls -ne 0 -or $qaReport.webview.externalProviderCalls -ne 0 -or $qa3D.error) {
                throw 'Native 3D proof did not establish exactly one actual Blender model, successful native job and no external-provider calls.'
            }
            if ($qa3D.parameters.template -cne 'crate' -or $qa3D.parameters.unit -cne 'm' -or $qa3D.parameters.count -ne 1 -or $qa3D.parameters.width -ne 1 -or $qa3D.parameters.depth -ne 1 -or $qa3D.parameters.height -ne 1) { throw 'Native 3D proof did not establish the requested one-meter crate parameters.' }
            $qaFetch = $qa3D.glbFetch
            if ($qaFetch.ok -ne $true -or $qaFetch.headerValid -ne $true -or $qaFetch.bytes -lt 1024 -or $qaFetch.meshCount -lt 1 -or $qaFetch.primitiveCount -lt 1 -or $qaFetch.vertices -lt 8 -or $qaFetch.triangles -le 12 -or ([string]$qaFetch.sha256) -notmatch '^[0-9a-fA-F]{64}$' -or -not ([string]$qaFetch.url).StartsWith('http://asset.localhost/', [StringComparison]::OrdinalIgnoreCase)) { throw 'Native viewport did not fetch and decode an actual GLB through the Windows asset protocol.' }
            $qaDimensions = @($qaFetch.bounds.dimensions)
            if ($qaDimensions.Count -ne 3) { throw 'Native fetched GLB has no three-dimensional bounds.' }
            foreach ($qaDimension in $qaDimensions) {
                $qaValue = [double]$qaDimension
                if ([double]::IsNaN($qaValue) -or [double]::IsInfinity($qaValue) -or [Math]::Abs($qaValue - 1) -gt 0.0001) { throw 'Native fetched GLB bounds do not match the one-meter cube parameters.' }
            }
            $qaModelAssets = @($qaReport.models)
            if ($qaModelAssets.Count -ne 1 -or $qaModelAssets[0].id -cne $qa3D.assetId) { throw 'Native viewport asset identity does not match the backend model.' }
            $qaGlbArtifacts = @($qaModelAssets[0].versions | ForEach-Object { $_.artifacts } | Where-Object { $_.format -eq 'glb' })
            if (@($qaGlbArtifacts | Where-Object { $_.bytes -eq $qaFetch.bytes -and ([string]$_.sha256).ToLowerInvariant() -ceq ([string]$qaFetch.sha256).ToLowerInvariant() }).Count -ne 1) { throw 'Native viewport GLB bytes/hash do not match its actual saved backend artifact.' }
            $qaPixelSamples = @($qa3D.webgl.pixels)
            if ($qa3D.webgl.context -ne $true -or $qa3D.webgl.drawCalls -le 0 -or $qa3D.webgl.defaultFramebufferDrawCalls -le 0 -or $qa3D.webgl.pixelReadbacks -le 0 -or $qa3D.webgl.pixelColorVariation -ne $true -or $qaPixelSamples.Count -lt 2) { throw 'Native 3D proof lacks actual WebGL default-framebuffer drawing and varied pixel readback.' }
            $qaPixelVariation = $false
            foreach ($qaPixel in $qaPixelSamples) {
                if (@($qaPixel).Count -ne 4 -or $qaPixel[3] -le 0) { throw 'Native WebGL pixel sample is not a visible RGBA value.' }
                foreach ($qaChannel in $qaPixel) { if ($qaChannel -lt 0 -or $qaChannel -gt 255) { throw 'Native WebGL pixel channel lies outside byte bounds.' } }
                foreach ($qaAxis in 0..2) { if ([Math]::Abs([double]$qaPixel[$qaAxis] - [double]$qaPixelSamples[0][$qaAxis]) -gt 8) { $qaPixelVariation = $true } }
            }
            if (-not $qaPixelVariation) { throw 'Native WebGL readback colors are identical; no visible model evidence.' }
            $qaSummary.native3DVerified = $true
            $qaSummary.native3DAssetId = $qa3D.assetId
            $qaSummary.fetchedGlbSha256 = $qaFetch.sha256
            $qaSummary.defaultFramebufferDrawCalls = $qa3D.webgl.defaultFramebufferDrawCalls
        }
        $qaSummary.nativeWindow = $true
        $qaSummary.decodedImages = $qaReport.webview.decodedImages
        $qaSummary.passed = $true
        if ($Native3D) { Write-Output 'Native WebView DOM/IPC and actual Blender GLB fetch, saved-artifact digest, bounds, WebGL draw and pixel checks passed.' }
        else { Write-Output 'Native WebView DOM, asset-protocol image decoding and IPC checks passed. Installation and model production require separate checks.' }
    } else {
        if ($qaReport.nativeBackend -ne $true -or $qaReport.nativeWindow -ne $false -or $qaReport.reopened -ne $true -or $qaReport.explicitCacheReuse -ne $true -or $qaReport.environment.native -ne $true -or $qaReport.images -ne 12) {
            throw 'Native backend report did not establish real imports, native execution and immutable project reopen.'
        }
        if ($qaReport.concurrentProjectOpenRejected -ne $true -or $qaReport.shutdownReleaseVerified -ne $true -or $qaReport.ownershipCheckScope -cne 'same-process independent handles') {
            throw 'Native backend report did not establish concurrent-open rejection and shutdown release through same-process independent handles.'
        }
        $qaJobs = @($qaReport.jobs)
        if ($qaJobs.Count -lt 6 -or @($qaJobs | Where-Object { $_.status -ne 'succeeded' }).Count -gt 0 -or @($qaJobs | Where-Object { $_.kind -eq 'image_process' }).Count -lt 2 -or @($qaJobs | Where-Object { $_.kind -eq 'atlas' }).Count -lt 1 -or @($qaJobs | Where-Object { $_.kind -eq 'normal_map' }).Count -lt 1) { throw 'Native report contains missing or unsuccessful processing, atlas or normal-map jobs.' }
        if ($WithBlender -and @($qaJobs | Where-Object { $_.kind -eq 'blender_model' }).Count -lt 2) { throw 'Blender smoke did not establish both requested native model jobs.' }
        $qaBundle = [IO.Path]::GetFullPath([string]$qaReport.bundle)
        $qaComparableBundle = Get-ComparableWindowsPath $qaBundle
        $qaComparableOutput = Get-ComparableWindowsPath $qaOutput
        if (-not $qaComparableBundle.StartsWith($qaComparableOutput.TrimEnd('\') + '\', [StringComparison]::OrdinalIgnoreCase)) { throw 'Native export lies outside this fresh smoke output directory.' }
        $qaManifest = Join-Path $qaBundle 'manifest.json'
        if (-not (Test-Path -LiteralPath $qaManifest -PathType Leaf)) { throw 'Native smoke produced no standalone export manifest at its reported bundle path.' }
        $qaVerificationPath = Join-Path $qaOutput 'independent-verification.json'
        $qaVerifierOutput = & node.exe (Join-Path $qaWorkspace 'scripts\verify-artifacts.mjs') $qaManifest 2>&1
        $qaVerifierExit = $LASTEXITCODE
        $qaVerifierOutput | Out-File -LiteralPath $qaVerificationPath -Encoding utf8 -NoClobber
        if ($qaVerifierExit -ne 0) { throw 'Independent artifact verification failed. See independent-verification.json.' }
        $qaVerified = ($qaVerifierOutput -join [Environment]::NewLine) | ConvertFrom-Json
        if ($qaVerified.valid -ne $true -or @($qaVerified.files).Count -eq 0) { throw 'Artifact verifier returned no valid decoded export files.' }
        if ($WithBlender -and @($qaVerified.files | Where-Object { $_.path -like '*.glb' }).Count -lt 2) { throw 'Independent export verification did not include both actual GLB models.' }
        $qaSummary.nativeBackend = $true
        $qaSummary.nativeWindow = $false
        $qaSummary.ownershipCheckScope = $qaReport.ownershipCheckScope
        $qaSummary.independentVerification = $qaVerificationPath
        $qaSummary.verifiedFileCount = @($qaVerified.files).Count
        $qaSummary.passed = $true
        Write-Output 'Native backend smoke and independent artifact verification passed. WebView launch, fresh Blender source reopening and installer behavior require separate checks.'
    }
} catch {
    $qaSummary.error = $_.Exception.Message
    throw
} finally {
    $qaSummary.completedAt = [DateTimeOffset]::UtcNow.ToString('o')
    $qaSummary | ConvertTo-Json -Depth 8 | Out-File -LiteralPath $qaOutcome -Encoding utf8 -NoClobber
    Write-Output "Native QA evidence: $qaOutcome"
}

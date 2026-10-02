# SPDX-License-Identifier: GPL-3.0-or-later
param(
    [string]$BlenderPath = 'C:\Program Files\Blender Foundation\Blender 5.2\blender.exe',
    [switch]$StyleOnly
)
$ErrorActionPreference = 'Stop'
$taskRoot = Split-Path (Split-Path $PSScriptRoot -Parent) -Parent
$workerPath = Join-Path $taskRoot 'workers\blender\worker.py'
$verifierPath = Join-Path $PSScriptRoot 'verify_artifacts.py'
$runId = 'run-' + (Get-Date -Format 'yyyyMMdd-HHmmss') + '-' + [Guid]::NewGuid().ToString('N').Substring(0, 8)
$runDir = Join-Path $PSScriptRoot ('artifacts\' + $runId)
New-Item -ItemType Directory -Path $runDir | Out-Null
$summary = [Collections.Generic.List[object]]::new()
$clock = [Diagnostics.Stopwatch]::StartNew()
if (-not $StyleOnly) {
foreach ($template in @('crate', 'table', 'shelf')) {
    $jobPath = Join-Path $PSScriptRoot ($template + '.json')
    $assetDir = Join-Path $runDir ('한글 경로 ' + $template)
    $logPath = Join-Path $runDir ($template + '-generate.log')
    & $BlenderPath --background --factory-startup --disable-autoexec --threads 2 --python $workerPath -- --input $jobPath --output-dir $assetDir *> $logPath
    if ($LASTEXITCODE -ne 0) { throw "Generation failed for $template. See $logPath" }
    foreach ($mode in @('glb', 'blend')) {
        $checkLog = Join-Path $runDir ($template + '-' + $mode + '.log')
        & $BlenderPath --background --factory-startup --disable-autoexec --threads 2 --python $verifierPath -- --input $jobPath --artifact-dir $assetDir --mode $mode *> $checkLog
        if ($LASTEXITCODE -ne 0) { throw "Round-trip failed for $template/$mode. See $checkLog" }
    }
    $report = Get-Content -LiteralPath (Join-Path $assetDir 'validation.json') -Raw -Encoding UTF8 | ConvertFrom-Json
    foreach ($name in @('thumbnail.png','turntable-00.png','turntable-01.png','turntable-02.png','turntable-03.png')) {
        $png = [IO.File]::ReadAllBytes((Join-Path $assetDir $name))
        if ($png.Length -le 1024 -or [BitConverter]::ToString($png[0..7]) -ne '89-50-4E-47-0D-0A-1A-0A') { throw "Invalid rendered PNG: $name" }
    }
    $summary.Add([pscustomobject]@{template=$template; valid=$report.valid; triangles=$report.mesh.triangles; artifacts=$assetDir; elapsedSeconds=$report.elapsedSeconds; glbRoundTrip=$true; blendRoundTrip=$true})
    Write-Output "$template : real GLB/.blend/PNG verified; $($report.mesh.triangles) triangles"
}

# Invalid data must fail before any artifacts are created, and script text is data.
$invalidCases = @(
    @{label='unknown-script'; json='{"template":"crate","name":"safe","width":1,"depth":1,"height":1,"color":"#799993","bevel":0.01,"script":"print(1)"}'},
    @{label='traversal-name'; json='{"template":"crate","name":"../outside","width":1,"depth":1,"height":1,"color":"#799993","bevel":0.01}'},
    @{label='nonfinite'; json='{"template":"crate","name":"safe","width":NaN,"depth":1,"height":1,"color":"#799993","bevel":0.01}'},
    @{label='boolean-dimension'; json='{"template":"crate","name":"safe","width":true,"depth":1,"height":1,"color":"#799993","bevel":0.01}'},
    @{label='duplicate-key'; json='{"template":"crate","name":"safe","width":1,"width":2,"depth":1,"height":1,"color":"#799993","bevel":0.01}'},
    @{label='excessive-size'; json='{"template":"crate","name":"safe","width":101,"depth":1,"height":1,"color":"#799993","bevel":0.01}'},
    @{label='excessive-bevel'; json='{"template":"crate","name":"safe","width":1,"depth":1,"height":1,"color":"#799993","bevel":0.251}'}
)
foreach ($case in $invalidCases) {
    $jobPath = Join-Path $runDir ($case.label + '.json')
    [IO.File]::WriteAllText($jobPath, $case.json, [Text.UTF8Encoding]::new($false))
    $assetDir = Join-Path $runDir ($case.label + '-output')
    & $BlenderPath --background --factory-startup --disable-autoexec --threads 2 --python $workerPath -- --input $jobPath --output-dir $assetDir *> (Join-Path $runDir ($case.label + '.log'))
    if ($LASTEXITCODE -eq 0 -or (Test-Path -LiteralPath $assetDir)) { throw "Invalid input was accepted: $($case.label)" }
    $summary.Add([pscustomobject]@{case=$case.label; rejected=$true; outputWritten=$false})
}

# A second job cannot overwrite the original output directory.
$crateDir = Join-Path $runDir '한글 경로 crate'
$before = (Get-FileHash -LiteralPath (Join-Path $crateDir 'model.glb') -Algorithm SHA256).Hash
& $BlenderPath --background --factory-startup --disable-autoexec --threads 2 --python $workerPath -- --input (Join-Path $PSScriptRoot 'crate.json') --output-dir $crateDir *> (Join-Path $runDir 'overwrite-guard.log')
$after = (Get-FileHash -LiteralPath (Join-Path $crateDir 'model.glb') -Algorithm SHA256).Hash
if ($LASTEXITCODE -eq 0 -or $before -ne $after) { throw 'Original artifact was overwritten' }
$summary.Add([pscustomobject]@{case='preserve-original'; rejected=$true; sha256Unchanged=$true})
}

# One real style-forwarding scenario: independent source/GLB material + camera/light checks.
$styleJobPath = Join-Path $PSScriptRoot 'crate.json'
$stylePath = Join-Path $PSScriptRoot 'style.json'
$styleDir = Join-Path $runDir 'approved-style'
& $BlenderPath --background --factory-startup --disable-autoexec --threads 2 --python $workerPath -- --input $styleJobPath --output-dir $styleDir --style-file $stylePath *> (Join-Path $runDir 'style-generate.log')
if ($LASTEXITCODE -ne 0) { throw 'Approved style generation failed' }
foreach ($mode in @('glb', 'blend')) {
    & $BlenderPath --background --factory-startup --disable-autoexec --threads 2 --python $verifierPath -- --input $styleJobPath --artifact-dir $styleDir --mode $mode *> (Join-Path $runDir ('style-' + $mode + '.log'))
    if ($LASTEXITCODE -ne 0) { throw "Style round-trip failed for $mode" }
}
& $BlenderPath --background --factory-startup --disable-autoexec --threads 2 --python (Join-Path $PSScriptRoot 'verify_style.py') -- --input $styleJobPath --style-file $stylePath --artifact-dir $styleDir *> (Join-Path $runDir 'style-verification.log')
if ($LASTEXITCODE -ne 0) { throw 'Applied style inspection failed' }
$summary.Add([pscustomobject]@{case='approved-style-forwarding'; valid=$true; artifacts=$styleDir; actualCamera='orthographic front'; actualLighting='soft studio'; paletteApplied=$true; explicitPrimaryColor=$true; glbRoundTrip=$true; blendRoundTrip=$true})
$clock.Stop()
$result = [pscustomobject]@{valid=$true; platform='Windows x64'; runId=$runId; elapsedSeconds=$clock.Elapsed.TotalSeconds; checks=$summary}
$result | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath (Join-Path $runDir 'summary.json') -Encoding UTF8
Write-Output ($result | ConvertTo-Json -Depth 6)

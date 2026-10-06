#Requires -Version 5.1
<#!
Native Windows entry point. No Python, Node.js, desktop UI, administrator rights,
or new Codex login is required to prepare the pinned headless CLI. Missing
downloads require explicit consent. Receipts interoperate with bootstrap.py.
!#>
[CmdletBinding()]
param(
    [ValidateSet('ensure')][string]$Command = 'ensure',
    [switch]$ConsentDownloads,
    [switch]$Needs3d,
    [switch]$LoginIfNeeded,
    [switch]$LocalOnly,
    [switch]$PrintCommand,
    [string]$DataDir,
    [switch]$TestMode,
    [string]$Package,
    [string]$Manifest,
    [string]$RuntimeRoot
)

$ErrorActionPreference = 'Stop'
Set-StrictMode -Version 2.0
$script:Owner = [ordered]@{ format = 'asset-studio-cli-bootstrap'; schemaVersion = 1 }
$script:MaxManifest = 2MB
$script:MaxArchive = 512MB
$script:MaxFile = 256MB
$script:MaxTotal = 1GB
$script:MaxFiles = 4096
$script:Utf8 = New-Object System.Text.UTF8Encoding($false, $true)

function Stop-Bootstrap([string]$Code, [string]$Message) {
    $exception = New-Object System.InvalidOperationException($Message)
    $exception.Data['bootstrapCode'] = $Code
    throw $exception
}
function Write-Event([string]$Event, [System.Collections.IDictionary]$Fields) {
    $record = [ordered]@{ event = $Event }
    foreach ($key in $Fields.Keys) { $record[$key] = $Fields[$key] }
    [Console]::Out.WriteLine(($record | ConvertTo-Json -Depth 100 -Compress))
}
function Get-Field($Object, [string]$Name) {
    if ($null -eq $Object) { return $null }
    $property = $Object.PSObject.Properties[$Name]
    if ($null -eq $property) { return $null }
    return $property.Value
}
function Test-JsonEqual($Left, $Right) {
    if ($null -eq $Left -or $null -eq $Right) { return $null -eq $Left -and $null -eq $Right }
    $leftArray = $Left -is [System.Collections.IList]
    $rightArray = $Right -is [System.Collections.IList]
    if ($leftArray -or $rightArray) {
        if (-not ($leftArray -and $rightArray) -or $Left.Count -ne $Right.Count) { return $false }
        for ($index = 0; $index -lt $Left.Count; $index++) {
            if (-not (Test-JsonEqual $Left[$index] $Right[$index])) { return $false }
        }
        return $true
    }
    $leftObject = $Left -is [pscustomobject]
    $rightObject = $Right -is [pscustomobject]
    if ($leftObject -or $rightObject) {
        if (-not ($leftObject -and $rightObject)) { return $false }
        $leftNames = @($Left.PSObject.Properties.Name | Sort-Object)
        $rightNames = @($Right.PSObject.Properties.Name | Sort-Object)
        if ($leftNames.Count -ne $rightNames.Count) { return $false }
        for ($index = 0; $index -lt $leftNames.Count; $index++) {
            if ($leftNames[$index] -cne $rightNames[$index] -or
                -not (Test-JsonEqual (Get-Field $Left $leftNames[$index]) (Get-Field $Right $rightNames[$index]))) {
                return $false
            }
        }
        return $true
    }
    if ($Left -is [bool] -or $Right -is [bool]) { return ($Left -is [bool]) -and ($Right -is [bool]) -and $Left -eq $Right }
    if ($Left -is [string] -or $Right -is [string]) { return ($Left -is [string]) -and ($Right -is [string]) -and $Left -ceq $Right }
    return $Left -eq $Right
}
function Get-AbsolutePath([string]$Path) {
    if (-not $Path -or -not [IO.Path]::IsPathRooted($Path) -or $Path -match '(^|[\\/])\.\.([\\/]|$)') {
        Stop-Bootstrap 'unsafe_path' 'Use an absolute path without parent traversal.'
    }
    $absolute = [IO.Path]::GetFullPath($Path)
    if ($absolute -eq [IO.Path]::GetPathRoot($absolute)) { return $absolute }
    return $absolute.TrimEnd([IO.Path]::DirectorySeparatorChar)
}
function Assert-NoLinks([string]$Path) {
    $absolute = Get-AbsolutePath $Path
    $current = $absolute
    while ($current) {
        if (Test-Path -LiteralPath $current) {
            $entry = Get-Item -LiteralPath $current -Force
            if (($entry.Attributes -band [IO.FileAttributes]::ReparsePoint) -ne 0) {
                Stop-Bootstrap 'unsafe_path' 'Runtime paths cannot contain symbolic links or reparse points.'
            }
        }
        $parent = [IO.Path]::GetDirectoryName($current)
        if ($parent -eq $current) { break }
        $current = $parent
    }
}
function Ensure-Directory([string]$Path) {
    Assert-NoLinks $Path
    if (Test-Path -LiteralPath $Path) {
        if (-not (Get-Item -LiteralPath $Path -Force).PSIsContainer) {
            Stop-Bootstrap 'unsafe_path' 'A runtime parent is not a directory.'
        }
    } else {
        [void][IO.Directory]::CreateDirectory($Path)
        Assert-NoLinks $Path
    }
}
function Read-Json([string]$Path) {
    Assert-NoLinks $Path
    $entry = Get-Item -LiteralPath $Path -Force
    if ($entry.PSIsContainer -or $entry.Length -gt $script:MaxManifest) {
        Stop-Bootstrap 'invalid_manifest' 'Runtime metadata must be a bounded regular UTF-8 JSON file.'
    }
    try { $value = $script:Utf8.GetString([IO.File]::ReadAllBytes($Path)) | ConvertFrom-Json }
    catch { Stop-Bootstrap 'invalid_manifest' 'Runtime metadata must be valid UTF-8 JSON.' }
    if ($null -eq $value -or $value -isnot [pscustomobject]) {
        Stop-Bootstrap 'invalid_manifest' 'Runtime metadata must be a JSON object.'
    }
    return $value
}
function Write-NewJson([string]$Path, $Value) {
    Assert-NoLinks $Path
    $bytes = $script:Utf8.GetBytes(($Value | ConvertTo-Json -Depth 100 -Compress))
    $stream = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
    try { $stream.Write($bytes, 0, $bytes.Length); $stream.Flush($true) } finally { $stream.Dispose() }
}
function Get-RelativeName($Value) {
    if ($Value -isnot [string] -or -not $Value -or $Value.Length -gt 240 -or
        $Value -notmatch '^[A-Za-z0-9_.\-/]+$' -or $Value.StartsWith('/')) {
        Stop-Bootstrap 'unsafe_path' 'Runtime inventory needs bounded portable ASCII relative paths.'
    }
    foreach ($part in $Value.Split('/')) {
        if (-not $part -or $part -eq '.' -or $part -eq '..' -or $part.EndsWith('.') -or
            $part -match '^(CON|PRN|AUX|NUL|COM[1-9]|LPT[1-9])(?:\.|$)') {
            Stop-Bootstrap 'unsafe_path' 'Runtime paths cannot contain traversal or reserved file names.'
        }
    }
    return $Value
}
function Get-Parents([string]$Name) {
    $position = $Name.LastIndexOf('/')
    while ($position -ge 0) {
        $Name = $Name.Substring(0, $position)
        $Name
        $position = $Name.LastIndexOf('/')
    }
}
function Get-BoundedInteger($Value, [long]$Maximum, [bool]$AllowZero = $false) {
    if ($Value -is [bool] -or ($Value -isnot [int] -and $Value -isnot [long]) -or $Value -lt 0 -or
        (-not $AllowZero -and $Value -eq 0) -or $Value -gt $Maximum) {
        Stop-Bootstrap 'invalid_inventory' 'Runtime byte counts must be bounded integers.'
    }
    return [long]$Value
}
function Get-Digest($Value) {
    if ($Value -isnot [string] -or $Value -cnotmatch '^[0-9a-f]{64}$') {
        Stop-Bootstrap 'invalid_inventory' 'Runtime checksums must be lowercase SHA-256.'
    }
    return $Value
}
function Get-PackageSpec($Metadata, [string]$Platform) {
    if ((Get-Field $Metadata 'format') -cne 'asset-studio-cli-runtime' -or (Get-Field $Metadata 'schemaVersion') -ne 1) {
        Stop-Bootstrap 'invalid_manifest' 'Unsupported native runtime manifest format.'
    }
    $item = Get-Field (Get-Field $Metadata 'packages') $Platform
    if ($null -eq $item) { Stop-Bootstrap 'runtime_unavailable' 'No verified native CLI package is published for this platform.' }
    $version = Get-Field $item 'version'
    if ($version -isnot [string] -or $version.Length -gt 64 -or $version -cnotmatch '^[0-9]+\.[0-9]+\.[0-9]+(?:-[A-Za-z0-9.-]+)?$') {
        Stop-Bootstrap 'invalid_manifest' 'The runtime release needs a fixed version.'
    }
    $url = Get-Field $item 'url'
    $pattern = '^https://github\.com/oocheol/masset/releases/download/v' + [regex]::Escape($version) + '/[A-Za-z0-9._-]+\.zip$'
    if ($url -isnot [string] -or $url.Length -gt 2048 -or $url -cnotmatch $pattern) {
        Stop-Bootstrap 'invalid_manifest' 'Only the pinned oocheol/masset GitHub release ZIP is allowed.'
    }
    $license = Get-Field $item 'license'
    if ($license -isnot [string] -or -not $license.Trim() -or $license.Length -gt 1024) {
        Stop-Bootstrap 'invalid_manifest' 'The runtime package must identify its licenses.'
    }
    $files = Get-Field $item 'files'
    if ($files -isnot [System.Collections.IList] -or $files.Count -lt 1 -or $files.Count -gt $script:MaxFiles) {
        Stop-Bootstrap 'invalid_inventory' 'A complete bounded file inventory is required.'
    }
    $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
    $inventory = New-Object 'System.Collections.Generic.List[object]'
    $total = 0L
    foreach ($entry in $files) {
        $name = Get-RelativeName (Get-Field $entry 'path')
        if (-not $seen.Add($name) -or $name -ieq 'installation.json') {
            Stop-Bootstrap 'invalid_inventory' 'Inventory paths must be unique, including case and receipt names.'
        }
        $bytes = Get-BoundedInteger (Get-Field $entry 'bytes') $script:MaxFile $true
        $total += $bytes
        $executable = Get-Field $entry 'executable'
        if ($null -eq $executable) { $executable = $false }
        if ($executable -isnot [bool]) { Stop-Bootstrap 'invalid_inventory' 'The executable marker must be a boolean.' }
        $inventory.Add([ordered]@{ path = $name; bytes = $bytes; sha256 = (Get-Digest (Get-Field $entry 'sha256')); executable = $executable })
    }
    if ($total -gt $script:MaxTotal) { Stop-Bootstrap 'invalid_inventory' 'The runtime exceeds its unpacked byte budget.' }
    foreach ($entry in $inventory) {
        foreach ($parent in @(Get-Parents $entry.path)) {
            if ($seen.Contains($parent)) { Stop-Bootstrap 'invalid_inventory' 'A runtime file cannot also be a directory.' }
        }
    }
    $cli = Get-RelativeName (Get-Field $item 'cliPath')
    $resources = Get-RelativeName (Get-Field $item 'resourcePath')
    if ($cli -cne 'asset-cli.exe' -or $resources -cne 'resources' -or -not $seen.Contains($cli) -or
        -not $seen.Contains('resources/workers/blender/worker.py') -or -not $seen.Contains('resources/LICENSE')) {
        Stop-Bootstrap 'invalid_inventory' 'The CLI and required resources are missing from the pinned inventory.'
    }
    $sorted = $inventory.ToArray()
    $compare = [Comparison[object]]{ param($left, $right) return [StringComparer]::Ordinal.Compare($left['path'], $right['path']) }
    [Array]::Sort($sorted, [System.Collections.Generic.Comparer[object]]::Create($compare))
    $spec = [ordered]@{
        version = $version; url = $url; bytes = (Get-BoundedInteger (Get-Field $item 'bytes') $script:MaxArchive)
        sha256 = (Get-Digest (Get-Field $item 'sha256')); license = $license; cliPath = $cli; resourcePath = $resources
        files = @($sorted)
    }
    return ($spec | ConvertTo-Json -Depth 100 -Compress | ConvertFrom-Json)
}
function Get-Sha([IO.Stream]$Stream, [long]$Expected, [IO.Stream]$Output, $DeadlineUtc = $null) {
    $hash = [Security.Cryptography.SHA256]::Create()
    $buffer = New-Object byte[] 1048576
    $count = 0L
    try {
        while ($true) {
            if ($null -ne $DeadlineUtc -and [DateTime]::UtcNow -gt $DeadlineUtc) {
                Stop-Bootstrap 'download_failed' 'The fixed runtime download exceeded its time budget.'
            }
            $read = $Stream.Read($buffer, 0, [int][Math]::Min($buffer.Length, $Expected - $count + 1))
            if ($read -eq 0) { break }
            $count += $read
            if ($count -gt $Expected) { Stop-Bootstrap 'package_mismatch' 'A runtime file exceeds its pinned byte count.' }
            [void]$hash.TransformBlock($buffer, 0, $read, $null, 0)
            if ($null -ne $Output) { $Output.Write($buffer, 0, $read) }
        }
        if ($count -ne $Expected) { Stop-Bootstrap 'package_mismatch' 'A runtime file does not match its pinned byte count.' }
        [void]$hash.TransformFinalBlock((New-Object byte[] 0), 0, 0)
        return ([BitConverter]::ToString($hash.Hash)).Replace('-', '').ToLowerInvariant()
    } finally { $hash.Dispose() }
}
function Assert-File([string]$Path, [long]$Bytes, [string]$Sha) {
    Assert-NoLinks $Path
    $stream = [IO.File]::Open($Path, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    try {
        if ($stream.Length -ne $Bytes -or (Get-Sha $stream $Bytes $null) -cne $Sha) {
            Stop-Bootstrap 'package_mismatch' 'A runtime file does not match its pinned size and SHA-256.'
        }
    } finally { $stream.Dispose() }
}
function Get-ExpectedReceipt($Spec, [string]$Platform, [string]$Destination) {
    $receipt = [ordered]@{
        format = 'asset-studio-cli-installation'; schemaVersion = 1; platform = $Platform; package = $Spec
        cliPath = (Join-Path $Destination $Spec.cliPath); resourcePath = (Join-Path $Destination $Spec.resourcePath)
    }
    return ($receipt | ConvertTo-Json -Depth 100 -Compress | ConvertFrom-Json)
}
function Assert-Tree([string]$Root, $Spec, $Receipt) {
    Assert-NoLinks $Root
    if (-not (Test-Path -LiteralPath $Root -PathType Container)) { Stop-Bootstrap 'package_mismatch' 'Native runtime installation is not a directory.' }
    $expectedFiles = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    $expectedDirs = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    foreach ($entry in $Spec.files) {
        [void]$expectedFiles.Add($entry.path)
        foreach ($parent in @(Get-Parents $entry.path)) { [void]$expectedDirs.Add($parent) }
    }
    if ($null -ne $Receipt) { [void]$expectedFiles.Add('installation.json') }
    $actual = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    $pending = New-Object 'System.Collections.Generic.Queue[string]'
    $pending.Enqueue($Root)
    while ($pending.Count -gt 0) {
        $directory = $pending.Dequeue()
        foreach ($entry in @(Get-ChildItem -LiteralPath $directory -Force)) {
            Assert-NoLinks $entry.FullName
            $relative = $entry.FullName.Substring($Root.Length + 1).Replace('\', '/')
            if ($entry.PSIsContainer) {
                if (-not $expectedDirs.Contains($relative)) { Stop-Bootstrap 'package_mismatch' 'Unknown runtime directories were preserved without changes.' }
                $pending.Enqueue($entry.FullName)
            } else {
                if (-not $expectedFiles.Contains($relative)) { Stop-Bootstrap 'package_mismatch' 'Unknown runtime files were preserved without changes.' }
                [void]$actual.Add($relative)
            }
        }
    }
    if (-not $actual.SetEquals($expectedFiles)) { Stop-Bootstrap 'package_mismatch' 'Unknown, missing or edited runtime files were preserved without changes.' }
    foreach ($entry in $Spec.files) { Assert-File (Join-Path $Root $entry.path) $entry.bytes $entry.sha256 }
    if ($null -ne $Receipt -and -not (Test-JsonEqual (Read-Json (Join-Path $Root 'installation.json')) $Receipt)) {
        Stop-Bootstrap 'package_mismatch' 'The installed runtime receipt does not match the pinned release.'
    }
}
function Open-InstallLock([string]$Base) {
    Assert-NoLinks $Base
    if (Test-Path -LiteralPath $Base) {
        if (-not (Test-Path -LiteralPath (Join-Path $Base '.bootstrap-owner.json'))) {
            if (@(Get-ChildItem -LiteralPath $Base -Force).Count) {
                Stop-Bootstrap 'unmanaged_directory' 'An existing unowned runtime directory was preserved without changes.'
            }
            Write-NewJson (Join-Path $Base '.bootstrap-owner.json') $script:Owner
        }
        $owner = $script:Owner | ConvertTo-Json -Compress | ConvertFrom-Json
        if (-not (Test-JsonEqual (Read-Json (Join-Path $Base '.bootstrap-owner.json')) $owner)) {
            Stop-Bootstrap 'unmanaged_directory' 'An unknown runtime owner receipt was preserved without changes.'
        }
    } else {
        Ensure-Directory $Base
        Write-NewJson (Join-Path $Base '.bootstrap-owner.json') $script:Owner
    }
    $lockPath = Join-Path $Base '.bootstrap.lock'
    Assert-NoLinks $lockPath
    $stream = [IO.File]::Open($lockPath, [IO.FileMode]::OpenOrCreate, [IO.FileAccess]::ReadWrite, [IO.FileShare]::ReadWrite)
    try { $stream.Lock(0, 1) } catch { $stream.Dispose(); Stop-Bootstrap 'bootstrap_busy' 'Another native CLI preparation is running; try again after it finishes.' }
    try {
        if ($stream.Length -gt 1024) { Stop-Bootstrap 'unmanaged_directory' 'An unknown lock file was preserved without changes.' }
        if ($stream.Length -gt 0) {
            $bytes = New-Object byte[] ([int]$stream.Length)
            [void]$stream.Read($bytes, 0, $bytes.Length)
            try { $marker = $script:Utf8.GetString($bytes) | ConvertFrom-Json } catch { Stop-Bootstrap 'unmanaged_directory' 'An unknown lock file was preserved without changes.' }
            if ((Get-Field $marker 'format') -cne $script:Owner.format -or (Get-Field $marker 'schemaVersion') -ne 1) {
                Stop-Bootstrap 'unmanaged_directory' 'An unknown lock file was preserved without changes.'
            }
        }
        $marker = [ordered]@{ format = $script:Owner.format; schemaVersion = 1; pid = $PID }
        $bytes = $script:Utf8.GetBytes(($marker | ConvertTo-Json -Compress))
        $stream.Position = 0; $stream.Write($bytes, 0, $bytes.Length); $stream.SetLength($bytes.Length); $stream.Flush($true)
        return $stream
    } catch { $stream.Unlock(0, 1); $stream.Dispose(); throw }
}
function Get-ReleaseArchive($Spec, [string]$Path) {
    $allowedHosts = @('github.com', 'release-assets.githubusercontent.com', 'objects.githubusercontent.com')
    $uri = [Uri]$Spec.url
    $redirects = 0
    $response = $null
    $previousTls = [Net.ServicePointManager]::SecurityProtocol
    [Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12
    try {
        while ($true) {
            if ($uri.Scheme -cne 'https' -or $uri.UserInfo -or $uri.Fragment -or $uri.Port -ne 443 -or $allowedHosts -cnotcontains $uri.Host) {
                Stop-Bootstrap 'unsafe_redirect' 'The release download redirected outside the official HTTPS asset hosts.'
            }
            $request = [Net.HttpWebRequest]::Create($uri)
            $request.AllowAutoRedirect = $false; $request.Timeout = 30000; $request.ReadWriteTimeout = 30000
            $request.UserAgent = 'AssetStudioSkillBootstrap/1'
            $response = $request.GetResponse()
            if ([int]$response.StatusCode -in @(301, 302, 303, 307, 308)) {
                if (++$redirects -gt 5 -or -not $response.Headers['Location']) { Stop-Bootstrap 'unsafe_redirect' 'The release download exceeded its redirect limit.' }
                $uri = New-Object Uri($uri, $response.Headers['Location'])
                $response.Close(); $response = $null
                continue
            }
            if ([int]$response.StatusCode -ne 200 -or ($response.ContentLength -ge 0 -and $response.ContentLength -ne $Spec.bytes)) {
                Stop-Bootstrap 'package_mismatch' 'The download does not match the pinned response and Content-Length.'
            }
            $source = $response.GetResponseStream()
            $output = [IO.File]::Open($Path, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            try {
                if ((Get-Sha $source $Spec.bytes $output ([DateTime]::UtcNow.AddSeconds(900))) -cne $Spec.sha256) { Stop-Bootstrap 'package_mismatch' 'The downloaded ZIP failed its pinned SHA-256 verification.' }
                $output.Flush($true)
            } finally { $source.Dispose(); $output.Dispose() }
            return
        }
    } catch [Net.WebException] { Stop-Bootstrap 'download_failed' 'The fixed GitHub runtime ZIP could not be downloaded; no CLI was executed.' }
    finally { if ($null -ne $response) { $response.Close() }; [Net.ServicePointManager]::SecurityProtocol = $previousTls }
}
function Expand-VerifiedArchive([string]$Archive, [string]$Stage, $Spec) {
    Add-Type -AssemblyName System.IO.Compression
    Assert-File $Archive $Spec.bytes $Spec.sha256
    $expected = @{}
    $directories = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
    foreach ($entry in $Spec.files) {
        $expected[$entry.path] = $entry
        foreach ($parent in @(Get-Parents $entry.path)) { [void]$directories.Add($parent) }
    }
    $source = [IO.File]::Open($Archive, [IO.FileMode]::Open, [IO.FileAccess]::Read, [IO.FileShare]::Read)
    $bundle = New-Object IO.Compression.ZipArchive($source, [IO.Compression.ZipArchiveMode]::Read, $true)
    try {
        if ($bundle.Entries.Count -gt $script:MaxFiles * 2) { Stop-Bootstrap 'unsafe_archive' 'The ZIP contains too many entries.' }
        $seen = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::OrdinalIgnoreCase)
        $actual = New-Object 'System.Collections.Generic.HashSet[string]' ([StringComparer]::Ordinal)
        foreach ($member in $bundle.Entries) {
            $isDirectory = $member.FullName.EndsWith('/')
            $name = Get-RelativeName $member.FullName.TrimEnd('/')
            if (-not $seen.Add($name)) { Stop-Bootstrap 'unsafe_archive' 'The ZIP contains duplicate or case-colliding paths.' }
            $mode = ([long]$member.ExternalAttributes -shr 16) -band 65535
            $kind = $mode -band 61440
            if ($kind -notin @(0, 32768, 16384) -or ($member.ExternalAttributes -band 1024) -ne 0) {
                Stop-Bootstrap 'unsafe_archive' 'The ZIP contains linked or special entries.'
            }
            if ($isDirectory) {
                if (-not $directories.Contains($name) -or $member.Length -ne 0 -or $kind -eq 32768) { Stop-Bootstrap 'unsafe_archive' 'The ZIP has an unexpected directory entry.' }
                continue
            }
            $entry = $expected[$name]
            if ($null -eq $entry -or $entry.path -cne $name -or $member.Length -ne $entry.bytes -or $kind -eq 16384 -or
                ($member.Length -gt 1MB -and $member.Length -gt [Math]::Max(1, $member.CompressedLength) * 1000)) {
                Stop-Bootstrap 'unsafe_archive' 'The ZIP file inventory differs from the pinned release or exceeds its compression budget.'
            }
            [void]$actual.Add($name)
        }
        if (-not $actual.SetEquals([string[]]@($expected.Keys))) { Stop-Bootstrap 'unsafe_archive' 'The ZIP is incomplete.' }
        foreach ($member in $bundle.Entries) {
            if ($member.FullName.EndsWith('/')) { continue }
            $entry = $expected[$member.FullName]
            $destination = Join-Path $Stage $entry.path
            Ensure-Directory ([IO.Path]::GetDirectoryName($destination))
            $output = [IO.File]::Open($destination, [IO.FileMode]::CreateNew, [IO.FileAccess]::Write, [IO.FileShare]::None)
            $inputStream = $member.Open()
            try {
                if ((Get-Sha $inputStream $entry.bytes $output) -cne $entry.sha256) { Stop-Bootstrap 'package_mismatch' 'An extracted file failed its pinned SHA-256 verification.' }
                $output.Flush($true)
            } finally { $inputStream.Dispose(); $output.Dispose() }
        }
    } finally { $bundle.Dispose(); $source.Dispose() }
    Assert-Tree $Stage $Spec $null
}

try {
    if ($LocalOnly -and $LoginIfNeeded) { Stop-Bootstrap 'invalid_arguments' '-LocalOnly cannot be combined with -LoginIfNeeded.' }
    if (-not $TestMode -and ($Package -or $Manifest -or $RuntimeRoot)) {
        Stop-Bootstrap 'test_only_option' 'Local package, manifest and runtime-root overrides require -TestMode.'
    }
    if ($env:OS -cne 'Windows_NT' -or -not [Environment]::Is64BitOperatingSystem -or
        ($env:PROCESSOR_ARCHITECTURE -ine 'AMD64' -and $env:PROCESSOR_ARCHITEW6432 -ine 'AMD64')) {
        Stop-Bootstrap 'unsupported_platform' 'This entry point supports Windows x64 only.'
    }
    if (-not $Manifest) { $Manifest = Join-Path (Split-Path $PSScriptRoot -Parent) 'references/native-runtime.json' }
    $Manifest = Get-AbsolutePath $Manifest
    $platform = 'windows-x64'
    $spec = Get-PackageSpec (Read-Json $Manifest) $platform
    if (-not $RuntimeRoot) {
        if (-not $env:LOCALAPPDATA) { Stop-Bootstrap 'unsafe_path' 'Windows LOCALAPPDATA is required for the private runtime.' }
        $RuntimeRoot = Join-Path $env:LOCALAPPDATA 'AssetStudioCLI/runtimes'
    }
    $base = Get-AbsolutePath $RuntimeRoot
    if ($DataDir) { $DataDir = Get-AbsolutePath $DataDir; Assert-NoLinks $DataDir }
    $destination = Join-Path $base ($spec.version + '-' + $platform + '-' + $spec.sha256.Substring(0, 16))
    Assert-NoLinks $destination
    $receipt = Get-ExpectedReceipt $spec $platform $destination
    $unchanged = $false
    if (Test-Path -LiteralPath $destination) {
        Assert-Tree $destination $spec $receipt
        $unchanged = $true
    } else {
        if (-not $ConsentDownloads) {
            Write-Event 'needs_consent' ([ordered]@{
                code = 'runtime_download_consent_required'; platform = $platform; version = $spec.version
                downloads = @([ordered]@{ url = $spec.url; bytes = $spec.bytes; sha256 = $spec.sha256; license = $spec.license })
                message = 'Native CLI download requires -ConsentDownloads; no files were downloaded or installed.'
            })
            exit 3
        }
        $lock = Open-InstallLock $base
        try {
            if (Test-Path -LiteralPath $destination) {
                Assert-Tree $destination $spec $receipt
                $unchanged = $true
            } else {
                Write-Event 'download_plan' ([ordered]@{ platform = $platform; version = $spec.version; url = $spec.url; bytes = $spec.bytes; sha256 = $spec.sha256; license = $spec.license })
                if ($Package) {
                    $archive = Get-AbsolutePath $Package
                } else {
                    if ($TestMode) { Stop-Bootstrap 'test_download_refused' 'Test mode requires a local package and never accesses the network.' }
                    $archive = Join-Path $base ('.download-' + [Guid]::NewGuid().ToString('N') + '.zip')
                    Get-ReleaseArchive $spec $archive
                }
                Assert-File $archive $spec.bytes $spec.sha256
                $stage = Join-Path $base ('.stage-' + [Guid]::NewGuid().ToString('N'))
                Ensure-Directory $stage
                Expand-VerifiedArchive $archive $stage $spec
                Write-NewJson (Join-Path $stage 'installation.json') $receipt
                Assert-Tree $stage $spec $receipt
                Assert-NoLinks $destination
                if (Test-Path -LiteralPath $destination) { Stop-Bootstrap 'package_mismatch' 'An existing runtime was preserved without replacement.' }
                [IO.Directory]::Move($stage, $destination)
                Assert-Tree $destination $spec $receipt
            }
        } finally { $lock.Unlock(0, 1); $lock.Dispose() }
    }
    $prepare = @($receipt.cliPath, 'prepare', '--resources', $receipt.resourcePath)
    if ($Needs3d) { $prepare += '--needs-3d' }
    if ($ConsentDownloads) { $prepare += '--consent-downloads' }
    if ($LoginIfNeeded) { $prepare += '--login-if-needed' }
    if ($LocalOnly) { $prepare += '--local-only' }
    if ($DataDir) { $prepare += @('--data-dir', $DataDir) }
    $doctor = @($receipt.cliPath, 'doctor', '--resources', $receipt.resourcePath)
    if (-not $LocalOnly) { $doctor += '--check-gpt' }
    if ($DataDir) { $doctor += @('--data-dir', $DataDir) }
    Write-Event 'runtime_ready' ([ordered]@{
        platform = $platform; version = $spec.version; cliPath = $receipt.cliPath; resourcePath = $receipt.resourcePath
        runtimePath = $destination; installed = $true; unchanged = $unchanged; prepareCommand = $prepare; doctorCommand = $doctor
    })
    if ($PrintCommand -or $TestMode) { exit 0 }
    Assert-Tree $destination $spec $receipt
    & $receipt.cliPath @($prepare | Select-Object -Skip 1)
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
    Assert-Tree $destination $spec $receipt
    & $receipt.cliPath @($doctor | Select-Object -Skip 1)
    exit $LASTEXITCODE
} catch {
    $code = $_.Exception.Data['bootstrapCode']
    $message = $_.Exception.Message
    if (-not $code) { $code = 'bootstrap_failed'; $message = 'Native CLI preparation failed; existing files and download evidence were preserved.' }
    Write-Event 'needs_attention' ([ordered]@{ code = $code; message = $message })
    exit 1
}

$ErrorActionPreference = 'Stop'
[Console]::InputEncoding = New-Object System.Text.UTF8Encoding
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding
try {
    $bookMovePayload = [Console]::In.ReadToEnd() | ConvertFrom-Json
    $bookMoveRoot = [System.IO.Path]::GetFullPath([string]$bookMovePayload.libraryRoot).TrimEnd('\', '/')
    $bookMoveSource = [System.IO.Path]::GetFullPath([string]$bookMovePayload.source)
    $bookMoveTarget = [System.IO.Path]::GetFullPath([string]$bookMovePayload.destination)
    $bookMovePrefix = $bookMoveRoot + [System.IO.Path]::DirectorySeparatorChar
    if (-not $bookMoveSource.StartsWith($bookMovePrefix, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not $bookMoveTarget.StartsWith($bookMovePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Move paths must stay inside the library.'
    }
    if ([System.IO.Directory]::Exists($bookMoveSource)) {
        [System.IO.Directory]::Move($bookMoveSource, $bookMoveTarget)
    } else {
        [System.IO.File]::Move($bookMoveSource, $bookMoveTarget)
    }
    [Console]::WriteLine('{"success":true}')
} catch {
    $bookMoveFailure = $_.Exception
    while ($bookMoveFailure.InnerException) { $bookMoveFailure = $bookMoveFailure.InnerException }
    $bookMoveCode = $bookMoveFailure.HResult -band 65535
    [Console]::WriteLine((@{ success = $false; nativeCode = $bookMoveCode } | ConvertTo-Json -Compress))
    exit 1
}

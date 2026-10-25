param(
  [string]$Target = $PSScriptRoot,
  [switch]$MeasureOnly,
  [switch]$ExecutableOnly
)
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new($false)
$standaloneRelease = Test-Path -LiteralPath (Join-Path $PSScriptRoot 'build-manifest.json')
$projectRoot = if ($standaloneRelease) { [System.IO.Path]::GetFullPath($PSScriptRoot) } else { [System.IO.Path]::GetFullPath((Split-Path -Parent (Split-Path -Parent $PSScriptRoot))) }
$programTarget = [System.IO.Path]::GetFullPath($Target).TrimEnd('\')
$outputRoot = Join-Path $projectRoot 'out'
$isCurrentProgram = $programTarget.Equals($projectRoot, [System.StringComparison]::OrdinalIgnoreCase)
$isRelease = $programTarget.StartsWith($outputRoot + '\', [System.StringComparison]::OrdinalIgnoreCase) -and (Test-Path -LiteralPath (Join-Path $programTarget 'build-manifest.json'))
if (!$isCurrentProgram -and !$isRelease) { throw 'Only the current program or a generated release can be compacted.' }
function Assert-RuntimePath([string]$Candidate) {
  $checkedCandidate = [System.IO.Path]::GetFullPath($Candidate)
  if (!$checkedCandidate.Equals($projectRoot, [System.StringComparison]::OrdinalIgnoreCase) -and !$checkedCandidate.StartsWith($projectRoot + '\', [System.StringComparison]::OrdinalIgnoreCase)) { throw 'Runtime path leaves the program workspace.' }
  $cursor = $checkedCandidate
  while ($cursor) {
    if ((Get-Item -LiteralPath $cursor -Force).Attributes -band [System.IO.FileAttributes]::ReparsePoint) { throw 'Runtime paths must not contain symbolic links or junctions.' }
    if ($cursor.Equals($projectRoot, [System.StringComparison]::OrdinalIgnoreCase)) { break }
    $cursor = Split-Path -Parent $cursor
  }
}
Assert-RuntimePath $programTarget
$executablePath = Join-Path $programTarget 'exhentai-manga-manager.exe'
if (!(Test-Path -LiteralPath $executablePath -PathType Leaf)) { throw 'The application executable is missing.' }

Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.Runtime.InteropServices;
using Microsoft.Win32.SafeHandles;
public static class YanruyuAllocatedSize {
  [StructLayout(LayoutKind.Sequential)]
  private struct StandardInfo {
    public long AllocationSize;
    public long EndOfFile;
    public uint Links;
    [MarshalAs(UnmanagedType.U1)] public bool DeletePending;
    [MarshalAs(UnmanagedType.U1)] public bool Directory;
  }
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode, SetLastError=true)]
  private static extern SafeFileHandle CreateFileW(string name, uint access, uint share, IntPtr security, uint mode, uint flags, IntPtr template);
  [DllImport("kernel32.dll", SetLastError=true)]
  private static extern bool GetFileInformationByHandleEx(SafeFileHandle handle, int info, out StandardInfo value, uint size);
  public static ulong Read(string name) {
    using (var handle = CreateFileW(name, 0x80, 7, IntPtr.Zero, 3, 0, IntPtr.Zero)) {
      if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
      StandardInfo info;
      if (!GetFileInformationByHandleEx(handle, 1, out info, (uint)Marshal.SizeOf(typeof(StandardInfo))))
        throw new Win32Exception(Marshal.GetLastWin32Error());
      return (ulong)info.AllocationSize;
    }
  }
  public static string Hash(string name) {
    using (var stream = System.IO.File.OpenRead(name))
    using (var hash = System.Security.Cryptography.SHA256.Create())
      return BitConverter.ToString(hash.ComputeHash(stream)).Replace("-", "").ToLowerInvariant();
  }
}
'@

$runtimeFiles = [System.Collections.Generic.List[System.IO.FileInfo]]::new()
$runtimeFiles.Add((Get-Item -LiteralPath $executablePath))
if (!$ExecutableOnly) {
  Get-ChildItem -LiteralPath $programTarget -File | Where-Object { $_.Extension -in @('.dll', '.pak', '.bin', '.dat') -or $_.Name -eq 'LICENSES.chromium.html' } | ForEach-Object { $runtimeFiles.Add($_) }
  foreach ($runtimeSubdirectory in @('locales', 'resources')) {
    $runtimeSubpath = Join-Path $programTarget $runtimeSubdirectory
    if (Test-Path -LiteralPath $runtimeSubpath) {
      Assert-RuntimePath $runtimeSubpath
      Get-ChildItem -LiteralPath $runtimeSubpath -Recurse -Directory -Force | ForEach-Object { Assert-RuntimePath $_.FullName }
      Get-ChildItem -LiteralPath $runtimeSubpath -Recurse -File | ForEach-Object { $runtimeFiles.Add($_) }
    }
  }
}
foreach ($runtimeFile in $runtimeFiles) {
  $verifiedRuntimePath = [System.IO.Path]::GetFullPath($runtimeFile.FullName)
  if (!$verifiedRuntimePath.StartsWith($programTarget + '\', [System.StringComparison]::OrdinalIgnoreCase) -or ($runtimeFile.Attributes -band [System.IO.FileAttributes]::ReparsePoint)) { throw 'Unexpected runtime file path.' }
}
$beforeLogical = 0L; $beforeAllocated = 0L
foreach ($runtimeFile in $runtimeFiles) { $beforeLogical += $runtimeFile.Length; $beforeAllocated += [long][YanruyuAllocatedSize]::Read($runtimeFile.FullName) }
$exeBefore = [long][YanruyuAllocatedSize]::Read($executablePath)
$exeDigest = [YanruyuAllocatedSize]::Hash($executablePath)
$compactedCount = 0
if (!$MeasureOnly) {
  $compactProgram = Join-Path $env:WINDIR 'System32\compact.exe'
  $compactBatch = [System.Collections.Generic.List[string]]::new()
  $compactBatchLength = 0
  foreach ($runtimeFile in $runtimeFiles) {
    # Small files gain little from executable compression and add filesystem overhead.
    if ($runtimeFile.Length -lt 65536) { continue }
    if ($compactBatchLength + $runtimeFile.FullName.Length -gt 18000) {
      & $compactProgram /C /A /I /EXE:LZX $compactBatch.ToArray() | Out-Null
      if ($LASTEXITCODE -ne 0) { throw 'Windows executable compression did not finish successfully.' }
      $compactedCount += $compactBatch.Count
      $compactBatch.Clear(); $compactBatchLength = 0
    }
    $compactBatch.Add($runtimeFile.FullName); $compactBatchLength += $runtimeFile.FullName.Length + 3
  }
  if ($compactBatch.Count) {
    & $compactProgram /C /A /I /EXE:LZX $compactBatch.ToArray() | Out-Null
    if ($LASTEXITCODE -ne 0) { throw 'Windows executable compression did not finish successfully.' }
    $compactedCount += $compactBatch.Count
  }
}
if ([YanruyuAllocatedSize]::Hash($executablePath) -ne $exeDigest) { throw 'Executable bytes changed unexpectedly.' }
$afterAllocated = 0L
foreach ($runtimeFile in $runtimeFiles) { $afterAllocated += [long][YanruyuAllocatedSize]::Read($runtimeFile.FullName) }
[pscustomobject]@{
  method = 'Windows transparent executable compression (LZX)'
  scope = 'This installation on an NTFS volume only. Copying or ZIP extraction may remove compression; run the bundled optimization script again if needed.'
  allocationMeasurement = 'Windows FILE_STANDARD_INFO.AllocationSize; excludes filesystem metadata and shared hard-link deduplication'
  measuredAt = (Get-Date).ToUniversalTime().ToString('o')
  target = $programTarget
  files = $runtimeFiles.Count
  filesCompacted = $compactedCount
  logicalBytes = $beforeLogical
  allocatedBytesBefore = $beforeAllocated
  allocatedBytesAfter = $afterAllocated
  savedBytes = $beforeAllocated - $afterAllocated
  executable = [pscustomobject]@{ logicalBytes=(Get-Item -LiteralPath $executablePath).Length; allocatedBytesBefore=$exeBefore; allocatedBytesAfter=[long][YanruyuAllocatedSize]::Read($executablePath); sha256=$exeDigest.ToLowerInvariant(); bytesUnchanged=$true }
} | ConvertTo-Json -Depth 4

param(
  [ValidateSet('capability', 'recognize')][string]$Mode = 'capability',
  [string]$ImagePath = '',
  [string]$Language = ''
)

$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$OutputEncoding = [Console]::OutputEncoding
$stream = $null
$bitmap = $null

try {
  Add-Type -AssemblyName System.Runtime.WindowsRuntime
  $null = [Windows.Media.Ocr.OcrEngine, Windows.Foundation, ContentType = WindowsRuntime]
  $null = [Windows.Globalization.Language, Windows.Globalization, ContentType = WindowsRuntime]
  $languages = @([Windows.Media.Ocr.OcrEngine]::AvailableRecognizerLanguages | ForEach-Object {
    @{ tag = $_.LanguageTag; name = $_.DisplayName }
  })
  if ($Mode -eq 'capability') {
    @{ available = ($languages.Count -gt 0); languages = $languages; maximumImageDimension = [Windows.Media.Ocr.OcrEngine]::MaxImageDimension;
      reason = $(if ($languages.Count -gt 0) { '' } else { 'Windows has no installed OCR language. Manual text import remains available.' }) } | ConvertTo-Json -Depth 5 -Compress
    exit 0
  }
  if (-not [System.IO.Path]::IsPathRooted($ImagePath) -or $ImagePath.StartsWith('\\')) { throw 'OCR requires a local absolute image path.' }
  $fileInfo = Get-Item -LiteralPath $ImagePath
  if ($fileInfo.PSIsContainer -or $fileInfo.Length -gt 20971520 -or $fileInfo.Length -eq 0 -or ($fileInfo.Attributes -band [IO.FileAttributes]::ReparsePoint)) { throw 'OCR image must be a regular local file of at most 20 MiB.' }
  if ($fileInfo.Extension -notmatch '^\.(png|jpe?g|bmp|tiff?)$') { throw 'Unsupported OCR image extension.' }
  if ($Language) {
    if ($Language -notmatch '^[a-zA-Z0-9-]{2,35}$' -or $Language -notin @($languages | ForEach-Object { $_.tag })) { throw 'Requested OCR language is not installed.' }
    $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language($Language)))
  } else { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromUserProfileLanguages() }
  if (-not $engine -and $languages.Count -gt 0) { $engine = [Windows.Media.Ocr.OcrEngine]::TryCreateFromLanguage((New-Object Windows.Globalization.Language($languages[0].tag))) }
  if (-not $engine) { throw 'Windows has no usable OCR language. Paste text instead.' }

  $script:asTask = [System.WindowsRuntimeSystemExtensions].GetMethods() | Where-Object {
    $_.Name -eq 'AsTask' -and $_.IsGenericMethodDefinition -and $_.GetParameters().Count -eq 1 -and $_.GetParameters()[0].ParameterType.Name -eq 'IAsyncOperation`1'
  } | Select-Object -First 1
  function Await-WinRt($Operation, [Type]$ResultType) {
    $task = $script:asTask.MakeGenericMethod($ResultType).Invoke($null, @($Operation))
    $task.GetAwaiter().GetResult()
  }
  $timer = [System.Diagnostics.Stopwatch]::StartNew()
  $null = [Windows.Storage.StorageFile, Windows.Storage, ContentType = WindowsRuntime]
  $null = [Windows.Storage.Streams.IRandomAccessStreamWithContentType, Windows.Storage.Streams, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapDecoder, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.SoftwareBitmap, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Graphics.Imaging.BitmapTransform, Windows.Graphics.Imaging, ContentType = WindowsRuntime]
  $null = [Windows.Media.Ocr.OcrResult, Windows.Foundation, ContentType = WindowsRuntime]
  $file = Await-WinRt ([Windows.Storage.StorageFile]::GetFileFromPathAsync($fileInfo.FullName)) ([Windows.Storage.StorageFile])
  $stream = Await-WinRt ($file.OpenReadAsync()) ([Windows.Storage.Streams.IRandomAccessStreamWithContentType])
  $decoder = Await-WinRt ([Windows.Graphics.Imaging.BitmapDecoder]::CreateAsync($stream)) ([Windows.Graphics.Imaging.BitmapDecoder])
  $sourceWidth = $decoder.PixelWidth
  $sourceHeight = $decoder.PixelHeight
  if ($sourceWidth -eq 0 -or $sourceHeight -eq 0 -or ([long]$sourceWidth * [long]$sourceHeight) -gt 40000000) { throw 'OCR image exceeds the 40 million pixel limit.' }
  $maximum = [Math]::Min(2600, [Windows.Media.Ocr.OcrEngine]::MaxImageDimension)
  $scale = [Math]::Min([double]1, $maximum / [double][Math]::Max($sourceWidth, $sourceHeight))
  $transform = New-Object Windows.Graphics.Imaging.BitmapTransform
  $transform.ScaledWidth = [uint32][Math]::Max(1, [Math]::Floor($sourceWidth * $scale))
  $transform.ScaledHeight = [uint32][Math]::Max(1, [Math]::Floor($sourceHeight * $scale))
  $bitmap = Await-WinRt ($decoder.GetSoftwareBitmapAsync(
      [Windows.Graphics.Imaging.BitmapPixelFormat]::Bgra8,
      [Windows.Graphics.Imaging.BitmapAlphaMode]::Premultiplied,
      $transform,
      [Windows.Graphics.Imaging.ExifOrientationMode]::RespectExifOrientation,
      [Windows.Graphics.Imaging.ColorManagementMode]::DoNotColorManage)) ([Windows.Graphics.Imaging.SoftwareBitmap])
  $result = Await-WinRt ($engine.RecognizeAsync($bitmap)) ([Windows.Media.Ocr.OcrResult])
  @{ text = $result.Text; language = $engine.RecognizerLanguage.LanguageTag; sourceWidth = $sourceWidth; sourceHeight = $sourceHeight;
    width = $bitmap.PixelWidth; height = $bitmap.PixelHeight; lineCount = $result.Lines.Count; elapsedMilliseconds = $timer.ElapsedMilliseconds } | ConvertTo-Json -Depth 4 -Compress
} catch {
  if ($Mode -eq 'capability') { @{ available = $false; languages = @(); reason = $_.Exception.Message } | ConvertTo-Json -Depth 4 -Compress }
  else { @{ error = $_.Exception.Message } | ConvertTo-Json -Depth 4 -Compress }
} finally {
  if ($bitmap) { $bitmap.Dispose() }
  if ($stream) { $stream.Dispose() }
}

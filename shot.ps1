param(
  [Parameter(Mandatory = $true)][string]$Svg,
  [Parameter(Mandatory = $true)][string]$Out,
  [int]$Width = 1932,
  [int]$Height = 1319
)
# Rasterise an SVG with headless Chrome so generated boards can actually be looked at.
$chrome = "C:\Program Files\Google\Chrome\Application\chrome.exe"
if (-not (Test-Path $chrome)) { $chrome = "C:\Program Files (x86)\Microsoft\Edge\Application\msedge.exe" }

$svgFull = (Resolve-Path $Svg).Path
$outFull = [System.IO.Path]::GetFullPath($Out)
$tmpDir = Join-Path $env:TEMP ("mapforge-shot-" + [guid]::NewGuid().ToString('N').Substring(0, 8))
New-Item -ItemType Directory -Force -Path $tmpDir | Out-Null

# Wrap the SVG in a page so it scales to the exact viewport with no margin.
$html = @"
<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;padding:0;background:#000;overflow:hidden}
img{display:block;width:${Width}px;height:${Height}px}</style>
<img src="board.svg">
"@
$htmlPath = Join-Path $tmpDir 'page.html'
Set-Content -Path $htmlPath -Value $html -Encoding utf8
Copy-Item $svgFull (Join-Path $tmpDir 'board.svg')

$args = @(
  '--headless=new', '--disable-gpu', '--hide-scrollbars', '--no-sandbox',
  '--allow-file-access-from-files',
  "--window-size=$Width,$Height",
  "--screenshot=$outFull",
  ('--user-data-dir=' + (Join-Path $tmpDir 'profile')),
  ('file:///' + ($htmlPath -replace '\\', '/'))
)
& $chrome @args 2>$null | Out-Null
Start-Sleep -Milliseconds 200
Remove-Item -Recurse -Force $tmpDir -ErrorAction SilentlyContinue
if (Test-Path $outFull) { "wrote $outFull ({0:N0} bytes)" -f (Get-Item $outFull).Length }
else { "FAILED - no screenshot produced" }

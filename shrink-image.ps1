# 从 stdin 读一张图片的 base64,缩到最长边 $Max 像素、压成 JPEG,把结果 base64 打到 stdout。
# 桥(server.mjs)用 child_process.execFile 调它。只做缩图,不碰任何文件。
param([int]$Max = 1280, [int]$Quality = 80)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing

$b64 = [Console]::In.ReadToEnd()
if (-not $b64) { [Console]::Error.Write('empty input'); exit 2 }
$b64 = ($b64 -replace '\s', '')
$bytes = [Convert]::FromBase64String($b64)
$in = New-Object System.IO.MemoryStream -ArgumentList (,$bytes)
$img = [System.Drawing.Image]::FromStream($in)

$scale = [Math]::Min(1.0, [Math]::Min($Max / $img.Width, $Max / $img.Height))
$w = [int][Math]::Max(1, [Math]::Round($img.Width * $scale))
$h = [int][Math]::Max(1, [Math]::Round($img.Height * $scale))

$bmp = New-Object System.Drawing.Bitmap -ArgumentList $w, $h
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.InterpolationMode = [System.Drawing.Drawing2D.InterpolationMode]::HighQualityBicubic
$g.PixelOffsetMode = [System.Drawing.Drawing2D.PixelOffsetMode]::HighQuality
$g.DrawImage($img, 0, 0, $w, $h)
$g.Dispose()

$out = New-Object System.IO.MemoryStream
$codec = [System.Drawing.Imaging.ImageCodecInfo]::GetImageEncoders() | Where-Object { $_.MimeType -eq 'image/jpeg' }
$ep = New-Object System.Drawing.Imaging.EncoderParameters -ArgumentList 1
$ep.Param[0] = New-Object System.Drawing.Imaging.EncoderParameter -ArgumentList ([System.Drawing.Imaging.Encoder]::Quality), ([long]$Quality)
$bmp.Save($out, $codec, $ep)
$bmp.Dispose(); $img.Dispose()

[Console]::Out.Write([Convert]::ToBase64String($out.ToArray()))

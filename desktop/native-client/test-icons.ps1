param([string]$Executable, [string]$Output)
$ErrorActionPreference = 'Stop'
Add-Type -AssemblyName System.Drawing
Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class IconResources {
  [DllImport("kernel32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr LoadLibraryEx(string path, IntPtr file, uint flags);
  [DllImport("kernel32.dll")] public static extern bool FreeLibrary(IntPtr module);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] public static extern IntPtr LoadImage(IntPtr module, IntPtr name, uint type, int width, int height, uint flags);
  [DllImport("user32.dll")] public static extern bool DestroyIcon(IntPtr icon);
}
'@
[System.IO.Directory]::CreateDirectory($Output) | Out-Null
$module = [IconResources]::LoadLibraryEx($Executable, [IntPtr]::Zero, 2)
if ($module -eq [IntPtr]::Zero) { throw 'Cannot load executable resources' }
$sheet = New-Object System.Drawing.Bitmap 820,220
$graphics = [System.Drawing.Graphics]::FromImage($sheet)
$graphics.Clear([System.Drawing.Color]::FromArgb(246,247,245))
$dark = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(27,31,29))
$graphics.FillRectangle($dark,0,110,820,110)
$font = New-Object System.Drawing.Font 'Segoe UI',10
$reports = @()
try {
  $sizes = @(16,20,24,32,40,48,64,96)
  for ($index=0; $index -lt $sizes.Count; $index++) {
    $size = $sizes[$index]
    $handle = [IconResources]::LoadImage($module,[IntPtr]101,1,$size,$size,0)
    if ($handle -eq [IntPtr]::Zero) { throw "Cannot load $size pixel icon" }
    $icon = [System.Drawing.Icon]::FromHandle($handle)
    $bitmap = $icon.ToBitmap()
    try {
      if ($bitmap.Width -ne $size -or $bitmap.Height -ne $size) { throw 'Wrong icon dimensions' }
      $fractional = 0
      for ($y=0; $y -lt $size; $y++) { for ($x=0; $x -lt $size; $x++) {
        $alpha = $bitmap.GetPixel($x,$y).A
        if ($alpha -gt 0 -and $alpha -lt 255) { $fractional++ }
      } }
      if ($fractional -eq 0 -or $bitmap.GetPixel(0,0).A -ne 0) { throw 'Icon lacks a smooth transparent edge' }
      $left = 12+$index*102
      $graphics.DrawIconUnstretched($icon,[System.Drawing.Rectangle]::new($left,12,$size,$size))
      $graphics.DrawIconUnstretched($icon,[System.Drawing.Rectangle]::new($left,118,$size,$size))
      $graphics.DrawString("${size}px",$font,[System.Drawing.Brushes]::Black,$left,90)
      $graphics.DrawString("${size}px",$font,[System.Drawing.Brushes]::White,$left,200)
      $bitmap.Save((Join-Path $Output "icon-$size.png"),[System.Drawing.Imaging.ImageFormat]::Png)
      $reports += @{size=$size;fractionalAlphaPixels=$fractional;fromExecutable=$true}
    } finally { $bitmap.Dispose();$icon.Dispose();[IconResources]::DestroyIcon($handle) | Out-Null }
  }
  $sheet.Save((Join-Path $Output 'icon-sizes.png'),[System.Drawing.Imaging.ImageFormat]::Png)
  $reports | ConvertTo-Json | Set-Content -Encoding UTF8 (Join-Path $Output 'icon-resources.json')
  $reports | ConvertTo-Json -Compress
} finally {
  $graphics.Dispose();$sheet.Dispose();$dark.Dispose();$font.Dispose();[IconResources]::FreeLibrary($module) | Out-Null
}

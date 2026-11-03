# 生成应用图标 build/icon.png（1024×1024）：黑色圆角底 + 白色打开的书 + 一条主题蓝书签带
Add-Type -AssemblyName System.Drawing
$size = 1024
$bmp = New-Object System.Drawing.Bitmap $size, $size
$g = [System.Drawing.Graphics]::FromImage($bmp)
$g.SmoothingMode = 'AntiAlias'
$g.Clear([System.Drawing.Color]::Transparent)

function P([float]$x, [float]$y) { New-Object System.Drawing.PointF $x, $y }

# 黑色圆角底
$pad = 64; $r = 220; $w = $size - 2 * $pad
$bg = New-Object System.Drawing.Drawing2D.GraphicsPath
$bg.AddArc($pad, $pad, $r, $r, 180, 90)
$bg.AddArc($pad + $w - $r, $pad, $r, $r, 270, 90)
$bg.AddArc($pad + $w - $r, $pad + $w - $r, $r, $r, 0, 90)
$bg.AddArc($pad, $pad + $w - $r, $r, $r, 90, 90)
$bg.CloseFigure()
$g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(0, 0, 0))), $bg)

# 一页书：spine 为书脊一侧的 x，edge 为外侧 x（左页 edge < spine，右页反之）
function Page([float]$spine, [float]$edge) {
  $p = New-Object System.Drawing.Drawing2D.GraphicsPath
  $d = $edge - $spine
  $p.AddBezier((P $spine 392), (P ($spine + $d * 0.30) 340), (P ($spine + $d * 0.70) 330), (P $edge 350))
  $p.AddLine((P $edge 350), (P $edge 700))
  $p.AddBezier((P $edge 700), (P ($spine + $d * 0.70) 680), (P ($spine + $d * 0.30) 690), (P $spine 742))
  $p.CloseFigure()
  return $p
}
$white = New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::White)
$g.FillPath($white, (Page 496 214))
$g.FillPath($white, (Page 528 810))

# 书页上的几行浅灰“文字”
$ink = New-Object System.Drawing.Pen ([System.Drawing.Color]::FromArgb(200, 200, 205)), 14
$ink.StartCap = 'Round'; $ink.EndCap = 'Round'
foreach ($i in 0..3) {
  $y = 440 + $i * 62
  $g.DrawBezier($ink, (P 280 ($y - 18)), (P 340 ($y - 26)), (P 400 ($y - 22)), (P 440 ($y - 4)))
}
foreach ($i in 0..3) {
  $y = 440 + $i * 62
  if ($i -lt 1) { continue }
  $g.DrawBezier($ink, (P 584 ($y - 4)), (P 624 ($y - 22)), (P 684 ($y - 26)), (P 744 ($y - 18)))
}

# 主题蓝书签带（从右页上沿垂下）
$rib = New-Object System.Drawing.Drawing2D.GraphicsPath
$rib.AddPolygon([System.Drawing.PointF[]]@((P 640 330), (P 712 334), (P 712 470), (P 676 440), (P 640 470)))
$g.FillPath((New-Object System.Drawing.SolidBrush ([System.Drawing.Color]::FromArgb(0, 113, 227))), $rib)

$out = Join-Path $PSScriptRoot '..\build'
New-Item -ItemType Directory -Force $out | Out-Null
$bmp.Save((Join-Path $out 'icon.png'), [System.Drawing.Imaging.ImageFormat]::Png)
$g.Dispose(); $bmp.Dispose()
"icon saved"

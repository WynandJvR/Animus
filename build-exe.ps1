# Rebuilds Animus.exe from animus.cs using the .NET Framework compiler that
# ships with Windows (no SDK/download needed). Run after editing animus.cs.
$ErrorActionPreference = 'Stop'
$csc = Get-ChildItem 'C:\Windows\Microsoft.NET\Framework64\v*\csc.exe' |
       Sort-Object FullName -Descending | Select-Object -First 1
if (-not $csc) { Write-Host 'No csc.exe found (.NET Framework missing).' -ForegroundColor Red; exit 1 }

# Close any running instance so the compiler can overwrite the exe.
Get-Process Animus -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 300

# App icon: tools/make-icon.cs renders animus.ico (same mark as the panel's top rail).
$ico = "$PSScriptRoot\animus.ico"
$icoSrc = "$PSScriptRoot\tools\make-icon.cs"
if ((Test-Path $icoSrc) -and (-not (Test-Path $ico) -or (Get-Item $icoSrc).LastWriteTime -gt (Get-Item $ico).LastWriteTime)) {
  $mk = "$env:TEMP\animus-make-icon.exe"
  & $csc.FullName /nologo /reference:System.Drawing.dll /out:$mk $icoSrc
  if ($LASTEXITCODE -eq 0) { & $mk $ico }
}
# /win32icon = the exe's shell icon; /resource = the same file for the window's crisp small icon
$iconArg = @(); if (Test-Path $ico) { $iconArg = @("/win32icon:$ico", "/resource:$ico,animus.ico") }

& $csc.FullName /nologo /target:winexe /platform:anycpu @iconArg `
  /reference:System.Windows.Forms.dll /reference:System.Drawing.dll `
  /reference:System.Web.Extensions.dll /reference:System.Management.dll `
  /out:"$PSScriptRoot\Animus.exe" "$PSScriptRoot\animus.cs"
if ($LASTEXITCODE -eq 0) { Write-Host 'Built Animus.exe' -ForegroundColor Green }
else { Write-Host "Build FAILED (csc exit $LASTEXITCODE)" -ForegroundColor Red; exit 1 }

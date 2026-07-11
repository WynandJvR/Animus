# Rebuilds Animus.exe from animus.cs using the .NET Framework compiler that
# ships with Windows (no SDK/download needed). Run after editing animus.cs.
$ErrorActionPreference = 'Stop'
$csc = Get-ChildItem 'C:\Windows\Microsoft.NET\Framework64\v*\csc.exe' |
       Sort-Object FullName -Descending | Select-Object -First 1
if (-not $csc) { Write-Host 'No csc.exe found (.NET Framework missing).' -ForegroundColor Red; exit 1 }

# Close any running instance so the compiler can overwrite the exe.
Get-Process Animus -ErrorAction SilentlyContinue | Stop-Process -Force
Start-Sleep -Milliseconds 300

& $csc.FullName /nologo /target:winexe /platform:anycpu `
  /reference:System.Windows.Forms.dll /reference:System.Drawing.dll `
  /reference:System.Web.Extensions.dll `
  /out:"$PSScriptRoot\Animus.exe" "$PSScriptRoot\animus.cs"
if ($LASTEXITCODE -eq 0) { Write-Host 'Built Animus.exe' -ForegroundColor Green }
else { Write-Host "Build FAILED (csc exit $LASTEXITCODE)" -ForegroundColor Red; exit 1 }

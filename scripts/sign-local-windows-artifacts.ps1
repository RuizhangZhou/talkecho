[CmdletBinding()]
param(
  [string[]]$Path,
  [string]$CertificateSubject = "CN=TalkEcho Local Test Signing"
)

$ErrorActionPreference = "Stop"
Set-StrictMode -Version Latest

$root = Split-Path -Parent $PSScriptRoot

function Get-SignToolPath {
  $windowsKitRoot = "${env:ProgramFiles(x86)}\Windows Kits\10\bin"
  if (-not (Test-Path -LiteralPath $windowsKitRoot)) {
    throw "Windows SDK signing tools were not found at $windowsKitRoot."
  }

  $signTool = Get-ChildItem -LiteralPath $windowsKitRoot -Recurse -Filter "signtool.exe" -File |
    Where-Object { $_.DirectoryName -match "\\x64$" } |
    Sort-Object FullName -Descending |
    Select-Object -First 1

  if (-not $signTool) {
    throw "signtool.exe was not found. Install the Windows SDK signing tools first."
  }

  return $signTool.FullName
}

if (-not $Path -or $Path.Count -eq 0) {
  $version = (Get-Content -LiteralPath (Join-Path $root "package.json") -Raw | ConvertFrom-Json).version
  $Path = @(
    (Join-Path $root "src-tauri\target\release\bundle\msi\TalkEcho_${version}_x64_en-US.msi"),
    (Join-Path $root "src-tauri\target\release\bundle\nsis\TalkEcho_${version}_x64-setup.exe")
  )
}

$certificate = Get-ChildItem Cert:\CurrentUser\My -CodeSigningCert |
  Where-Object { $_.Subject -eq $CertificateSubject -and $_.HasPrivateKey -and $_.NotAfter -gt (Get-Date) } |
  Select-Object -First 1

if (-not $certificate) {
  throw "No valid local code-signing certificate was found for '$CertificateSubject'."
}

$signTool = Get-SignToolPath
foreach ($artifact in $Path) {
  if (-not (Test-Path -LiteralPath $artifact -PathType Leaf)) {
    throw "Release artifact not found: $artifact"
  }

  Write-Host "Signing $artifact"
  & $signTool sign /fd SHA256 /sha1 $certificate.Thumbprint $artifact
  if ($LASTEXITCODE -ne 0) {
    throw "Signing failed for $artifact (exit code $LASTEXITCODE)."
  }

  & $signTool verify /pa /v $artifact
  if ($LASTEXITCODE -ne 0) {
    throw "Signature verification failed for $artifact (exit code $LASTEXITCODE)."
  }
}

Write-Host "Signed and verified $($Path.Count) local TalkEcho test artifact(s)."

param(
  [Parameter(Mandatory = $true)][string]$ExecutablePath,
  [int]$IdleSeconds = 35
)

# Run against a release executable with no other TalkEcho instance running.
# Tests native wake-up and frontend readiness without submitting audio to STT:
# the test-owned process is terminated while still recording, before any stop.
$ErrorActionPreference = 'Stop'
if (Get-Process talkecho -ErrorAction SilentlyContinue) {
  throw 'Exit TalkEcho before this smoke test to avoid competing keyboard hooks.'
}
$resolvedExecutable = (Resolve-Path -LiteralPath $ExecutablePath).Path
$logPath = Join-Path $env:LOCALAPPDATA 'com.talkecho.desktop\logs\dictation.log'

Add-Type @'
using System;
using System.Text;
using System.Runtime.InteropServices;
public static class DictationSmoke {
  public delegate bool EnumProc(IntPtr hwnd, IntPtr param);
  [StructLayout(LayoutKind.Sequential)] public struct Rect { public int Left, Top, Right, Bottom; }
  [DllImport("user32.dll")] static extern bool EnumWindows(EnumProc callback, IntPtr param);
  [DllImport("user32.dll")] static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern int GetWindowText(IntPtr hwnd, StringBuilder text, int count);
  [DllImport("user32.dll")] static extern bool IsWindowVisible(IntPtr hwnd);
  [DllImport("user32.dll")] static extern bool GetWindowRect(IntPtr hwnd, out Rect rect);
  [DllImport("user32.dll")] static extern IntPtr MonitorFromRect(ref Rect rect, uint flags);
  [DllImport("user32.dll")] static extern bool ShowWindow(IntPtr hwnd, int cmd);
  [DllImport("user32.dll")] public static extern void keybd_event(byte key, byte scan, uint flags, UIntPtr extra);
  public static bool Visible(int processId) {
    bool visible = false;
    EnumWindows((hwnd, unused) => {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (pid != processId) return true;
      var title = new StringBuilder(256); GetWindowText(hwnd, title, title.Capacity);
      Rect rect; GetWindowRect(hwnd, out rect);
      if (title.ToString() == "TalkEcho Dictation")
        visible = IsWindowVisible(hwnd) && MonitorFromRect(ref rect, 0) != IntPtr.Zero;
      return true;
    }, IntPtr.Zero);
    return visible;
  }
  public static void HideWindows(int processId) {
    EnumWindows((hwnd, unused) => {
      uint pid; GetWindowThreadProcessId(hwnd, out pid);
      if (pid == processId) ShowWindow(hwnd, 0);
      return true;
    }, IntPtr.Zero);
  }
}
'@

function Read-TestLog {
  if (Test-Path -LiteralPath $logPath) {
    return @(Get-Content -LiteralPath $logPath | Where-Object { $_ -match "pid=$($testApp.Id) " }) -join "`n"
  }
  return ''
}

function Wait-For([scriptblock]$Condition, [string]$Description) {
  $deadline = (Get-Date).AddSeconds(30)
  while ((Get-Date) -lt $deadline) {
    if ($testApp.HasExited) { throw "TalkEcho exited during $Description" }
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 100
  }
  throw "Timed out: $Description"
}

$testApp = Start-Process -FilePath $resolvedExecutable -WindowStyle Hidden -PassThru
try {
  Wait-For { (Read-TestLog) -match 'keyboard hook installed=True|keyboard hook installed=true' } 'hook installation'
  if ($IdleSeconds -gt 0) {
    Wait-For { (Read-TestLog) -match 'synchronized active=false sequence=0' } 'frontend ready'
    if ([DictationSmoke]::Visible($testApp.Id)) { throw 'Idle dictation window must be hidden' }
    [DictationSmoke]::HideWindows($testApp.Id)
    Start-Sleep -Seconds $IdleSeconds
    if ($IdleSeconds -ge 31 -and (Read-TestLog) -notmatch 'keyboard hook renewed') {
      throw 'Recovery timer did not renew the hook'
    }
  }
  [DictationSmoke]::keybd_event(0xA2, 0x1D, 0, [UIntPtr]::Zero)
  [DictationSmoke]::keybd_event(0xA2, 0x1D, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 100
  if ((Read-TestLog) -match 'toggle ->') { throw 'Left Ctrl incorrectly activated dictation' }

  [DictationSmoke]::keybd_event(0xA3, 0x1D, 1, [UIntPtr]::Zero)
  Wait-For { [DictationSmoke]::Visible($testApp.Id) } 'native popup'
  Wait-For { (Read-TestLog) -match "status set to 'recording'" } 'frontend recording'
  1..10 | ForEach-Object { [DictationSmoke]::keybd_event(0xA3, 0x1D, 1, [UIntPtr]::Zero) }
  [DictationSmoke]::keybd_event(0xA3, 0x1D, 3, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 300
  $testLog = Read-TestLog
  if ([regex]::Matches($testLog, 'toggle ->').Count -ne 1) { throw 'Held key toggled more than once' }
  if (-not [DictationSmoke]::Visible($testApp.Id)) { throw 'Popup disappeared during recording' }
  Write-Output "PASS: release popup, recording, Left Ctrl exclusion, repeat suppression; idle=$IdleSeconds seconds."
} finally {
  [DictationSmoke]::keybd_event(0xA3, 0x1D, 3, [UIntPtr]::Zero)
  if (-not $testApp.HasExited) { Stop-Process -Id $testApp.Id }
}

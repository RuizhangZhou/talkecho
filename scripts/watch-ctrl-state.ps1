param(
  [ValidateRange(1, 3600)][int]$DurationSeconds = 120,
  [ValidateRange(20, 2000)][int]$IntervalMilliseconds = 100
)

# Read-only: no hooks, input injection, clipboard access, or focus changes.
# Run independently on the LOCAL and REMOTE computers and compare timestamps.
# These are Windows-reported states, NOT proof of the physical key's position.
$ErrorActionPreference = 'Stop'
if (-not ('TalkEchoCtrlObserver' -as [type])) {
  Add-Type @'
using System;
using System.Runtime.InteropServices;
public static class TalkEchoCtrlObserver {
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll")] public static extern IntPtr GetForegroundWindow();
  [DllImport("user32.dll")] public static extern uint GetWindowThreadProcessId(IntPtr hwnd, out uint pid);
}
'@
}

Write-Host 'Read-only Ctrl observer. No typed text/window titles collected. Ctrl+C stops.'
Write-Host 'Zero/up is inconclusive on inaccessible/secure desktops; short taps between polls may be missed.'
Write-Output 'timestamp_utc,left_ctrl_reported_down,right_ctrl_reported_down,foreground_hwnd,foreground_pid'
$deadline = [DateTime]::UtcNow.AddSeconds($DurationSeconds)
$lastSnapshot = ''
while ([DateTime]::UtcNow -lt $deadline) {
  $leftDown = [TalkEchoCtrlObserver]::GetAsyncKeyState(0xA2) -lt 0
  $rightDown = [TalkEchoCtrlObserver]::GetAsyncKeyState(0xA3) -lt 0
  $foreground = [TalkEchoCtrlObserver]::GetForegroundWindow()
  [uint32]$foregroundProcessId = 0
  [void][TalkEchoCtrlObserver]::GetWindowThreadProcessId($foreground, [ref]$foregroundProcessId)
  $snapshot = "$leftDown,$rightDown,$foreground,$foregroundProcessId"
  if ($snapshot -ne $lastSnapshot) {
    Write-Output "$([DateTime]::UtcNow.ToString('o')),$snapshot"
    $lastSnapshot = $snapshot
  }
  Start-Sleep -Milliseconds $IntervalMilliseconds
}

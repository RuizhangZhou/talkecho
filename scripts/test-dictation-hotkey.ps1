param(
  [Parameter(Mandatory = $true)][string]$ExecutablePath,
  [ValidateRange(0, 55)][int]$IdleSeconds = 35,
  [switch]$HoldAcrossRenewal,
  [switch]$HookOnly,
  [switch]$RecoverRemovedHook,
  [switch]$MissedRelease
)

# Run against a release executable with no other TalkEcho instance running.
# Tests native wake-up and frontend readiness without submitting audio to STT:
# the test-owned process is terminated while still recording, before any stop.
$ErrorActionPreference = 'Stop'
if ($MissedRelease -and -not $RecoverRemovedHook) { throw '-MissedRelease requires -RecoverRemovedHook' }
if ($RecoverRemovedHook) { $HookOnly = $true }
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
  [DllImport("user32.dll")] public static extern short GetAsyncKeyState(int key);
  [DllImport("user32.dll", SetLastError=true)] public static extern bool PostThreadMessage(uint thread, uint msg, UIntPtr wparam, IntPtr lparam);
  [StructLayout(LayoutKind.Sequential)] struct LastInput { public uint Size, Time; }
  [DllImport("user32.dll")] static extern bool GetLastInputInfo(ref LastInput input);
  [DllImport("kernel32.dll")] static extern uint GetTickCount();
  [DllImport("user32.dll", SetLastError=true)] static extern IntPtr OpenInputDesktop(uint flags, bool inherit, uint access);
  [DllImport("user32.dll", CharSet=CharSet.Unicode)] static extern bool GetUserObjectInformation(IntPtr obj, int index, StringBuilder text, uint size, out uint needed);
  [DllImport("user32.dll")] static extern bool CloseDesktop(IntPtr desktop);
  public static bool DesktopReady() {
    var input = new LastInput { Size=(uint)Marshal.SizeOf(typeof(LastInput)) };
    if (!GetLastInputInfo(ref input) || unchecked(GetTickCount()-input.Time) > 300000) return false;
    var desktop=OpenInputDesktop(0,false,1);
    if (desktop==IntPtr.Zero) return false;
    try { var text=new StringBuilder(256); uint needed;
      return GetUserObjectInformation(desktop,2,text,512,out needed) && text.ToString()=="Default";
    } finally { CloseDesktop(desktop); }
  }
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

$lastDesktopCheck = [DateTime]::UtcNow
function Assert-DesktopReady {
  $now = [DateTime]::UtcNow
  $gap = ($now - $script:lastDesktopCheck).TotalSeconds
  $script:lastDesktopCheck = $now
  if ($gap -gt 70) { throw 'Test execution was interrupted for over 70 seconds; rerun instead of resuming key injection.' }
  if (-not [DictationSmoke]::DesktopReady()) {
    throw 'Desktop is locked/inaccessible or has no recent input. Wake/unlock and interact with this computer, then rerun during a quiet interval.'
  }
}

function Wait-For([scriptblock]$Condition, [string]$Description, [int]$TimeoutSeconds = 30) {
  $deadline = (Get-Date).AddSeconds($TimeoutSeconds)
  while ((Get-Date) -lt $deadline) {
    Assert-DesktopReady
    if ($testApp.HasExited) { throw "TalkEcho exited during $Description" }
    if (& $Condition) { return }
    Start-Sleep -Milliseconds 100
  }
  throw "Timed out: $Description"
}

Assert-DesktopReady
if ([DictationSmoke]::GetAsyncKeyState(0xA2) -lt 0 -or [DictationSmoke]::GetAsyncKeyState(0xA3) -lt 0) {
  throw 'Release both Ctrl keys before running this test. Do not type during the test.'
}
# Only the child process opts in to our tagged test input. Untagged injected
# events must pass through without toggling or changing physical press ownership.
$previousTestInput = $env:TALKECHO_HOTKEY_TEST_INPUT
$previousNoUI = $env:TALKECHO_HOTKEY_TEST_NO_UI
try {
  $env:TALKECHO_HOTKEY_TEST_INPUT = '1'
  $env:TALKECHO_HOTKEY_TEST_NO_UI = if ($HookOnly) { '1' } else { '0' }
  $testApp = Start-Process -FilePath $resolvedExecutable -WindowStyle Hidden -PassThru
} finally {
  $env:TALKECHO_HOTKEY_TEST_INPUT = $previousTestInput
  $env:TALKECHO_HOTKEY_TEST_NO_UI = $previousNoUI
}
$testMarker = [UIntPtr]::new(0x54453730)
$testKeyHeld = $false
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
  Assert-DesktopReady
  [DictationSmoke]::keybd_event(0xA2, 0x1D, 0, [UIntPtr]::Zero)
  [DictationSmoke]::keybd_event(0xA2, 0x1D, 2, [UIntPtr]::Zero)
  Start-Sleep -Milliseconds 100
  if ((Read-TestLog) -match 'toggle ->|test-only toggle accepted') { throw 'Left Ctrl incorrectly activated dictation' }

  [DictationSmoke]::keybd_event(0xA3, 0x1D, 1, [UIntPtr]::Zero)
  [DictationSmoke]::keybd_event(0xA3, 0x1D, 3, [UIntPtr]::Zero)
  Wait-For { [regex]::Matches((Read-TestLog), 'source=Injected .*route=Forward').Count -ge 2 } 'injected Ctrl bypass'
  if ((Read-TestLog) -match 'toggle ->|test-only toggle accepted') { throw 'Untagged injected Ctrl incorrectly activated dictation' }

  [DictationSmoke]::keybd_event(0xA3, 0x1D, 1, $testMarker)
  $testKeyHeld = $true
  if ($HookOnly) {
    Wait-For { (Read-TestLog) -match 'test-only toggle accepted' } 'hook-only dispatch'
  } else {
    Wait-For { [DictationSmoke]::Visible($testApp.Id) } 'native popup'
    Wait-For { (Read-TestLog) -match "status set to 'recording'" } 'frontend recording'
  }
  if ($RecoverRemovedHook) {
    $threadMatch = [regex]::Match((Read-TestLog), 'keyboard hook thread_id=(\d+)')
    if (-not $threadMatch.Success) { throw 'No hook thread ID logged' }
    if (-not [DictationSmoke]::PostThreadMessage([uint32]$threadMatch.Groups[1].Value, 0x8047, [UIntPtr]::Zero, [IntPtr]::Zero)) {
      throw 'Could not request test-owned hook removal'
    }
    Wait-For { (Read-TestLog) -match 'test-only owner hook removed' } 'owner removal'
    if ($MissedRelease) {
      Assert-DesktopReady
      if ((Read-TestLog) -match 'keyboard hook guard installed') { throw 'Guard already installed; cannot simulate a missed release in this run' }
      [DictationSmoke]::keybd_event(0xA3, 0x1D, 3, $testMarker)
      $testKeyHeld = $false
    }
  }
  if ($HoldAcrossRenewal -or $RecoverRemovedHook) {
    Wait-For { (Read-TestLog) -match 'keyboard hook guard installed' } 'release guard installation' 45
  }
  Assert-DesktopReady
  if ($MissedRelease) {
    # The stale state cannot safely distinguish this new down from a repeat.
    # A genuinely observed up must recover it; the following full press toggles.
    [DictationSmoke]::keybd_event(0xA3, 0x1D, 1, $testMarker)
    $testKeyHeld = $true
  }
  1..10 | ForEach-Object { [DictationSmoke]::keybd_event(0xA3, 0x1D, 1, $testMarker) }
  [DictationSmoke]::keybd_event(0xA3, 0x1D, 3, $testMarker)
  $testKeyHeld = $false
  $expectedToggles = 1
  if ($RecoverRemovedHook) {
    Wait-For { (Read-TestLog) -match 'role=guard recovered_release=true .*source=Test .*test=Consumed->Idle' } 'genuine release recovery'
    Assert-DesktopReady
    [DictationSmoke]::keybd_event(0xA3, 0x1D, 1, $testMarker)
    $testKeyHeld = $true
    [DictationSmoke]::keybd_event(0xA3, 0x1D, 3, $testMarker)
    $testKeyHeld = $false
    $expectedToggles = 2
    Wait-For { [regex]::Matches((Read-TestLog), 'test-only toggle accepted').Count -eq 2 } 'next complete press after recovery'
  }
  Start-Sleep -Milliseconds 300
  $testLog = Read-TestLog
  $togglePattern = if ($HookOnly) { 'test-only toggle accepted' } else { 'toggle ->' }
  if ([regex]::Matches($testLog, $togglePattern).Count -ne $expectedToggles) { throw 'Unexpected toggle count' }
  if ($HookOnly -and $testLog -match "status set to 'recording'|toggle ->") { throw 'Hook-only test dispatched audio/UI unexpectedly' }
  if ($testLog -notmatch 'source=Test edge=Up route=Consume .*test=Consumed->Idle') { throw 'Test release was not paired with its consumed down' }
  if (-not $HookOnly -and -not [DictationSmoke]::Visible($testApp.Id)) { throw 'Popup disappeared during recording' }
  Write-Output "PASS: Ctrl routing and repeats; idle=$IdleSeconds; guard=$HoldAcrossRenewal; hook-only=$HookOnly; removed-owner=$RecoverRemovedHook; missed-release=$MissedRelease; pid=$($testApp.Id)."
} finally {
  # Release only an unmatched down injected by THIS test, not an unconditional
  # global Ctrl-up as a proposed repair for a user's real keyboard state.
  if ($testKeyHeld -and -not $testApp.HasExited -and [DictationSmoke]::DesktopReady() -and
      ([DateTime]::UtcNow - $lastDesktopCheck).TotalSeconds -lt 70) {
    [DictationSmoke]::keybd_event(0xA3, 0x1D, 3, $testMarker)
  }
  if (-not $testApp.HasExited) { Stop-Process -Id $testApp.Id }
}

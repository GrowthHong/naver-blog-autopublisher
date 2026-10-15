# 윈도우 작업 스케줄러 등록 - 원고 생성(06:00), 통계(08:10), 색인 확인(09/13/18/22시), 받은 이웃 수락(10/20시), 순위(월 07:30)
# 사용: powershell -ExecutionPolicy Bypass -File scripts\schedule.ps1      해제: ... -Remove
param([switch]$Remove)
$App = Split-Path -Parent (Split-Path -Parent $MyInvocation.MyCommand.Path)
$Node = (Get-Command node).Source
$Data = if ($env:BAP_HOME) { $env:BAP_HOME } else { Join-Path $env:USERPROFILE ".blog-autopublisher" }
New-Item -ItemType Directory -Force -Path (Join-Path $Data "logs") | Out-Null
function Register($name, $script, $times, $weekly) {
  $task = "BlogAutopublisher-$name"
  Unregister-ScheduledTask -TaskName $task -Confirm:$false -ErrorAction SilentlyContinue
  if ($Remove) { Write-Host "해제: $task"; return }
  $triggers = @()
  foreach ($t in $times) {
    if ($weekly) { $triggers += New-ScheduledTaskTrigger -Weekly -DaysOfWeek Monday -At $t }
    else { $triggers += New-ScheduledTaskTrigger -Daily -At $t }
  }
  $log = Join-Path $Data ("logs\" + $name + ".log")
  $cmd = "/c cd /d `"$App`" && set BAP_HOME=$Data&& `"$Node`" $script >> `"$log`" 2>&1"
  $action = New-ScheduledTaskAction -Execute "cmd.exe" -Argument $cmd
  $settings = New-ScheduledTaskSettingsSet -StartWhenAvailable -ExecutionTimeLimit (New-TimeSpan -Hours 2) -MultipleInstances IgnoreNew
  Register-ScheduledTask -TaskName $task -Action $action -Trigger $triggers -Settings $settings -Description "네이버 블로그 자동발행기 $name" | Out-Null
  Write-Host "등록: $task ($($times -join ', '))"
}
Register "generate" "scripts\daily-generate.mjs" @("06:00") $false
Register "stats"    "scripts\stats-run.mjs"      @("08:10") $false
Register "index"    "scripts\index-check.mjs"    @("09:00","13:00","18:00","22:00") $false
Register "accept"   "scripts\accept-run.mjs"     @("10:00","20:00") $false
Register "rank"     "scripts\rank-check.mjs"     @("07:30") $true
Write-Host "완료. PC가 켜져 있어야 돌아갑니다(절전 중에는 안 돌고, 깨어나면 밀린 작업을 실행). 작업 스케줄러에서 BlogAutopublisher-* 로 확인할 수 있습니다."

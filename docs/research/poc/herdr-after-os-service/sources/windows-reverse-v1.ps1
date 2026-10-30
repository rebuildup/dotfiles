$ErrorActionPreference='Stop'
[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false)
$OutputEncoding=[Console]::OutputEncoding
$root='C:/Users/rebui/setup-audit/herdr-readonly-20261026/windows-agent-workspace'
if($env:HERDR_ENV -cne '1'){throw 'Real managed pane required'}
$marker=[IO.File]::Open("$root/reverse-after-service-v1.marker",'CreateNew','Write','None');$marker.Dispose()
$phase='snapshot'
try {
 $h='C:/Users/rebui/setup-audit/herdr-readonly-20261026/herdr-0.9.5-private/package/herdr.exe'
 $profile='c0f6ac3950c614ced3b168c9e5952183'
 $raw=& $h --machine $profile api snapshot
 if($LASTEXITCODE -ne 0){throw 'Snapshot failed'}
 $snapshot=($raw -join "`n")|ConvertFrom-Json
 if($snapshot.result.snapshot.version -cne '0.9.5'){throw 'Version mismatch'}
 $phase='agent-prompt'
 $nonce='MAC_W2M_62cb282430a448e7ab62eb95e5e211d1'
 $prompt=& $h --machine $profile agent prompt launchagent_check "Do not use tools or change files. Reply with exactly this one line: $nonce" --wait --timeout 60000
 if($LASTEXITCODE -ne 0){throw 'Prompt failed'}
 $promptResult=($prompt -join "`n")|ConvertFrom-Json
 $phase='agent-read'
 $lines=@(& $h --machine $profile agent read launchagent_check --source recent-unwrapped --lines 30)
 if($LASTEXITCODE -ne 0){throw 'Read failed'}
 $assistantExact=@($lines|Where-Object {$_.Trim() -ceq "• $nonce"}).Count -eq 1
 if(-not $assistantExact){throw 'Assistant nonce mismatch'}
 $result=[ordered]@{Status='pass';CallerHerdrEnv='1';CallerOS='Windows';TargetProfile=$profile;TargetVersion=$snapshot.result.snapshot.version;TargetAgent='launchagent_check';TargetPane=$promptResult.result.agent.pane_id;PromptState=$promptResult.result.agent.agent_status;AssistantNonce=$nonce;AssistantExact=$true;ToolUseRequested=$false;KeysOrCachesCopied=$false}
}catch{$result=[ordered]@{Status='failed';Phase=$phase;Reason='Herdr reverse verification failed; inspect private pane without resubmitting'} }
$data=[Text.UTF8Encoding]::new($false).GetBytes(($result|ConvertTo-Json -Depth 5));$f=[IO.File]::Open("$root/reverse-after-service-result-v1.json",'CreateNew','Write','None');try{$f.Write($data)}finally{$f.Dispose()}

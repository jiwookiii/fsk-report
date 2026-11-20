# Git으로 보안 보고서 게시
# 사용 예:
#   .\deploy.ps1 -EncFile "$HOME\Downloads\report.enc.json"   # admin.html에서 내려받은 파일로 교체 후 게시
#   .\deploy.ps1                                              # 작업 폴더 변경분(문구·화면 수정 등)·밀린 커밋 게시
#   .\deploy.ps1 -DryRun [-EncFile ...]                       # 점검만. 파일·브랜치·스테이징을 바꾸지 않음
#   -SiteUrl https://<소유자>.github.io/<저장소>/             # 사용자 지정 도메인 등 Pages 주소를 직접 지정
param(
  [string]$EncFile,
  [string]$Message,
  [string]$Branch = 'main',
  [string]$SiteUrl,
  [switch]$DryRun,
  [switch]$NoWait
)
# PowerShell 5.1은 EAP=Stop에서 git의 stderr 진행 메시지를 오류로 취급하므로 Continue로 두고 종료 코드로 판단
$ErrorActionPreference = 'Continue'
if ($EncFile) {  # 상대 경로는 실행한 위치 기준으로 먼저 확정
  $p = Resolve-Path -LiteralPath $EncFile -ErrorAction SilentlyContinue
  if (-not $p) { throw "파일 없음: $EncFile" }; $EncFile = $p.ProviderPath
}
Set-Location -LiteralPath $PSScriptRoot
function Run-Git { & git @args; if ($LASTEXITCODE -ne 0) { throw "git $($args -join ' ') 실패 (코드 $LASTEXITCODE)" } }
$node = (Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1).Source
if (-not $node) { throw 'Node.js가 없음 (게시 점검에 필요). https://nodejs.org 에서 설치' }
function Check { & $node tools/check-site.mjs @args; if ($LASTEXITCODE -ne 0) { throw '게시 점검 실패 — 위 목록을 고친 뒤 다시 실행' } }

if (-not (Test-Path .git)) { throw '이 폴더가 Git 저장소가 아님. README의 "최초 설정"부터 진행할 것' }
$remote = (& git remote get-url origin 2>$null)
if (-not $remote) { throw 'origin 원격 저장소가 없음: git remote add origin https://github.com/<소유자>/<저장소>.git' }
$pushUrls = @(& git remote get-url --push --all origin 2>$null)
if ($pushUrls.Count -ne 1 -or $pushUrls[0] -cne $remote) { throw "origin의 푸시 주소가 받기 주소와 다름($($pushUrls -join ', ')). 점검 범위가 어긋나므로 pushurl 설정을 지울 것: git config --unset-all remote.origin.pushurl" }
$cur = (& git symbolic-ref --quiet HEAD 2>$null)
if ($cur -cne "refs/heads/$Branch") { throw "현재 브랜치가 '$cur'(분리된 HEAD면 빈 값) — '$Branch'에서만 게시함. git switch $Branch" }
if (& git ls-files -u) { throw '충돌 해결이 안 된 파일이 있음. 먼저 정리할 것 (git status)' }

if ($DryRun) {
  Write-Host '[DryRun] 작업 폴더 점검 (원격 받기·파일 교체·스테이징 없음)'
  if ($EncFile) { Check --enc $EncFile } else { Check }
  & git status -sb; return
}
Run-Git config core.hooksPath .githooks

# 1) 원격 최신화 — admin.html의 "GitHub 바로 게시"가 원격에 직접 커밋하므로 먼저 받아야 충돌이 안 남
Write-Host "[1/5] 원격($remote) 최신 내용 받는 중…"
& git ls-remote --exit-code --heads origin $Branch | Out-Null
$lr = $LASTEXITCODE
if ($lr -eq 0) {
  # 원격 끝 커밋을 OID로 고정해 그 기준으로 rebase·점검 (refspec 설정과 무관)
  Run-Git fetch -q origin "+refs/heads/$($Branch):refs/remotes/origin/$Branch"
  $base = (& git rev-parse --verify -q "refs/remotes/origin/$Branch^{commit}")
  if (-not $base) { throw '원격 브랜치 위치를 확인하지 못함' }
  Run-Git rebase --autostash $base
  if (& git ls-files -u) { throw '받아온 내용과 로컬 수정이 충돌함(autostash 복원 충돌). git status로 정리한 뒤 다시 실행' }
} elseif ($lr -eq 2) { Write-Host '      원격 브랜치 없음(최초 게시)'; $base = $null }
else { throw "원격 조회 실패 (코드 $lr) — 네트워크·로그인 확인" }

# 2) 암호화 데이터 교체
if ($EncFile) {
  New-Item -ItemType Directory -Force data | Out-Null
  Copy-Item -LiteralPath $EncFile -Destination data/report.enc.json -Force -ErrorAction Stop
  Write-Host "[2/5] data/report.enc.json 교체: $EncFile"
} else { Write-Host '[2/5] 암호화 데이터 교체 없음' }

# 3) 점검 후 변경분 커밋 (원본·엑셀·CSV 차단, 암호화 형식 확인). 커밋 시 훅이 인덱스를 한 번 더 점검
Write-Host '[3/5] 게시 점검'
Check
Run-Git add -A
& git diff --cached --quiet
if ($LASTEXITCODE -ne 0) {
  & git diff --cached --stat
  if (-not $Message) { $Message = '보안 문서 갱신 ' + (Get-Date -Format 'yyyy-MM-dd HH:mm') }
  Run-Git commit -q -m $Message
} else { Write-Host '      새 변경 없음' }

# 4) 푸시할 커밋 전부 점검 후 푸시 (중간 커밋에 들어갔다 지워진 파일도 공개 이력에 남기 때문)
# 점검한 커밋과 푸시하는 커밋이 같도록 OID를 한 번만 읽어 고정. 원격이 그 사이 바뀌면 --force-with-lease 없이도 비-fast-forward로 거부됨
$tip = (& git rev-parse --verify -q 'HEAD^{commit}')
if (-not $tip) { throw '로컬 커밋 확인 실패' }
$range = if ($base) { "$base..$tip" } else { $tip }
$cnt = (& git rev-list --count $range); if ($LASTEXITCODE -ne 0) { throw "커밋 범위 계산 실패: $range" }
if ([int]$cnt -eq 0) { Write-Host '[4/5] 푸시할 커밋 없음 (원격과 같음) — 반영 상태만 확인' }
else {
  Write-Host "[4/5] 푸시할 커밋 $cnt개 점검·푸시"
  Check --commits $range
  Run-Git push origin "$($tip):refs/heads/$Branch"
  Write-Host ('      커밋 ' + $tip.Substring(0, 7))
}

# 5) 사이트 반영 확인: data iv(대소문자 구분)와 index.html·admin.html 내용이 HEAD와 같아질 때까지
if ($NoWait) { return }
if (-not $SiteUrl -and $remote -match 'github\.com[:/]([^/]+)/([^/]+?)(\.git)?/?$') {
  $o = $Matches[1]; $r = $Matches[2]
  $SiteUrl = if ($r -ieq "$o.github.io") { "https://$($o.ToLower()).github.io/" } else { "https://$($o.ToLower()).github.io/$r/" }
}
if (-not $SiteUrl) { Write-Host '[5/5] Pages 주소를 알 수 없어 반영 확인 생략 (-SiteUrl로 지정 가능)'; return }
if (-not $SiteUrl.EndsWith('/')) { $SiteUrl += '/' }
# 게시본을 바이트 그대로 받아 Git 객체 해시로 비교 (한글 인코딩·대소문자 문제 없음)
$files = 'data/report.enc.json', 'index.html', 'admin.html'
$want = @{}; foreach ($f in $files) { $want[$f] = (& git rev-parse "$($tip):$f") }
$tmp = Join-Path ([IO.Path]::GetTempPath()) ('deploy-check-' + [guid]::NewGuid().ToString('N'))
Write-Host "[5/5] 사이트 반영 확인: $SiteUrl"
$wc = New-Object Net.WebClient
try {
  for ($i = 0; $i -lt 18; $i++) {
    Start-Sleep -Seconds ($(if ($i) { 10 } else { 5 }))
    $ok = $true; $t = [DateTimeOffset]::Now.ToUnixTimeMilliseconds()
    foreach ($f in $files) {
      if (-not $ok) { break }
      try { $wc.DownloadFile("$SiteUrl$($f)?t=$t", $tmp); $ok = ((& git hash-object "--path=$f" $tmp) -ceq $want[$f]) } catch { $ok = $false }
    }
    if ($ok) { Write-Host "      반영 확인됨 ($($i*10)초). 로그인 화면에서 실제 계정으로 열어 볼 것"; return }
    Write-Host "      대기 중… ($($i*10)초)"
  }
} finally { Remove-Item -LiteralPath $tmp -ErrorAction SilentlyContinue }
Write-Host '      3분 내 반영 확인 못 함. 저장소 Actions 탭의 pages-build-deployment 상태를 확인할 것'
exit 1

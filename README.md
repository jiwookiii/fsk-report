# 보안 보고서 게시 사이트 (GitHub Pages · Git 배포)

비밀번호로 암호화한 경영실적 보고서를 GitHub Pages에 올리고, 계정이 있는 사람만 열게 하는 저장소.
**이 폴더 전체가 공개 저장소**가 됨. 원본 보고서·엑셀·계정목록은 `../build/`(비공개)에만 둠.

| 파일 | 역할 |
|---|---|
| `index.html` | 로그인 화면. `data/report.enc.json`을 받아 아이디·비밀번호로 복호화해 표시 |
| `admin.html` | 계정 발급 도구. 원본 HTML 암호화 → 계정별 검증 → `report.enc.json` 생성(+선택: GitHub API로 바로 게시) |
| `data/report.enc.json` | 암호화 데이터(본문 + 계정별 잠금). 매월 이 파일만 바뀜 |
| `robots.txt`, `.nojekyll` | 검색 차단, Pages의 Jekyll 처리 끔 |
| `deploy.ps1` / `deploy.cmd` | **Git 게시 스크립트**: 원격 최신화 → 데이터 교체 → 점검 → 커밋·푸시 → 사이트 반영 확인 |
| `tools/check-site.mjs` | 공개 전 점검. 허용 목록 밖의 파일(엑셀·CSV·평문 HTML 등)과 잘못된 암호화 데이터를 거부 |
| `.githooks/pre-commit` | 커밋할 때마다 위 점검을 자동 실행 |

접속 주소: `https://<소유자>.github.io/<저장소>/` (로그인), `…/admin.html` (계정 발급)

## 최초 설정 (PC 한 번)

필요 프로그램: Git for Windows, Node.js(점검 스크립트용). 둘 다 이 PC에 설치돼 있음.

1. GitHub에서 빈 저장소 생성(README 추가 안 함).
2. 이 폴더에서:
   ```bash
   git remote add origin https://github.com/<소유자>/<저장소>.git
   ```
   ```bash
   git push -u origin main
   ```
   처음 푸시할 때 브라우저 로그인 창이 뜨면 GitHub 계정으로 로그인(Git Credential Manager가 이후 기억함).
3. 저장소 Settings → Pages → Source "Deploy from a branch", Branch `main` / `/(root)`.
4. 1~2분 뒤 접속 주소에서 로그인 화면 확인.

다른 PC에서는 `git clone` 후 `git config core.hooksPath .githooks` 한 번만 실행(`deploy.ps1`도 실행할 때마다 설정함).

## 매월 문서 교체 (Git 방식)

1. `../build/`에서 원본 보고서 생성(`bash run_all.sh`, 점검 통과 확인).
2. `admin.html`을 열어 원본 HTML 선택 → 계정 입력(지난 `계정목록.csv` 불러오기) → **게시 설정의 토큰은 비워 둠** → "암호화 후 게시".
   토큰이 없으면 `report.enc.json`이 내려받아짐. 계정목록 CSV도 내려받아 비공개 위치에 보관.
3. 게시:
   ```powershell
   .\deploy.ps1 -EncFile "$HOME\Downloads\report.enc.json" -Message "11월 실적 Review 게시"
   ```
   또는 내려받은 `report.enc.json`을 `deploy.cmd` 아이콘에 끌어다 놓기.
   스크립트가 ① `git pull --rebase` ② `data/report.enc.json` 교체 ③ 점검 ④ 커밋·푸시 ⑤ Pages에 새 `iv`가 뜰 때까지(최대 3분) 확인.
4. 로그인 화면에서 실제 계정으로 열리는지 확인 후, 접속 주소와 비밀번호를 서로 다른 경로로 전달.

- 점검만: `.\deploy.ps1 -DryRun`
- `index.html`·`admin.html` 수정 같은 코드 변경도 같은 스크립트로 게시(`-EncFile` 없이 실행).
- admin.html의 "GitHub 바로 게시"(토큰 방식)를 써도 됨. 이 경우 원격에 직접 커밋되므로, 다음 Git 게시 전에 `deploy.ps1`이 먼저 받아옴(수동이면 `git pull --rebase`).
- 되돌리기: `git revert --no-edit HEAD` 후 `.\deploy.ps1` → 이전 암호문으로 복귀(밀린 커밋도 점검 후 푸시됨).
- 게시는 `main` 브랜치에서만 동작. 푸시 전에 **원격에 없는 커밋 하나하나**의 파일 전체를 점검하므로, 중간 커밋에 엑셀 등이 들어갔다면 지워도 푸시가 막힘 → `git reset --soft origin/main` 후 다시 커밋.
- 사용자 지정 도메인을 쓰면 `-SiteUrl https://도메인/` 지정.

## 보안상 한계 (원본 README 유지)

- 암호문은 공개 저장소에서 누구나 내려받을 수 있으므로 보안 수준은 비밀번호 강도에 달림(도구는 12자 미만 거부, 14자 자동 생성 권장).
- **커밋 이력에 과거 암호문이 모두 남음.** 계정을 빼고 다시 게시해도 이전 커밋의 암호문은 옛 비밀번호로 계속 열림.
- 원본 HTML·계정목록 CSV는 저장소에 올리지 말 것(점검 스크립트가 막지만, 한 번 푸시되면 삭제해도 이력에 남음).
- 로그인 화면의 문서 제목은 암호화되지 않음. 접속 기록·시도 제한·즉시 차단 없음. 화면 캡처는 막을 수 없음(계정별 워터마크로 추적만).
- 고객사·손익 자료를 외부 서버에 올리는 것이므로 회사 보안 승인 여부를 먼저 확인.

## 암호화 방식

본문은 무작위 256비트 키로 AES-256-GCM. 그 키를 계정마다 PBKDF2-SHA256(600,000회)로 비밀번호에서 유도한 키로 다시 암호화. 아이디는 파일별 무작위 솔트(v3 `ids`)를 붙인 SHA-256 해시로만 저장. 모두 브라우저(Web Crypto) 안에서 처리.

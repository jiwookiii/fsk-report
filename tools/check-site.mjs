// 게시 전 점검: 공개 저장소에 올라가면 안 되는 파일이 없는지, 암호화 데이터 형식이 맞는지 확인.
// 사용:
//   node tools/check-site.mjs                    작업 폴더(커밋될 파일) 점검
//   node tools/check-site.mjs --enc <파일>        작업 폴더 점검 + data/report.enc.json 대신 <파일> 내용으로 점검(DryRun용)
//   node tools/check-site.mjs --staged           pre-commit 훅: 인덱스(스테이징) 전체를 Git 객체 내용으로 점검
//   node tools/check-site.mjs --commits <범위>    푸시 전: 범위의 커밋마다 트리 전체를 점검 (예: origin/main..HEAD, 최초는 HEAD)
// 문제가 있으면 목록을 출력하고 종료 코드 1
import { execFileSync } from 'node:child_process';
import { readFileSync, existsSync, lstatSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const root = path.resolve(path.dirname(fileURLToPath(import.meta.url)), '..');
const argv = process.argv.slice(2);
const opt = k => { const i = argv.indexOf(k); return i < 0 ? null : (argv[i + 1] ?? ''); };
const git = (a, enc = 'utf8') => execFileSync('git', a, { cwd: root, encoding: enc, maxBuffer: 1 << 30 });
const DATA = 'data/report.enc.json';

// 허용 목록: 이 밖의 파일은 모두 거부 (원본 보고서·엑셀·계정목록이 섞여 올라가는 것을 막음)
const ALLOW = [
  /^index\.html$/, /^admin\.html$/, /^robots\.txt$/, /^\.nojekyll$/,
  /^\.gitignore$/, /^\.gitattributes$/, /^README\.md$/,
  /^data\/report\.enc\.json$/, /^tools\/check-site\.mjs$/, /^\.githooks\/pre-commit$/,
  /^deploy\.(ps1|cmd)$/,
];
const MAX = { 'index.html': 60_000, 'admin.html': 120_000 };

// 표준 base64를 엄격히 디코드(재인코딩 일치). 실패 시 null
const unb64 = s => { if (typeof s !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(s) || s.length % 4) return null;
  const b = Buffer.from(s, 'base64'); return b.toString('base64') === s ? b : null; };

// 트리 하나(파일 이름 목록 + 내용 읽기 함수)를 점검해 문제 목록을 돌려줌
// modeOf(f): Git 모드('100644' 등) 또는 작업 폴더에서는 'symlink'/'file'
function checkTree(label, names, read, modeOf) {
  const bad = [];
  for (const f of names) {
    if (!ALLOW.some(r => r.test(f))) bad.push(`허용되지 않은 파일: ${f}`);
    else if (!['100644', '100755', 'file'].includes(modeOf(f))) bad.push(`일반 파일이 아님(심볼릭 링크·서브모듈 등): ${f}`);
  }
  for (const f of ['index.html', 'admin.html']) {
    if (!names.includes(f)) { bad.push(`필수 파일 없음: ${f}`); continue; }
    const b = read(f);
    if (b.length > MAX[f]) bad.push(`${f} 크기 ${b.length}바이트 — 평문 보고서로 덮어쓴 것 아닌지 확인`);
    if (/실적 Review<\/h1>|const D\s*=\s*\{|"ytd"\s*:/.test(b.toString('utf8'))) bad.push(`${f}에 평문 보고서 내용이 보임`);
  }
  if (!names.includes(DATA)) bad.push(`${DATA} 없음 — admin.html에서 만든 파일을 이 경로에 둘 것`);
  else bad.push(...checkEnc(read(DATA).toString('utf8'), label));
  return bad.map(x => `[${label}] ${x}`);
}

let encInfo = '';
function checkEnc(text, label) {
  const bad = [];
  let P;
  try { P = JSON.parse(text); } catch (e) { return [`${DATA} JSON 형식 오류: ${e.message}`]; }
  if (!P || typeof P !== 'object' || Array.isArray(P)) return [`${DATA}: 객체가 아님`];
  // 중복 키 차단: JSON.parse는 앞의 값을 버리지만 파일에는 그대로 남아 공개됨. 이스케이프되지 않은 "키": 개수를 셈
  const cnt = k => (text.match(new RegExp(`(?<!\\\\)"${k}"\\s*:`, 'g')) || []).length;
  for (const k of ['v', 'it', 'title', 'iv', 'ct', 'acc', 'ids']) if (cnt(k) > 1) bad.push(`${DATA}: "${k}" 키가 중복됨`);
  const nAcc = Array.isArray(P.acc) ? P.acc.length : 0;
  for (const k of ['h', 's', 'i', 'k']) if (cnt(k) !== nAcc) bad.push(`${DATA}: 계정 키 "${k}" 개수 ${cnt(k)} ≠ 계정 ${nAcc}개 (중복 키 의심)`);
  if (P.v === 2 && 'ids' in P) bad.push(`${DATA}: v2에는 ids가 없어야 함`);
  const len = (v, n, nm) => { const b = unb64(v); if (!b) bad.push(`${DATA}: ${nm} base64 형식 오류`); else if (typeof n === 'number' ? b.length !== n : b.length < n.min) bad.push(`${DATA}: ${nm} 길이 ${b.length}바이트 (예상 ${typeof n === 'number' ? n : n.min + ' 이상'})`); };
  if (!(P.v === 2 || P.v === 3)) bad.push(`${DATA}: 버전(v) ${P.v} — 2 또는 3이어야 함`);
  if (!(Number.isInteger(P.it) && P.it >= 600000)) bad.push(`${DATA}: PBKDF2 반복(it) ${P.it} — 600000 이상`);
  if (P.title != null && typeof P.title !== 'string') bad.push(`${DATA}: title 형식 오류`);
  len(P.iv, 12, 'iv'); len(P.ct, { min: 17 }, 'ct');
  if (P.v >= 3) len(P.ids, 16, 'ids');
  if (!Array.isArray(P.acc) || !P.acc.length) bad.push(`${DATA}: 계정(acc)이 없음 — 아무도 로그인할 수 없음`);
  else P.acc.forEach((a, i) => {
    if (!a || typeof a !== 'object') { bad.push(`${DATA}: acc[${i}] 형식 오류`); return; }
    const ex = Object.keys(a).filter(k => !['h', 's', 'i', 'k'].includes(k));
    if (ex.length) bad.push(`${DATA}: acc[${i}]에 ${ex.join(', ')} 포함 — 아이디·비밀번호 평문 여부 확인`);
    len(a.h, 32, `acc[${i}].h`); len(a.s, 16, `acc[${i}].s`); len(a.i, 12, `acc[${i}].i`); len(a.k, { min: 48 }, `acc[${i}].k`);
  });
  const extra = Object.keys(P).filter(k => !['v', 'it', 'title', 'iv', 'ct', 'acc', 'ids'].includes(k));
  if (extra.length) bad.push(`${DATA}: 예상하지 못한 항목 ${extra.join(', ')} — 평문이 섞였는지 확인`);
  if (!bad.length && !encInfo) encInfo = `암호화 데이터: v${P.v} · 계정 ${P.acc.length}개 · 제목 "${P.title || ''}" · iv ${P.iv}`;
  return bad;
}

// Git 트리(커밋 또는 인덱스)의 일반 파일 목록. 심볼릭 링크·서브모듈도 허용 목록 검사 대상
function gitEntries(lines) {
  const m = new Map();
  for (const l of lines.split('\0').filter(Boolean)) {
    const tab = l.indexOf('\t'); const meta = l.slice(0, tab).split(' '); const name = l.slice(tab + 1);
    m.set(name, { mode: meta[0], oid: meta.length === 3 && /^[0-9a-f]{40,64}$/.test(meta[1]) ? meta[1] : meta[2] });
  }
  return m;
}
const blob = oid => git(['cat-file', 'blob', oid], 'buffer');

let bad = [], scope;
const range = opt('--commits');
if (range !== null) {
  if (!range) { console.error('--commits 범위를 지정할 것'); process.exit(2); }
  const commits = git(['rev-list', range]).split('\n').filter(Boolean);
  for (const c of commits) {
    const e = gitEntries(git(['ls-tree', '-r', '-z', '--full-tree', c]));
    bad.push(...checkTree(`커밋 ${c.slice(0, 7)}`, [...e.keys()], f => blob(e.get(f).oid), f => e.get(f).mode));
  }
  scope = `푸시할 커밋 ${commits.length}개`;
} else if (argv.includes('--staged')) {
  const raw = git(['ls-files', '-s', '-z']);
  if (/^\d+ [0-9a-f]+ [123]\t/m.test(raw.replace(/\0/g, '\n'))) bad.push('[인덱스] 충돌 해결이 안 된 파일이 있음');
  const e = new Map();
  for (const l of raw.split('\0').filter(Boolean)) { const tab = l.indexOf('\t'); const [mode, oid] = l.slice(0, tab).split(' '); e.set(l.slice(tab + 1), { mode, oid }); }
  bad.push(...checkTree('인덱스', [...e.keys()], f => blob(e.get(f).oid), f => e.get(f).mode));
  scope = `스테이징 파일 ${e.size}개`;
} else {
  const names = git(['ls-files', '--cached', '--others', '--exclude-standard', '-z']).split('\0').filter(Boolean)
    .filter(f => existsSync(path.join(root, f)));  // 삭제 예정 파일 제외
  const enc = opt('--enc');
  if (enc !== null && !names.includes(DATA)) names.push(DATA);
  const read = f => (f === DATA && enc) ? readFileSync(path.resolve(enc)) : readFileSync(path.join(root, f));
  const modeOf = f => (f === DATA && enc) ? 'file' : (lstatSync(path.join(root, f)).isFile() ? 'file' : 'symlink');
  bad.push(...checkTree('작업 폴더', names, read, modeOf));
  scope = `작업 폴더 파일 ${names.length}개`;
}

if (bad.length) { console.error(`게시 점검 실패 ${bad.length}건`); bad.forEach(b => console.error(' - ' + b)); process.exit(1); }
if (encInfo) console.log(encInfo);
console.log(`게시 점검 통과 (${scope})`);

// 게시 전 점검(v4): 공개 저장소에 올라가면 안 되는 파일이 없는지, 암호화 데이터 형식이 맞는지 확인.
// 사용:
//   node tools/check-site.mjs                    작업 폴더(커밋될 파일) 점검
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
const KEYS = 'data/keys.json', CAT = 'data/catalog.json', RPT = /^data\/r\/[0-9a-z][0-9a-z-]{2,60}\.enc\.json$/;

// 허용 목록: 이 밖의 파일은 모두 거부 (원본 보고서·엑셀·계정목록·관리자 키가 섞여 올라가는 것을 막음)
const ALLOW = [
  /^index\.html$/, /^robots\.txt$/, /^\.nojekyll$/,
  /^\.gitignore$/, /^\.gitattributes$/, /^README\.md$/,
  /^data\/keys\.json$/, /^data\/catalog\.json$/, RPT,
  /^tools\/check-site\.mjs$/, /^\.githooks\/pre-(commit|push)$/, /^deploy\.(ps1|cmd)$/,
];
// 개인키 유출 차단: JWK 개인키 모양 + (이 PC에 있으면) 실제 관리자 개인키 값. 값은 출력하지 않음
const PRIV = [/"d"\s*:\s*"[A-Za-z0-9_-]{40,}"/, /"kty"\s*:\s*"EC"[^}]*"d"\s*:/, /-----BEGIN [A-Z ]*PRIVATE KEY-----/];
let ADMIN_D = null;
try { const a = JSON.parse(readFileSync(path.join(root, '..', 'build', 'secrets', 'admin.json'), 'utf8')); if (a && a.priv && typeof a.priv.d === 'string' && a.priv.d.length > 20) ADMIN_D = [a.priv.d, Buffer.from(a.priv.d, 'base64url').toString('base64').replace(/=+$/, '')]; } catch {}
const MAX = { 'index.html': 60_000 };

const unb64 = s => { if (typeof s !== 'string' || !/^[A-Za-z0-9+/]+={0,2}$/.test(s) || s.length % 4) return null;
  const b = Buffer.from(s, 'base64'); return b.toString('base64') === s ? b : null; };

// 공개 JSON은 도구가 쓴 정규형(JSON.stringify, 공백 없음)이어야 함 → 중복 키·숨은 내용·손편집 차단
function canon(text, f, bad) {
  let o; try { o = JSON.parse(text); } catch (e) { bad.push(`${f} JSON 형식 오류: ${e.message}`); return null; }
  if (JSON.stringify(o) !== text) { bad.push(`${f}: 정규형이 아님(중복 키·공백·손편집 의심) — 관리 도구로 다시 생성할 것`); return null; }
  if (!o || typeof o !== 'object' || Array.isArray(o)) { bad.push(`${f}: 객체가 아님`); return null; }
  return o;
}
const only = (o, keys, f, bad) => { const ex = Object.keys(o).filter(k => !keys.includes(k)); if (ex.length) bad.push(`${f}: 예상하지 못한 항목 ${ex.join(', ')} — 평문이 섞였는지 확인`); };
function len(v, n, nm, bad) { const b = unb64(v); if (!b) bad.push(`${nm} base64 형식 오류`); else if (typeof n === 'number' ? b.length !== n : b.length < n.min) bad.push(`${nm} 길이 ${b.length}바이트 (예상 ${typeof n === 'number' ? n : n.min + ' 이상'})`); }
const gcm = (o, nm, bad, min = 17) => { if (!o || typeof o !== 'object') { bad.push(nm + ' 없음'); return; } only(o, ['iv', 'ct'], nm, bad); len(o.iv, 12, nm + '.iv', bad); len(o.ct, { min }, nm + '.ct', bad); };

let info = '';
function checkTree(label, names, read, modeOf) {
  const bad = [];
  for (const f of names) {
    if (!ALLOW.some(r => r.test(f))) bad.push(`허용되지 않은 파일: ${f}`);
    else if (!['100644', '100755', 'file'].includes(modeOf(f))) bad.push(`일반 파일이 아님(심볼릭 링크·서브모듈 등): ${f}`);
  }
  for (const f of names) { if (!ALLOW.some(r => r.test(f))) continue; const t = read(f).toString('latin1');
    if (PRIV.some(r => r.test(t))) bad.push(`${f}: 개인키(JWK·PEM) 모양의 값이 들어 있음 — 관리자 키·계정 키 유출 의심`);
    if (ADMIN_D && ADMIN_D.some(d => t.includes(d))) bad.push(`${f}: 관리자 개인키 값이 들어 있음 — 절대 게시 금지`); }
  if (!names.includes('index.html')) bad.push('필수 파일 없음: index.html');
  else { const b = read('index.html'); if (b.length > MAX['index.html']) bad.push(`index.html 크기 ${b.length}바이트 — 평문 보고서로 덮어쓴 것 아닌지 확인`);
    if (/실적 Review<\/h1>|const D\s*=\s*\{|"ytd"\s*:/.test(b.toString('utf8'))) bad.push('index.html에 평문 보고서 내용이 보임'); }
  for (const f of [KEYS, CAT]) if (!names.includes(f)) bad.push(`필수 파일 없음: ${f} — 관리 도구(build/tools/site.mjs)로 생성`);
  if (bad.length) return bad.map(x => `[${label}] ${x}`);

  const K = canon(read(KEYS).toString('utf8'), KEYS, bad), C = canon(read(CAT).toString('utf8'), CAT, bad);
  if (K) {
    only(K, ['v', 'it', 'title', 'ids', 'admin', 'users'], KEYS, bad);
    if (K.v !== 4) bad.push(`${KEYS}: v ${K.v} — 4여야 함`);
    if (K.it !== 600000) bad.push(`${KEYS}: PBKDF2 반복(it) ${K.it} — 이 형식은 600000 고정`);
    if (typeof K.title !== 'string') bad.push(`${KEYS}: title 형식 오류`);
    len(K.ids, 16, KEYS + ' ids', bad); len(K.admin, 65, KEYS + ' admin', bad);
    if (!Array.isArray(K.users) || !K.users.length) bad.push(`${KEYS}: 계정 없음`);
    else { const hs = new Set();
      K.users.forEach((u, i) => { const nm = `${KEYS} users[${i}]`; if (!u || typeof u !== 'object') return bad.push(nm + ' 형식 오류');
        only(u, ['h', 's', 'i', 'k', 'pub'], nm, bad); len(u.h, 32, nm + '.h', bad); len(u.s, 16, nm + '.s', bad); len(u.i, 12, nm + '.i', bad); len(u.k, { min: 64 }, nm + '.k', bad); len(u.pub, 65, nm + '.pub', bad);
        if (hs.has(u.h)) bad.push(nm + ' 아이디 중복'); hs.add(u.h); }); }
  }
  if (C && K && Array.isArray(K.users)) {
    only(C, ['v', 'versions'], CAT, bad);
    if (C.v !== 4) bad.push(`${CAT}: v ${C.v} — 4여야 함`);
    if (!Array.isArray(C.versions) || !C.versions.length) bad.push(`${CAT}: 판 없음`);
    else {
      const users = new Set(K.users.map(u => u.h)), files = new Set(), vids = new Set();
      C.versions.forEach((v, i) => { const nm = `${CAT} versions[${i}]`; if (!v || typeof v !== 'object') return bad.push(nm + ' 형식 오류');
        only(v, ['vid', 'f', 'epk', 'meta', 'r'], nm, bad);
        if (typeof v.vid !== 'string' || !/^[0-9a-z][0-9a-z-]{2,60}$/.test(v.vid)) bad.push(nm + '.vid 형식 오류');
        if (vids.has(v.vid)) bad.push(nm + ' vid 중복'); vids.add(v.vid);
        if (v.f !== `r/${v.vid}.enc.json`) bad.push(nm + '.f 가 vid와 다름');
        files.add('data/' + v.f); len(v.epk, 65, nm + '.epk', bad); gcm(v.meta, nm + '.meta', bad);
        if (!v.r || typeof v.r !== 'object') return bad.push(nm + '.r 없음');
        const rk = Object.keys(v.r);
        if (!rk.includes('admin')) bad.push(nm + ': 관리자 몫 없음(관리자가 이 판을 다시 잠글 수 없음)');
        for (const h of rk) { if (h !== 'admin' && !users.has(h)) bad.push(`${nm}: 목록에 없는 계정 몫 ${h.slice(0, 8)}…`); gcm(v.r[h], `${nm}.r`, bad, 48); }
        for (const h of users) if (!v.r[h]) bad.push(`${nm}: 계정 몫 누락 ${h.slice(0, 8)}…`);
      });
      for (const f of names.filter(n => RPT.test(n))) if (!files.has(f)) bad.push(`목록에 없는 판 파일: ${f}`);
      for (const f of files) {
        if (!names.includes(f)) { bad.push(`판 파일 없음: ${f}`); continue; }
        const o = canon(read(f).toString('utf8'), f, bad); if (!o) continue;
        only(o, ['v', 'iv', 'ct'], f, bad); if (o.v !== 4) bad.push(f + ': v 4 아님'); len(o.iv, 12, f + ' iv', bad); len(o.ct, { min: 17 }, f + ' ct', bad);
      }
      if (!bad.length && !info) info = `암호화 데이터: v4 · 계정 ${K.users.length}개 · 판 ${C.versions.length}개 · 제목 "${K.title}"`;
    }
  }
  return bad.map(x => `[${label}] ${x}`);
}

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
  const commits = git(['rev-list', ...range.split(/\s+/).filter(Boolean)]).split('\n').filter(Boolean);
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
    .filter(f => existsSync(path.join(root, f)));
  bad.push(...checkTree('작업 폴더', names, f => readFileSync(path.join(root, f)), f => lstatSync(path.join(root, f)).isFile() ? 'file' : 'symlink'));
  scope = `작업 폴더 파일 ${names.length}개`;
}

if (bad.length) { console.error(`게시 점검 실패 ${bad.length}건`); bad.slice(0, 60).forEach(b => console.error(' - ' + b)); process.exit(1); }
if (info) console.log(info);
console.log(`게시 점검 통과 (${scope})`);

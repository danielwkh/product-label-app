#!/usr/bin/env node
/*
 * 部署助手（零外部依賴，只用 Node 內建模組）
 *
 *   node tools/deploy.mjs check      # 只檢查：檔案完整性、git 狀態、正式站現況（不改任何東西）
 *   node tools/deploy.mjs github     # commit + push（Cloudflare Pages 會自動部署）
 *   node tools/deploy.mjs wrangler   # 不經 GitHub，直接 wrangler pages deploy
 *   node tools/deploy.mjs verify     # 部署後驗證（含「資料筆數沒有變少」比對）
 *
 * 常用選項：
 *   --url <網址>        正式站網址（預設 https://product-label-app.pages.dev）
 *   --branch <分支>     push / deploy 的目標分支（預設 main）
 *   --project <名稱>    Pages 專案名稱（預設 product-label-app）
 *   --remote <Git URL>  remote 不存在時自動設定（預設官方 repo）
 *   --with-tests        check 時順便跑三個測試套件
 *   --wait[=秒數]       部署後輪詢到新版本上線（預設 180 秒）
 *   --dry-run           只印出會執行的指令
 *   --yes               不詢問，直接執行
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from 'node:fs';
import { execFileSync, spawnSync } from 'node:child_process';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const DEFAULT_URL = 'https://product-label-app.pages.dev';
const DEFAULT_REMOTE = 'https://github.com/danielwkh/product-label-app.git';
const BASELINE_FILE = join(ROOT, '.deploy-baseline.json');

const C = {
  reset: '\x1b[0m', bold: '\x1b[1m', dim: '\x1b[2m',
  red: '\x1b[31m', green: '\x1b[32m', yellow: '\x1b[33m', cyan: '\x1b[36m'
};

const args = process.argv.slice(2);
const command = args.find(a => !a.startsWith('-')) || 'check';
function flag(name, fallback = null) {
  const hit = args.find(a => a === `--${name}` || a.startsWith(`--${name}=`));
  if (!hit) return fallback;
  const eq = hit.indexOf('=');
  return eq >= 0 ? hit.slice(eq + 1) : true;
}

const URL_BASE = String(flag('url', DEFAULT_URL)).replace(/\/$/, '');
const BRANCH = String(flag('branch', 'main'));
const PROJECT = String(flag('project', 'product-label-app'));
const REMOTE = String(flag('remote', DEFAULT_REMOTE));
const DRY = Boolean(flag('dry-run', false));
const YES = Boolean(flag('yes', false));

let failures = 0;
const ok = msg => console.log(`  ${C.green}✅${C.reset} ${msg}`);
const bad = msg => { failures++; console.log(`  ${C.red}❌${C.reset} ${msg}`); };
const warn = msg => console.log(`  ${C.yellow}⚠️${C.reset}  ${msg}`);
const info = msg => console.log(`  ${C.dim}·${C.reset} ${msg}`);
const title = msg => console.log(`\n${C.bold}${C.cyan}${msg}${C.reset}`);

function run(cmd, argv, options = {}) {
  if (DRY) {
    const shown = argv.map(a => (/extraheader|github_pat_|ghp_/i.test(a) ? '<已隱藏>' : a));
    console.log(`  ${C.dim}[dry-run]${C.reset} ${cmd} ${shown.join(' ')}`);
    return { ok: true, stdout: '' };
  }
  const result = spawnSync(cmd, argv, { cwd: ROOT, encoding: 'utf8', stdio: options.capture === false ? 'inherit' : 'pipe' });
  return {
    ok: result.status === 0,
    stdout: (result.stdout || '').trim(),
    stderr: (result.stderr || '').trim(),
    status: result.status
  };
}

async function fetchText(path, init) {
  try {
    const response = await fetch(`${URL_BASE}${path}`, { ...init, signal: AbortSignal.timeout(20000) });
    return { status: response.status, text: await response.text(), headers: response.headers };
  } catch (err) {
    return { status: 0, text: '', error: String(err.message || err) };
  }
}

/* ------------------------------------------------------------- 1. 檔案完整性 */

const REQUIRED = [
  'index.html',
  'js/app.js',
  'js/core/text.js',
  'js/core/matcher.js',
  'js/core/match.worker.js',
  'js/core/hash.js',
  'js/core/queue.js',
  'js/core/pipeline.js',
  'js/store/db.js',
  'js/store/api.js',
  'js/ui/jobs-view.js',
  'sw-v6.js',
  'functions/api/[[path]].js',
  'schema.sql',
  'migrations/0002_labels_hash.sql',
  'wrangler.toml',
  '_routes.json'
];

function checkFiles() {
  title('1. 檔案完整性');
  let missing = 0;
  for (const file of REQUIRED) {
    if (!existsSync(join(ROOT, file))) {
      bad(`缺少 ${file}`);
      missing++;
    }
  }
  if (!missing) ok(`${REQUIRED.length} 個必要檔案都在`);

  // HTML 參照的檔案都要存在（避免部署後 404 造成白畫面）
  const html = readFileSync(join(ROOT, 'index.html'), 'utf8');
  const refs = [...html.matchAll(/(?:src|href)="([^"]+)"/g)]
    .map(m => m[1])
    .filter(u => !/^(https?:|data:)/.test(u))
    .map(u => u.replace(/^\.\//, ''));
  const brokenRefs = refs.filter(r => !existsSync(join(ROOT, r)));
  if (brokenRefs.length) bad(`index.html 參照到不存在的檔案：${brokenRefs.join(', ')}`);
  else ok(`index.html 的 ${refs.length} 個本機參照都存在`);

  // JS 模組匯入
  const appSource = readFileSync(join(ROOT, 'js/app.js'), 'utf8');
  const imports = [...appSource.matchAll(/from '(\.[^']+)'/g)].map(m => m[1])
    .concat([...appSource.matchAll(/import\('(\.[^']+)'\)/g)].map(m => m[1]));
  const brokenImports = imports.filter(i => !existsSync(join(ROOT, 'js', i)));
  if (brokenImports.length) bad(`js/app.js 匯入失敗：${brokenImports.join(', ')}`);
  else ok('js/app.js 的匯入全部存在');

  // Service worker precache 清單
  const sw = readFileSync(join(ROOT, 'sw-v6.js'), 'utf8');
  const cached = [...sw.matchAll(/'\.\/([^']+)'/g)].map(m => m[1]);
  const brokenCache = cached.filter(p => !existsSync(join(ROOT, p)));
  if (brokenCache.length) bad(`sw-v6.js 預快取清單有問題：${brokenCache.join(', ')}`);
  else ok(`sw-v6.js 預快取 ${cached.length} 個檔案都存在`);

  // 舊版 SW 不該再被註冊
  if (/sw-v5\.js|sw-v4\.js|'\.\/sw\.js'/.test(html)) bad('index.html 仍註冊舊版 Service Worker');
  else ok('index.html 只註冊 sw-v6.js');
}

/* ---------------------------------------------------------------- 2. Git 狀態 */

function git(argv, options) {
  return run('git', argv, options);
}

function currentRemote() {
  const result = git(['remote', 'get-url', 'origin']);
  return result.ok ? result.stdout : '';
}

function checkGit() {
  title('2. Git 狀態');
  const branch = git(['rev-parse', '--abbrev-ref', 'HEAD']);
  const head = git(['rev-parse', '--short', 'HEAD']);
  if (!branch.ok) {
    bad('這不是一個 git repository');
    return;
  }
  info(`分支 ${branch.stdout} · HEAD ${head.stdout}`);

  const status = git(['status', '--porcelain']);
  if (status.stdout) warn(`有未提交的變更（${status.stdout.split('\n').length} 個檔案），github 模式會自動 commit`); 
  else ok('工作區乾淨');

  const remote = currentRemote();
  if (!remote) warn(`remote origin 不存在（github 模式會設為 ${REMOTE}）`);
  else ok(`remote: ${remote}`);

  const log = git(['log', '--oneline', '-3']);
  if (log.ok) log.stdout.split('\n').forEach(line => info(line));
}

/* ------------------------------------------------------------ 3. 正式站現況 */

const isD1Quota = text => /D1_ERROR|exceeded|1101/i.test(text || '');
const routeExists = async path => (await fetchText(path)).status !== 404;

async function readLive() {
  const health = await fetchText('/api/health');
  const metaRoute = await fetchText('/api/meta');
  const page = await fetchText('/');
  const bootstrap = await fetchText('/api/bootstrap');
  const out = {
    url: URL_BASE,
    checkedAt: new Date().toISOString(),
    health: null,
    bootstrapVersion: null,
    products: null,
    labels: null,
    healthStatus: health.status,
    hasMetaRoute: metaRoute.status !== 404,
    healthError: isD1Quota(health.text) ? health.text.slice(0, 200) : null,
    hasJobsUi: /id="jobList"/.test(page.text || ''),
    serving: page.status,
    htmlBytes: (page.text || '').length
  };
  try { out.health = JSON.parse(health.text); } catch { out.health = null; }
  try {
    const data = JSON.parse(bootstrap.text);
    out.products = Array.isArray(data.products) ? data.products.length : null;
    out.labels = Array.isArray(data.labels) ? data.labels.length : null;
    out.bootstrapVersion = data.version || 1;
  } catch { /* 舊版 API 或錯誤 */ }
  return out;
}

async function checkLive({ strict = false } = {}) {
  title('3. 正式站現況（唯讀）');
  const live = await readLive();
  if (!live.serving) {
    bad(`無法連線 ${URL_BASE}`);
    return live;
  }
  ok(`可連線 ${URL_BASE}（HTML ${live.htmlBytes.toLocaleString()} 字元）`);

  if (live.hasJobsUi) ok('已部署新版的匯入進度 UI');
  else warn('正式站仍是舊版 index.html（尚未部署本次改動）');

  if (live.hasMetaRoute) ok('Functions 是新版（/api/meta 路由存在）');
  else warn('Functions 還是舊版（沒有 /api/meta，部署後才會有）');

  if (live.health && live.health.ok) {
    ok(`/api/health 正常（D1 ${live.health.products} 商品 / ${live.health.labels} 標籤）`);
  } else if (live.health === null || live.health.error) {
    if (live.healthStatus === 404) {
      const message = '尚未有 /api/health → 這是舊版 Functions（部署後才會有）';
      if (strict) bad(message); else warn(message);
    } else if (live.healthError) {
      // 路由存在但 D1 讀不到：幾乎一定是免費方案每日列讀取額度用完（UTC 午夜重置）
      warn('API 可連線，但 D1 今天讀不到資料');
      warn(`  原因：${live.healthError.slice(0, 140)}`);
      warn('  處理：等 UTC 午夜（香港 08:00）重置，或升級 Cloudflare Workers Paid');
      warn('  影響：網站可用，但雲端同步暫時不可用；本機資料不受影響');
    } else {
      const message = `尚未有 /api/health（HTTP ${live.healthStatus}）→ 可能是舊版 Functions`;
      if (strict) bad(message); else warn(message);
    }
  } else {
    bad(`/api/health 回報異常：${JSON.stringify(live.health)}`);
  }

  if (live.products != null) ok(`bootstrap：products ${live.products} / labels ${live.labels}`);
  else if (live.healthError) warn('bootstrap 讀不到資料：D1 免費額度用完（不是程式問題）');
  else warn('bootstrap 無法解析（可能是舊版 API 或 D1 未設定）');

  try {
    mkdirSync(dirname(BASELINE_FILE), { recursive: true });
    writeFileSync(BASELINE_FILE, JSON.stringify(live, null, 2));
    info(`基準已寫入 ${BASELINE_FILE.replace(ROOT + '/', '')}`);
  } catch (err) {
    warn(`無法寫入基準檔：${err.message}`);
  }
  return live;
}

/* ------------------------------------------------------- 4. D1 欄位（可選） */

function checkD1() {
  title('4. D1 欄位（可選，需要 wrangler 已登入）');
  const which = run('npx', ['--no-install', 'wrangler', '--version']);
  if (!which.ok) {
    warn('找不到 wrangler，略過（API 第一次請求時會自動補欄位）');
    return;
  }
  const who = run('npx', ['--no-install', 'wrangler', 'whoami']);
  if (!who.ok) {
    warn('wrangler 未登入（npx wrangler login），略過');
    return;
  }
  const sql = 'PRAGMA table_info(labels);';
  const result = run('npx', ['--no-install', 'wrangler', 'd1', 'execute', PROJECT, '--remote', '--command', sql]);
  if (!result.ok) {
    warn(`無法查詢 D1（${(result.stderr || '').split('\n').slice(-1)[0] || '未知錯誤'}），略過`);
    return;
  }
  const hasContentHash = /content_hash/.test(result.stdout);
  const hasSize = /\bsize\b/.test(result.stdout);
  if (hasContentHash && hasSize) ok('labels.content_hash / size 已存在');
  else warn('尚未有 content_hash / size，部署後會自動補（或先跑 migrations/0002_labels_hash.sql）');
}

/* ------------------------------------------------------------------ 指令 */

async function cmdCheck() {
  console.log(`${C.bold}部署前檢查${C.reset}  ${C.dim}${URL_BASE}${C.reset}`);
  const node = process.versions.node;
  title('0. 環境');
  info(`Node ${node}（wrangler 需要 22+；Pages 自動部署不受影響）`);
  checkFiles();
  checkGit();
  const live = await checkLive();
  checkD1();

  if (flag('with-tests', false)) {
    title('5. 測試套件');
    for (const test of ['stress-test.mjs', 'ui-smoke.mjs', 'api-integration.mjs']) {
      if (!existsSync(join(ROOT, 'tools', test))) { warn(`略過 tools/${test}（不存在）`); continue; }
      if (!existsSync(join(ROOT, 'tools', 'node_modules'))) { warn('tools/node_modules 不存在，請先 cd tools && npm install'); break; }
      const started = Date.now();
      const result = run('node', ['--max-old-space-size=3072', join('tools', test)]);
      if (result.ok) ok(`${test}（${Math.round((Date.now() - started) / 1000)}s）`);
      else bad(`${test} 失敗：${(result.stderr || result.stdout || '').split('\n').slice(-3).join(' ')}`);
    }
  }

  title('結論');
  if (failures) {
    console.log(`  ${C.red}有 ${failures} 個問題需要先處理${C.reset}`);
    return 1;
  }
  console.log(`  ${C.green}可以部署${C.reset}`);
  console.log(`  ${C.dim}下一步：node tools/deploy.mjs github   （或 wrangler）${C.reset}`);
  if (live && !live.hasJobsUi) {
    console.log(`  ${C.dim}提示：正式站目前仍是舊版，部署後重新執行 node tools/deploy.mjs verify 確認${C.reset}`);
  }
  return 0;
}

function ensureRemote() {
  const remote = currentRemote();
  if (remote) return remote;
  const result = git(['remote', 'add', 'origin', REMOTE]);
  if (!result.ok) throw new Error(`無法新增 remote：${result.stderr}`);
  info(`已設定 remote origin = ${REMOTE}`);
  return REMOTE;
}

async function cmdGithub() {
  console.log(`${C.bold}推送到 GitHub${C.reset}（Cloudflare Pages 會自動部署）`);
  checkFiles();
  const status = git(['status', '--porcelain']);
  if (status.stdout) {
    if (!YES && !DRY) {
      warn('有未提交的變更，請先自行 commit（或用 --yes 讓腳本代為 commit）');
      return 1;
    }
    git(['add', '-A']);
    const commit = git(['commit', '-m', 'Deploy: PDF import refactor']);
    if (!commit.ok) { bad(`commit 失敗：${commit.stderr}`); return 1; }
    ok('已建立 commit');
  } else {
    ok('工作區乾淨，直接推送現有 commit');
  }

  ensureRemote();
  const before = git(['rev-parse', '--short', 'HEAD']).stdout;

  // token 來源（都不會寫入 shell history 或 .git/config）：
  //   --token-stdin  從標準輸入讀取（建議：echo 不會留下記錄）
  //   --token-env    從環境變數 GITHUB_TOKEN / GH_TOKEN 讀取
  let authArgs = [];
  let tokenSource = '';
  if (flag('token-stdin', false)) {
    try {
      const token = readFileSync(0, 'utf8').trim();
      if (token) {
        const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
        authArgs = ['-c', `http.https://github.com/.extraheader=Authorization: Basic ${basic}`];
        tokenSource = 'stdin';
      }
    } catch { /* 沒有 stdin 就忽略 */ }
  } else if (flag('token-env', false)) {
    const token = process.env.GITHUB_TOKEN || process.env.GH_TOKEN || '';
    if (token) {
      const basic = Buffer.from(`x-access-token:${token}`).toString('base64');
      authArgs = ['-c', `http.https://github.com/.extraheader=Authorization: Basic ${basic}`];
      tokenSource = 'env';
    }
  }
  if (tokenSource) info(`使用 ${tokenSource} 提供的 token 推送（不會寫入 .git/config）`);

  const push = run('git', [...authArgs, 'push', 'origin', `HEAD:${BRANCH}`]);
  if (!push.ok) {
    bad(`push 失敗：${push.stderr || push.stdout}`);
    console.log(`
  ${C.dim}常見原因與處理：${C.reset}
    · 未登入 GitHub       → 先執行 gh auth login，或改用 HTTPS + Personal Access Token
    · 沒有推送權限        → 確認你對 danielwkh/product-label-app 有 write 權限
    · 遠端有新 commit     → git pull --rebase origin ${BRANCH} 後再試
    · 只想先看不推送      → node tools/deploy.mjs check --with-tests
`);
    return 1;
  }
  if (DRY) {
    ok('[dry-run] 不會真的推送；實際執行請移除 --dry-run');
    return 0;
  }
  ok(`已推送 ${before} → origin/${BRANCH}`);
  console.log(`  ${C.dim}Cloudflare Pages 約 1–2 分鐘完成部署；接著執行：${C.reset}`);
  console.log(`  node tools/deploy.mjs verify --wait`);
  if (flag('wait', false)) return cmdVerify();
  return 0;
}

async function cmdWrangler() {
  console.log(`${C.bold}直接部署到 Cloudflare Pages${C.reset}（不經 GitHub）`);
  checkFiles();
  const version = run('npx', ['--no-install', 'wrangler', '--version']);
  if (!version.ok) {
    bad('找不到 wrangler。請先安裝並登入：npm i -D wrangler@latest && npx wrangler login');
    console.log(`  ${C.dim}（wrangler 需要 Node 22 以上；目前 ${process.versions.node}）${C.reset}`);
    return 1;
  }
  const deploy = run('npx', [
    '--no-install', 'wrangler', 'pages', 'deploy', '.',
    '--project-name', PROJECT,
    '--branch', BRANCH,
    '--commit-dirty=true'
  ], { capture: false });
  if (!deploy.ok) {
    bad('wrangler pages deploy 失敗（看上面的輸出）');
    return 1;
  }
  ok(DRY ? '[dry-run] 不會真的部署' : '已部署');
  if (DRY) return 0;
  return cmdVerify();
}

async function cmdVerify() {
  console.log(`${C.bold}部署後驗證${C.reset}  ${C.dim}${URL_BASE}${C.reset}`);
  let baseline = null;
  if (existsSync(BASELINE_FILE)) {
    try { baseline = JSON.parse(readFileSync(BASELINE_FILE, 'utf8')); } catch { baseline = null; }
  }

  const waitSeconds = Number(flag('wait', 0)) || 0;
  if (waitSeconds) {
    // 只輪詢靜態 HTML：這一步不會產生任何 D1 row read
    const deadline = Date.now() + waitSeconds * 1000;
    process.stdout.write('  等待新版本上線');
    let ready = false;
    while (Date.now() < deadline) {
      const page = await fetchText('/');
      if (/id="jobList"/.test(page.text)) { ready = true; break; }
      process.stdout.write('.');
      await new Promise(r => setTimeout(r, 5000));
    }
    console.log('');
    if (!ready) warn(`等了 ${waitSeconds} 秒仍未偵測到新版本`);
    else ok('新版本已上線');
  }

  title('1. 前端版本');
  const page = await fetchText('/');
  if (/id="jobList"/.test(page.text)) ok('index.html 是新版（含匯入進度 UI）');
  else bad('index.html 仍是舊版');
  const appText = (await fetchText('/js/app.js')).text;
  if (/sw-v6\.js/.test(page.text) || /sw-v6\.js/.test(appText)) ok('已註冊 sw-v6.js');
  else bad('尚未註冊 sw-v6.js（舊 Service Worker 會繼續 cache-first）');
  if (/sw-v[45]\.js|'\.\/sw\.js'/.test(page.text + appText)) bad('仍有程式碼註冊舊版 Service Worker');

  const ASSETS = [
    ['/js/app.js', 'createImportPipeline'],
    ['/js/core/pipeline.js', 'createImportPipeline'],
    ['/js/core/match.worker.js', 'matchFileName'],
    ['/js/core/matcher.js', 'buildIndex'],
    ['/sw-v6.js', 'product-label-app-']
  ];
  for (const [asset, marker] of ASSETS) {
    const assetResponse = await fetchText(asset);
    const isHtml = /^\s*<!DOCTYPE/i.test(assetResponse.text);
    if (assetResponse.status !== 200) bad(`${asset} 回應 ${assetResponse.status}`);
    else if (isHtml) bad(`${asset} 回傳的是 index.html（檔案不存在，被 SPA fallback 接走）`);
    else if (!assetResponse.text.includes(marker)) bad(`${asset} 內容不含預期標記「${marker}」`);
    else ok(`${asset} 正確（${assetResponse.text.length.toLocaleString()} 字元）`);
  }

  title('1b. 前端相依檔（vendor）');
  for (const [asset, marker] of [
    ['/vendor/pdfjs/pdf.min.mjs', 'pdfjs'],
    ['/vendor/pdfjs/pdf.worker.min.mjs', 'pdfjs'],
    ['/vendor/xlsx.full.min.js', 'XLSX'],
    ['/vendor/html5-qrcode.min.js', 'Html5Qrcode']
  ]) {
    const assetResponse = await fetchText(asset);
    const isHtml = /^\s*<!DOCTYPE/i.test(assetResponse.text);
    if (assetResponse.status !== 200) bad(`${asset} 回應 ${assetResponse.status}`);
    else if (isHtml) bad(`${asset} 回傳 index.html（檔案不存在）`);
    else if (marker && !assetResponse.text.includes(marker)) warn(`${asset} 內容找不到「${marker}」（可能仍是可用檔案）`);
    else ok(`${asset} 正確（${(assetResponse.text.length / 1024).toFixed(0)}K 字元）`);
  }

  title('2. API');
  const health = await fetchText('/api/health');
  let healthJson = null;
  try { healthJson = JSON.parse(health.text); } catch { /* ignore */ }
  if (healthJson && healthJson.ok) {
    ok(`/api/health 正常：products ${healthJson.products} / labels ${healthJson.labels} / r2 ${healthJson.r2}`);
    if (healthJson.productsRevision) info(`products_revision ${healthJson.productsRevision} / labels_revision ${healthJson.labelsRevision}`);
  } else if (isD1Quota(health.text)) {
    warn('/api/health 路由存在（新 Functions 已上線），但 D1 免費額度用完，讀不到資料');
    warn('  → 這不是部署失敗；UTC 午夜（香港 08:00）重置，或升級 Workers Paid');
  } else {
    bad(`/api/health 異常：${health.text.slice(0, 120)}`);
  }

  title('3. 資料沒有變少（只查一次，避免消耗 D1 row read）');
  const live = await readLive();
  if (live.products == null) {
    if (live.healthError) warn('D1 額度用完，今天無法比對資料筆數（等重置後再跑一次 verify）');
    else bad('bootstrap 無法解析，無法比對資料筆數');
  } else if (baseline && baseline.products != null) {
    const productDelta = live.products - baseline.products;
    const labelDelta = live.labels - baseline.labels;
    if (productDelta < 0) bad(`商品數下降 ${baseline.products} → ${live.products}（請立即回滾並回報）`);
    else ok(`商品數 ${baseline.products} → ${live.products}（${productDelta >= 0 ? '+' : ''}${productDelta}）`);
    if (labelDelta < 0) bad(`標籤數下降 ${baseline.labels} → ${live.labels}（請立即回滾並回報）`);
    else ok(`標籤數 ${baseline.labels} → ${live.labels}（${labelDelta >= 0 ? '+' : ''}${labelDelta}）`);
  } else {
    ok(`bootstrap：products ${live.products} / labels ${live.labels}（沒有基準可比對）`);
  }

  title('4. PDF 下載（Range）');
  if (live.labels > 0) {
    const bootstrap = await fetchText('/api/bootstrap');
    let firstId = null;
    try { firstId = JSON.parse(bootstrap.text).labels[0].id; } catch { /* ignore */ }
    if (firstId) {
      const ranged = await fetchText(`/api/labels/${encodeURIComponent(firstId)}/file`, { headers: { range: 'bytes=0-1023' } });
      if (ranged.status === 206) ok(`Range 請求回 206（${ranged.headers.get('content-range')}）`);
      else warn(`Range 回應 ${ranged.status}（舊版 Functions 會回 200，屬正常）`);
    }
  } else {
    info('線上目前沒有標籤，略過');
  }

  title('結論');
  if (failures) {
    console.log(`  ${C.red}有 ${failures} 個問題${C.reset}`);
    console.log(`  ${C.dim}回滾：git revert <部署的 commit> && git push origin ${BRANCH}${C.reset}`);
    return 1;
  }
  console.log(`  ${C.green}驗證通過${C.reset}`);
  console.log(`  ${C.dim}最後一步：用 iPhone Safari 開 ${URL_BASE}，選 174 個 PDF 確認進度卡片可暫停/繼續/重試${C.reset}`);
  return 0;
}

const commands = { check: cmdCheck, github: cmdGithub, wrangler: cmdWrangler, verify: cmdVerify };
if (!commands[command]) {
  console.log(`未知指令：${command}\n可用：${Object.keys(commands).join(' | ')}`);
  process.exit(2);
}

process.exit(await commands[command]());

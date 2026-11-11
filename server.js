// 天涯画廊（阿可 / Cloady 版）：零依赖 Node 接收端 + 画廊页。
// 与免费主机 PHP 版保持同一推送协议，管理站只需改推送地址域名：
//   POST /upload.php  multipart，字段 key / image / prompt / model / seed / width / height / created_at
//   成功返回 {"ok":true,"id":"...","url":"images/..."}，密钥错返回 403。
// 密钥只从环境变量 SHOWCASE_KEY 读，不写进代码和仓库。
// 图片与索引存在 DATA_DIR（Cloady 上挂持久卷，如 /data），默认 ./data。
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const IMAGE_DIR = path.join(DATA_DIR, 'images');
const GALLERY_FILE = path.join(DATA_DIR, 'gallery.json');
const SHOWCASE_KEY = process.env.SHOWCASE_KEY || '';
const MAX_ITEMS = 200;
const MAX_BYTES = 10 * 1024 * 1024;

fs.mkdirSync(IMAGE_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(GALLERY_FILE)) fs.writeFileSync(GALLERY_FILE, '[]');

function loadItems() {
  try {
    const d = JSON.parse(fs.readFileSync(GALLERY_FILE, 'utf8'));
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}
function saveItems(items) {
  const tmp = GALLERY_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(items, null, 2));
  fs.renameSync(tmp, GALLERY_FILE);
}
function esc(s) {
  return String(s ?? '').replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;').replace(/'/g, '&#39;');
}
function detectImage(buf) {
  if (buf.length >= 8 && buf[0] === 0x89 && buf[1] === 0x50 && buf[2] === 0x4e && buf[3] === 0x47) return { ext: 'png', mime: 'image/png' };
  if (buf.length >= 3 && buf[0] === 0xff && buf[1] === 0xd8 && buf[2] === 0xff) return { ext: 'jpg', mime: 'image/jpeg' };
  if (buf.length >= 12 && buf.toString('ascii', 0, 4) === 'RIFF' && buf.toString('ascii', 8, 12) === 'WEBP') return { ext: 'webp', mime: 'image/webp' };
  return null;
}
// 最小 multipart 解析：只处理本接口的字段 + 一个 image 文件。
function parseMultipart(buf, boundary) {
  const fields = {};
  let file = null;
  const sep = Buffer.from('--' + boundary);
  let pos = 0;
  while (true) {
    const start = buf.indexOf(sep, pos);
    if (start === -1) break;
    let p = start + sep.length;
    if (buf[p] === 0x2d && buf[p + 1] === 0x2d) break; // -- 结尾
    if (buf[p] === 0x0d && buf[p + 1] === 0x0a) p += 2;
    const headEnd = buf.indexOf(Buffer.from('\r\n\r\n'), p);
    if (headEnd === -1) break;
    const head = buf.toString('utf8', p, headEnd);
    const bodyStart = headEnd + 4;
    const next = buf.indexOf(sep, bodyStart);
    if (next === -1) break;
    let bodyEnd = next - 2; // 去掉前面的 \r\n
    if (bodyEnd < bodyStart) bodyEnd = bodyStart;
    const nameM = head.match(/name="([^"]+)"/);
    const fileM = head.match(/filename="([^"]*)"/);
    if (nameM) {
      if (fileM && fileM[1]) file = { field: nameM[1], filename: fileM[1], data: buf.subarray(bodyStart, bodyEnd) };
      else fields[nameM[1]] = buf.toString('utf8', bodyStart, bodyEnd);
    }
    pos = next;
  }
  return { fields, file };
}

function galleryHtml(items) {
  const count = items.length;
  const cards = items.map((it, i) => {
    const file = esc(it.file || '');
    const prompt = esc(it.prompt || '');
    const model = esc(it.model || '');
    const date = esc(String(it.created_at || '').slice(0, 16).replace('T', ' '));
    return `<article class="card" data-idx="${i}">
      <div class="thumb"><img src="${file}" alt="" loading="lazy"><div class="veil"><span>查看大图 · 提示词</span></div></div>
      <div class="meta"><div class="tags">${model ? `<span class="model">${model}</span>` : ''}<span class="date">${date}</span></div>
      <div class="prompt">${prompt}</div></div></article>`;
  }).join('\n');
  const body = count === 0
    ? `<div class="empty"><div class="glyph">🖼️</div><p>还没有图片。<br>在管理站生一张图，它就会自动出现在这里。</p></div>`
    : `<div class="grid">${cards}</div>`;
  const itemsJson = JSON.stringify(items).replace(/</g, '\\u003c');
  return `<!DOCTYPE html>
<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">
<title>天涯画廊</title><link rel="icon" type="image/svg+xml" href="favicon.svg"><style>
  * { box-sizing: border-box; margin: 0; padding: 0; }
  html { scroll-behavior: smooth; }
  body { background: #fafafa; color: #111827; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; -webkit-font-smoothing: antialiased; }
  a { color: inherit; }
  .nav { position: sticky; top: 0; z-index: 40; background: rgba(250,250,250,.85); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-bottom: 1px solid #ececec; }
  .nav-inner { max-width: 1280px; margin: 0 auto; padding: 0 24px; height: 60px; display: flex; align-items: center; justify-content: space-between; }
  .brand { display: flex; align-items: center; gap: 10px; text-decoration: none; }
  .brand img { width: 30px; height: 30px; border-radius: 8px; display: block; }
  .brand .name { font-size: 19px; font-weight: 700; letter-spacing: 2px; }
  .brand .sub { font-size: 12px; color: #9ca3af; letter-spacing: 3px; margin-left: 2px; }
  .nav-count { font-size: 13px; color: #6b7280; background: #f0f0f0; border: 1px solid #e5e5e5; padding: 5px 12px; border-radius: 999px; }
  .nav-count b { color: #111827; font-weight: 600; }
  .hero { max-width: 1280px; margin: 0 auto; padding: 56px 24px 8px; }
  .hero h1 { font-size: 40px; font-weight: 800; letter-spacing: 4px; line-height: 1.2; }
  .hero p { margin-top: 12px; font-size: 15px; line-height: 1.8; color: #6b7280; max-width: 560px; }
  .hero p b { color: #374151; font-weight: 600; }
  .grid { max-width: 1280px; margin: 0 auto; padding: 28px 24px 40px; columns: 4; column-gap: 18px; }
  @media (max-width: 1100px) { .grid { columns: 3; } }
  @media (max-width: 760px) { .grid { columns: 2; column-gap: 12px; padding: 20px 16px 32px; } .hero { padding: 36px 16px 4px; } .hero h1 { font-size: 30px; } }
  @media (max-width: 460px) { .grid { columns: 2; } }
  .card { break-inside: avoid; margin-bottom: 18px; border-radius: 14px; overflow: hidden; background: #fff; border: 1px solid #ececec; cursor: pointer; transition: box-shadow .2s ease, transform .2s ease; }
  .card:hover { box-shadow: 0 12px 32px rgba(0,0,0,.12); transform: translateY(-2px); }
  .card .thumb { position: relative; overflow: hidden; background: #f0f0f0; }
  .card .thumb img { width: 100%; display: block; transition: transform .35s ease; }
  .card:hover .thumb img { transform: scale(1.03); }
  .card .thumb .veil { position: absolute; inset: 0; background: linear-gradient(to top, rgba(0,0,0,.55), rgba(0,0,0,0) 55%); opacity: 0; transition: opacity .2s ease; display: flex; align-items: flex-end; padding: 12px 14px; }
  .card:hover .thumb .veil { opacity: 1; }
  .card .thumb .veil span { color: #fff; font-size: 12px; letter-spacing: 1px; }
  .card .meta { padding: 12px 14px 14px; }
  .card .tags { display: flex; gap: 8px; align-items: center; margin-bottom: 7px; }
  .card .model { background: #111827; color: #fff; font-size: 11px; font-weight: 600; letter-spacing: 1px; padding: 3px 9px; border-radius: 999px; }
  .card .date { color: #9ca3af; font-size: 12px; }
  .card .prompt { font-size: 13px; line-height: 1.65; color: #4b5563; display: -webkit-box; -webkit-line-clamp: 2; -webkit-box-orient: vertical; overflow: hidden; }
  .empty { max-width: 1280px; margin: 80px auto; padding: 0 24px; text-align: center; }
  .empty .glyph { font-size: 44px; margin-bottom: 14px; }
  .empty p { color: #9ca3af; font-size: 15px; line-height: 1.8; }
  footer { border-top: 1px solid #ececec; padding: 22px 24px 30px; text-align: center; color: #9ca3af; font-size: 12px; letter-spacing: 1px; }
  .lightbox { position: fixed; inset: 0; background: rgba(17,24,39,.92); display: none; align-items: center; justify-content: center; z-index: 100; padding: 24px; }
  .lightbox.open { display: flex; }
  .lb-inner { max-width: 1020px; width: 100%; max-height: 92vh; overflow: auto; background: #fff; color: #111827; border-radius: 18px; box-shadow: 0 24px 80px rgba(0,0,0,.45); }
  .lb-inner img { width: 100%; display: block; background: #f0f0f0; }
  .lb-body { padding: 20px 24px 24px; }
  .lb-body .tags { display: flex; gap: 10px; align-items: center; margin-bottom: 12px; flex-wrap: wrap; }
  .lb-body .model { background: #111827; color: #fff; font-size: 12px; font-weight: 600; letter-spacing: 1px; padding: 3px 10px; border-radius: 999px; }
  .lb-body .date, .lb-body .seed, .lb-body .size { color: #9ca3af; font-size: 12px; }
  .lb-body .prompt { font-size: 14.5px; line-height: 1.9; color: #1f2937; white-space: pre-wrap; word-break: break-word; }
  .lb-actions { display: flex; gap: 10px; margin-top: 18px; flex-wrap: wrap; }
  .lb-actions a, .lb-actions button { background: #111827; color: #fff; border: none; border-radius: 999px; padding: 9px 20px; font-size: 13px; cursor: pointer; text-decoration: none; font-weight: 600; letter-spacing: 1px; }
  .lb-actions button.ghost { background: #f3f4f6; color: #374151; }
  .lb-close { position: fixed; top: 18px; right: 18px; width: 42px; height: 42px; border-radius: 50%; background: rgba(255,255,255,.14); color: #fff; border: 1px solid rgba(255,255,255,.35); font-size: 22px; line-height: 1; cursor: pointer; z-index: 110; }
  .lb-close:hover { background: rgba(255,255,255,.28); }
</style></head><body>
<nav class="nav"><div class="nav-inner">
  <a class="brand" href="./"><img src="favicon.svg" alt=""><span class="name">天涯画廊</span><span class="sub">GALLERY</span></a>
  <span class="nav-count">共 <b>${count}</b> 张</span>
</div></nav>
<div class="hero"><h1>天涯画廊</h1><p>每一次生图，都在这里。原图直出，附完整提示词，<b>点任意一张图</b>查看大图与提示词。</p></div>
${body}
<footer>天涯画廊 · 图片由管理站生图自动推送 · 原图直出</footer>
<div class="lightbox" id="lightbox"><button class="lb-close" id="lbClose" aria-label="关闭">×</button>
  <div class="lb-inner"><img id="lbImg" src="" alt=""><div class="lb-body">
    <div class="tags"><span class="model" id="lbModel"></span><span class="date" id="lbDate"></span><span class="seed" id="lbSeed"></span><span class="size" id="lbSize"></span></div>
    <div class="prompt" id="lbPrompt"></div>
    <div class="lb-actions"><a id="lbDownload" href="" download>保存原图</a><button class="ghost" id="lbCopy">复制提示词</button></div>
  </div></div></div>
<script>
const ITEMS = ${itemsJson};
const lb = document.getElementById('lightbox');
function openLb(i) {
  const it = ITEMS[i]; if (!it) return;
  document.getElementById('lbImg').src = it.file;
  const m = document.getElementById('lbModel'); m.textContent = it.model || ''; m.style.display = it.model ? '' : 'none';
  document.getElementById('lbDate').textContent = (it.created_at || '').slice(0, 16).replace('T', ' ');
  document.getElementById('lbSeed').textContent = it.seed ? ('种子 ' + it.seed) : '';
  document.getElementById('lbSize').textContent = (it.width && it.height) ? (it.width + ' × ' + it.height) : '';
  document.getElementById('lbPrompt').textContent = it.prompt || '';
  document.getElementById('lbDownload').href = it.file;
  lb.classList.add('open'); document.body.style.overflow = 'hidden';
}
function closeLb() { lb.classList.remove('open'); document.body.style.overflow = ''; }
document.querySelectorAll('.card').forEach(function (card) { card.addEventListener('click', function () { openLb(parseInt(card.dataset.idx, 10)); }); });
document.getElementById('lbClose').addEventListener('click', closeLb);
lb.addEventListener('click', function (e) { if (e.target === lb) closeLb(); });
document.addEventListener('keydown', function (e) { if (e.key === 'Escape') closeLb(); });
document.getElementById('lbCopy').addEventListener('click', function () {
  const t = document.getElementById('lbPrompt').textContent; const btn = document.getElementById('lbCopy');
  function done(msg) { btn.textContent = msg; setTimeout(function () { btn.textContent = '复制提示词'; }, 1500); }
  if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t).then(function () { done('已复制 ✓'); }, function () { done('复制失败'); }); }
  else { const ta = document.createElement('textarea'); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand('copy'); done('已复制 ✓'); } catch (e) { done('复制失败'); } document.body.removeChild(ta); }
});
</script></body></html>`;
}

function sendJson(res, code, obj) {
  res.writeHead(code, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(obj));
}
function readBody(req, limit) {
  return new Promise((resolve, reject) => {
    const chunks = []; let size = 0;
    req.on('data', c => { size += c.length; if (size > limit) { reject(new Error('too large')); req.destroy(); } else chunks.push(c); });
    req.on('end', () => resolve(Buffer.concat(chunks)));
    req.on('error', reject);
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/health') return sendJson(res, 200, { ok: true, service: 'tianya-gallery', time: new Date().toISOString() });
    if (req.method === 'GET' && p === '/api/gallery') return sendJson(res, 200, { ok: true, items: loadItems() });
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(galleryHtml(loadItems()));
    }
    if (req.method === 'GET' && p === '/favicon.svg') {
      const f = path.join(__dirname, 'favicon.svg');
      res.writeHead(200, { 'Content-Type': 'image/svg+xml' });
      return res.end(fs.readFileSync(f));
    }
    if (req.method === 'GET' && p.startsWith('/images/')) {
      const name = path.basename(p);
      const f = path.join(IMAGE_DIR, name);
      if (!fs.existsSync(f)) return sendJson(res, 404, { ok: false, error: 'not found' });
      const buf = fs.readFileSync(f);
      const det = detectImage(buf);
      res.writeHead(200, { 'Content-Type': det ? det.mime : 'application/octet-stream', 'Cache-Control': 'public, max-age=86400' });
      return res.end(buf);
    }
    if (req.method === 'POST' && (p === '/upload.php' || p === '/upload')) {
      if (!SHOWCASE_KEY) return sendJson(res, 500, { ok: false, error: '服务端未配置推送密钥' });
      const ct = req.headers['content-type'] || '';
      const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/);
      if (!m) return sendJson(res, 400, { ok: false, error: '需要 multipart 表单' });
      const body = await readBody(req, MAX_BYTES + 1024 * 1024);
      const { fields, file } = parseMultipart(body, (m[1] || m[2]).trim());
      const key = String(fields.key || '');
      const a = Buffer.from(key), b = Buffer.from(SHOWCASE_KEY);
      if (a.length !== b.length || !crypto.timingSafeEqual(a, b)) return sendJson(res, 403, { ok: false, error: '密钥不对' });
      if (!file || !file.data || file.data.length === 0) return sendJson(res, 400, { ok: false, error: '没有收到图片文件' });
      if (file.data.length > MAX_BYTES) return sendJson(res, 400, { ok: false, error: '图片大小超出限制' });
      const det = detectImage(file.data);
      if (!det) return sendJson(res, 400, { ok: false, error: '不是有效图片，只接受 PNG / JPG / WebP' });
      const id = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '') + '-' + crypto.randomBytes(4).toString('hex');
      // 上面日期串形如 20261111-112233，去掉多余字符后仍唯一（加随机后缀）
      const filename = id + '.' + det.ext;
      fs.writeFileSync(path.join(IMAGE_DIR, filename), file.data);
      const entry = {
        id, file: 'images/' + filename,
        prompt: String(fields.prompt || '').trim(),
        model: String(fields.model || '').trim(),
        seed: String(fields.seed || '').trim(),
        width: parseInt(fields.width || '0', 10) || undefined,
        height: parseInt(fields.height || '0', 10) || undefined,
        created_at: String(fields.created_at || '').trim() || new Date().toISOString(),
      };
      const items = loadItems();
      items.unshift(entry);
      while (items.length > MAX_ITEMS) {
        const old = items.pop();
        if (old && old.file) { const fp = path.join(DATA_DIR, path.basename(old.file)); if (fs.existsSync(fp)) fs.unlinkSync(fp); }
      }
      saveItems(items);
      return sendJson(res, 200, { ok: true, id, url: 'images/' + filename });
    }
    return sendJson(res, 404, { ok: false, error: 'not found' });
  } catch (e) {
    if (e && e.message === 'too large') return sendJson(res, 413, { ok: false, error: '图片大小超出限制' });
    console.error(e);
    return sendJson(res, 500, { ok: false, error: 'server error' });
  }
});

server.listen(PORT, '0.0.0.0', () => console.log('tianya-gallery listening on ' + PORT + ' data=' + DATA_DIR));

// 天涯画廊（阿可 / Cloady 版）：零依赖 Node 接收端 + 画廊页。
// 版面复刻 https://shisei.indaloop.app/costume/：暖米白底、胶囊筛选、6 列卡片、
// 点图开二级详情弹窗（背景一级页面模糊），顶部四板块：提示词 / 图片 / 工作流分享 / 管理。
// 推送协议与免费主机 PHP 版一致，管理站只需改推送地址域名：
//   POST /upload.php  multipart，字段 key / image / prompt / model / seed / width / height / created_at
//   成功返回 {"ok":true,"id":"...","url":"images/..."}，密钥错返回 403。
// 密钥只从环境变量 SHOWCASE_KEY 读，不写进代码和仓库。
// 图片与索引存在 DATA_DIR（Cloady 上挂持久卷，如 /data），默认 ./data。
// 工作流分享：任何人可上传 ComfyUI 工作流 JSON（POST /api/workflow/upload，2MB 以内），
// 列表见 GET /api/workflows，文件走 GET /workflows/<文件> 下载。
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

const PORT = parseInt(process.env.PORT || '3000', 10);
const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const IMAGE_DIR = path.join(DATA_DIR, 'images');
const GALLERY_FILE = path.join(DATA_DIR, 'gallery.json');
const WORKFLOW_DIR = path.join(DATA_DIR, 'workflows');
const WORKFLOWS_FILE = path.join(DATA_DIR, 'workflows.json');
const SHOWCASE_KEY = process.env.SHOWCASE_KEY || '';
const MAX_ITEMS = 200;
const MAX_BYTES = 10 * 1024 * 1024;
const MAX_FLOW_BYTES = 2 * 1024 * 1024;

fs.mkdirSync(IMAGE_DIR, { recursive: true });
fs.mkdirSync(WORKFLOW_DIR, { recursive: true });
fs.mkdirSync(DATA_DIR, { recursive: true });
if (!fs.existsSync(GALLERY_FILE)) fs.writeFileSync(GALLERY_FILE, '[]');
if (!fs.existsSync(WORKFLOWS_FILE)) fs.writeFileSync(WORKFLOWS_FILE, '[]');

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
function loadFlows() {
  try {
    const d = JSON.parse(fs.readFileSync(WORKFLOWS_FILE, 'utf8'));
    return Array.isArray(d) ? d : [];
  } catch { return []; }
}
function saveFlows(flows) {
  const tmp = WORKFLOWS_FILE + '.tmp';
  fs.writeFileSync(tmp, JSON.stringify(flows, null, 2));
  fs.renameSync(tmp, WORKFLOWS_FILE);
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
// 最小 multipart 解析：只处理本接口的字段 + 一个文件。
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

// 站长实测的工作流配置（非文件，仅参数卡片，可复制参数文本）
const BUILTIN_FLOWS = [
  { name: 'MOSS-Image · 文生图', model: 'MOSS-Image', tag: '站长实测', desc: 'OpenMOSS 5B DiT，ComfyUI 原生支持，长提示词不截断。', params: 'MOSS-Image (OpenMOSS 5B DiT)，ComfyUI 原生，25 步，CFG 2.5，默认 1696×2122（768×1024 的 2.2 倍），Kaggle T4 x2 免费跑通。' },
  { name: 'Qwen Image 2.1 Turbo · 文生图 / 编辑', model: 'Qwen Image 2.1 Turbo', tag: '站长实测', desc: '7B 统一 DiT，生图和编辑同一个模型，原生 2K。', params: 'Qwen Image 2.1 Turbo，8 步，CFG 1，euler，Turbo int8 模型，编辑跟原图分辨率走（resolution 0），Kaggle T4 x2 免费跑通。' },
  { name: 'Krea2 Turbo · 文生图', model: 'Krea2', tag: '站长实测', desc: '12.9B，GGUF Q5_K_M 量化，Turbo 8 步蒸馏。', params: 'Krea2 Turbo GGUF Q5_K_M，8 步，CFG 1，euler / simple，1024×1024，采样约 120 秒，Kaggle T4 x2 免费跑通。' },
];

function galleryHtml(items, flows) {
  const count = items.length;
  const models = [];
  items.forEach(function (it) { if (it.model && models.indexOf(it.model) === -1) models.push(it.model); });
  const capsules = ['全部'].concat(models).map(function (m, i) {
    const n = m === '全部' ? count : items.filter(function (it) { return it.model === m; }).length;
    return '<button class="cap' + (i === 0 ? ' on' : '') + '" data-model="' + esc(m) + '">' + esc(m) + ' <span>' + n + '</span></button>';
  }).join('\n');
  const cards = items.map(function (it, i) {
    const file = esc(it.file || '');
    const prompt = esc(it.prompt || '');
    const model = esc(it.model || '');
    const date = esc(String(it.created_at || '').slice(0, 10));
    const title = (it.prompt || '').trim().slice(0, 24) || model || '无标题';
    return '<article class="card" data-idx="' + i + '" data-id="' + esc(it.id || '') + '" data-model="' + model + '">'
      + '<button class="del-btn" data-id="' + esc(it.id || '') + '" aria-label="删除这张图">×</button>'
      + '<div class="thumb"><img src="' + file + '" alt="" loading="lazy"></div>'
      + '<div class="card-t">' + esc(title) + '</div>'
      + '<div class="card-m">' + model + (model && date ? ' · ' : '') + date + '</div></article>';
  }).join('\n');
  const promptCards = items.map(function (it, i) {
    const model = esc(it.model || '');
    const date = esc(String(it.created_at || '').slice(0, 10));
    return '<article class="pcard" data-idx="' + i + '"><div class="ptags"><span class="model">' + model + '</span><span class="date">' + date + '</span></div>'
      + '<div class="ptext">' + esc(it.prompt || '（无提示词）') + '</div>'
      + '<button class="copy-btn" data-idx="' + i + '">复制提示词</button></article>';
  }).join('\n');
  const flowCards = flows.map(function (fl) {
    return '<article class="fcard">' + (fl.id ? '<button class="flow-del" data-fid="' + esc(fl.id) + '" title="删除这个工作流">×</button>' : '') + '<div class="ftags"><span class="model">' + esc(fl.model || 'ComfyUI') + '</span>'
      + (fl.author ? '<span class="author">' + esc(fl.author) + '</span>' : '') + '<span class="date">' + esc(String(fl.created_at || '').slice(0, 10)) + '</span></div>'
      + '<div class="fname">' + esc(fl.name || '未命名工作流') + '</div>'
      + (fl.description ? '<div class="fdesc">' + esc(fl.description) + '</div>' : '')
      + '<div class="factions"><a class="dl-btn" href="' + esc(fl.file || '') + '" download>下载 JSON</a>'
      + '<button class="copy-flow" data-file="' + esc(fl.file || '') + '">复制 JSON</button></div></article>';
  }).join('\n');
  const builtinCards = BUILTIN_FLOWS.map(function (fl) {
    return '<article class="fcard builtin"><div class="ftags"><span class="model">' + esc(fl.model) + '</span><span class="tag">' + esc(fl.tag) + '</span></div>'
      + '<div class="fname">' + esc(fl.name) + '</div>'
      + '<div class="fdesc">' + esc(fl.desc) + '</div>'
      + '<div class="factions"><button class="copy-params" data-params="' + esc(fl.params) + '">复制参数</button></div></article>';
  }).join('\n');
  const gridBody = count === 0
    ? '<div class="empty"><div class="glyph">🖼️</div><p>还没有图片。<br>在管理站生一张图，它就会自动出现在这里。</p></div>'
    : '<div class="grid">' + cards + '</div>';
  const promptsBody = count === 0
    ? '<div class="empty"><div class="glyph">💬</div><p>还没有提示词。<br>图片出现后，它的提示词会在这里列出来。</p></div>'
    : '<div class="plist">' + promptCards + '</div>';
  const flowsBody = '<div class="flist">' + builtinCards + flowCards + '</div>'
    + (flows.length === 0 ? '<div class="empty small"><p>还没有人分享工作流，点击右上角「＋ 上传工作流」，分享第一个。</p></div>' : '');
  const itemsJson = JSON.stringify(items).replace(/</g, '\\u003c');
  return '<!DOCTYPE html>\n'
    + '<html lang="zh-CN"><head><meta charset="utf-8"><meta name="viewport" content="width=device-width, initial-scale=1">\n'
    + '<title>天涯画廊</title><link rel="icon" type="image/svg+xml" href="favicon.svg"><style>\n'
    + '  * { box-sizing: border-box; margin: 0; padding: 0; }\n'
    + '  html { scroll-behavior: smooth; }\n'
    + '  body { background: #f7f2e9; color: #1c1917; font-family: -apple-system, BlinkMacSystemFont, "PingFang SC", "Hiragino Sans GB", "Microsoft YaHei", sans-serif; -webkit-font-smoothing: antialiased; }\n'
    + '  a { color: inherit; }\n'
    + '  button { font-family: inherit; }\n'
    + '  .nav { position: sticky; top: 0; z-index: 40; background: rgba(247,242,233,.88); backdrop-filter: blur(12px); -webkit-backdrop-filter: blur(12px); border-bottom: 1px solid #e8e0d2; }\n'
    + '  .nav-inner { max-width: 1240px; margin: 0 auto; padding: 0 24px; height: 60px; display: flex; align-items: center; justify-content: space-between; gap: 16px; }\n'
    + '  .brand { display: flex; align-items: center; gap: 10px; text-decoration: none; flex-shrink: 0; }\n'
    + '  .brand .mark { width: 32px; height: 32px; border-radius: 9px; background: #1c1917; color: #f7f2e9; display: flex; align-items: center; justify-content: center; font-size: 17px; font-weight: 800; }\n'
    + '  .brand .name { font-size: 19px; font-weight: 800; letter-spacing: 2px; }\n'
    + '  .tabs { display: flex; gap: 4px; background: #efe8db; border-radius: 999px; padding: 4px; }\n'
    + '  .tab { border: none; background: transparent; color: #57534e; font-size: 14px; font-weight: 600; padding: 7px 16px; border-radius: 999px; cursor: pointer; letter-spacing: 1px; white-space: nowrap; }\n'
    + '  .tab.on { background: #1c1917; color: #faf7f0; }\n'
    + '  .nav-count { font-size: 13px; color: #78716c; background: #fff; border: 1px solid #e8e0d2; padding: 5px 12px; border-radius: 999px; white-space: nowrap; }\n'
    + '  .nav-count b { color: #1c1917; font-weight: 700; }\n'
    + '  .wrap { max-width: 1240px; margin: 0 auto; padding: 0 24px; }\n'
    + '  .crumbs { padding: 26px 0 0; font-size: 13px; color: #a8a29e; letter-spacing: 1px; }\n'
    + '  .hero { padding: 10px 0 4px; }\n'
    + '  .hero h1 { font-size: 38px; font-weight: 800; letter-spacing: 2px; line-height: 1.2; }\n'
    + '  .hero p { margin-top: 10px; font-size: 14px; line-height: 1.8; color: #78716c; max-width: 620px; }\n'
    + '  .filters { display: flex; flex-wrap: wrap; gap: 10px; align-items: center; padding: 22px 0 6px; }\n'
    + '  .cap { border: 1px solid #d6cfbf; background: #fff; color: #44403c; font-size: 13px; font-weight: 600; padding: 8px 16px; border-radius: 999px; cursor: pointer; }\n'
    + '  .cap span { color: #a8a29e; font-weight: 500; margin-left: 2px; }\n'
    + '  .cap.on { background: #1c1917; border-color: #1c1917; color: #faf7f0; }\n'
    + '  .cap.on span { color: #d6d3d1; }\n'
    + '  .filters .fcount { margin-left: auto; font-size: 13px; color: #a8a29e; }\n'
    + '  .grid { padding: 20px 0 48px; display: grid; grid-template-columns: repeat(6, 1fr); gap: 20px 16px; }\n'
    + '  @media (max-width: 1100px) { .grid { grid-template-columns: repeat(4, 1fr); } }\n'
    + '  @media (max-width: 760px) { .grid { grid-template-columns: repeat(3, 1fr); gap: 14px 10px; } .hero h1 { font-size: 28px; } .tabs { overflow-x: auto; } .nav-inner { padding: 0 14px; } .wrap { padding: 0 14px; } }\n'
    + '  @media (max-width: 460px) { .grid { grid-template-columns: repeat(2, 1fr); } }\n'
    + '  .card { position: relative; cursor: pointer; }\n'
    + '  .card .thumb { border-radius: 16px; overflow: hidden; background: #e7e5e4; aspect-ratio: 3 / 4; }\n'
    + '  .card .thumb img { width: 100%; height: 100%; object-fit: cover; display: block; transition: transform .35s ease; }\n'
    + '  .card:hover .thumb img { transform: scale(1.04); }\n'
    + '  .card-t { margin-top: 10px; font-size: 14px; font-weight: 700; line-height: 1.5; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n'
    + '  .card-m { margin-top: 3px; font-size: 12px; color: #a8a29e; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }\n'
    + '  .card .del-btn { display: none; position: absolute; top: 10px; right: 10px; z-index: 5; width: 30px; height: 30px; border-radius: 50%; border: none; background: rgba(28,25,23,.85); color: #fff; font-size: 18px; line-height: 1; cursor: pointer; }\n'
    + '  .card .del-btn:hover { background: #dc2626; }\n'
    + '  body.manage .card .del-btn { display: block; }\n'
    + '  body.manage .card { cursor: default; }\n'
    + '  .plist { padding: 20px 0 48px; display: grid; grid-template-columns: repeat(2, 1fr); gap: 16px; }\n'
    + '  @media (max-width: 760px) { .plist { grid-template-columns: 1fr; } }\n'
    + '  .pcard { background: #fff; border: 1px solid #e8e0d2; border-radius: 16px; padding: 18px 20px; }\n'
    + '  .ptags { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; }\n'
    + '  .model { background: #1c1917; color: #fff; font-size: 11px; font-weight: 600; letter-spacing: 1px; padding: 3px 9px; border-radius: 999px; }\n'
    + '  .date, .author, .tag { color: #a8a29e; font-size: 12px; }\n'
    + '  .ptext { font-size: 14px; line-height: 1.9; color: #292524; white-space: pre-wrap; word-break: break-word; max-height: 190px; overflow: auto; }\n'
    + '  .copy-btn, .copy-flow, .copy-params { margin-top: 14px; background: #1c1917; color: #fff; border: none; border-radius: 999px; padding: 8px 18px; font-size: 13px; font-weight: 600; cursor: pointer; letter-spacing: 1px; }\n'
    + '  .copy-btn:hover, .copy-flow:hover, .copy-params:hover { background: #44403c; }\n'
    + '  .flow-head { display: flex; justify-content: space-between; align-items: center; padding: 22px 0 6px; }\n'
    + '  .upload-btn { background: #1c1917; color: #faf7f0; border: none; border-radius: 999px; padding: 10px 20px; font-size: 14px; font-weight: 700; cursor: pointer; letter-spacing: 1px; }\n'
    + '  .upload-btn:hover { background: #44403c; }\n'
    + '  .flist { padding: 14px 0 48px; display: grid; grid-template-columns: repeat(3, 1fr); gap: 16px; }\n'
    + '  @media (max-width: 900px) { .flist { grid-template-columns: repeat(2, 1fr); } }\n'
    + '  @media (max-width: 560px) { .flist { grid-template-columns: 1fr; } }\n'
    + '  .fcard { background: #fff; border: 1px solid #e8e0d2; border-radius: 16px; padding: 18px 20px; }\n'
    + '  .fcard.builtin { background: #fffbeb; }\n'
    + '  .ftags { display: flex; gap: 8px; align-items: center; margin-bottom: 10px; flex-wrap: wrap; }\n'
    + '  .fname { font-size: 16px; font-weight: 800; line-height: 1.5; }\n'
    + '  .fdesc { margin-top: 8px; font-size: 13px; line-height: 1.8; color: #57534e; }\n'
    + '  .factions { display: flex; gap: 10px; margin-top: 14px; flex-wrap: wrap; }\n'
    + '  .dl-btn { background: #1c1917; color: #fff; border-radius: 999px; padding: 8px 18px; font-size: 13px; font-weight: 600; text-decoration: none; letter-spacing: 1px; }\n'
    + '  .copy-flow, .copy-params { background: #f5f5f4; color: #44403c; border: 1px solid #e7e5e4; }\n'
    + '  .manage-banner { display: none; margin: 18px 0 0; background: #fef3c7; border: 1px solid #fcd34d; color: #92400e; border-radius: 12px; padding: 12px 16px; font-size: 13px; line-height: 1.7; }\n'
    + '  body.manage .manage-banner { display: block; }\n'
    + '  .fcard { position: relative; }\n'
    + '  .flow-del { display: none; position: absolute; top: 10px; right: 10px; width: 26px; height: 26px; border-radius: 50%; border: none; background: rgba(28,25,23,.85); color: #fff; font-size: 16px; line-height: 1; cursor: pointer; z-index: 2; }\n'
    + '  body.manage .flow-del { display: block; }\n'
    + '  .key-err { display: none; color: #dc2626; font-size: 13px; margin-top: 8px; }\n'
    + '  .key-err.on { display: block; }\n'
    + '  .empty { margin: 60px auto; padding: 0 24px; text-align: center; }\n'
    + '  .empty.small { margin: 10px auto 40px; }\n'
    + '  .empty .glyph { font-size: 44px; margin-bottom: 14px; }\n'
    + '  .empty p { color: #a8a29e; font-size: 15px; line-height: 1.8; }\n'
    + '  footer { border-top: 1px solid #e8e0d2; padding: 22px 24px 30px; text-align: center; color: #a8a29e; font-size: 12px; letter-spacing: 1px; }\n'
    + '  .view { display: none; }\n'
    + '  .view.on { display: block; }\n'
    + '  .overlay { position: fixed; inset: 0; z-index: 100; display: none; align-items: center; justify-content: center; padding: 20px; background: rgba(28,25,23,.55); backdrop-filter: blur(14px); -webkit-backdrop-filter: blur(14px); }\n'
    + '  .overlay.open { display: flex; }\n'
    + '  .modal { background: #fff; border-radius: 24px; width: 100%; max-width: 1080px; max-height: 92vh; overflow: hidden; display: flex; box-shadow: 0 24px 80px rgba(0,0,0,.35); }\n'
    + '  @media (max-width: 820px) { .modal { flex-direction: column; overflow: auto; } }\n'
    + '  .m-left { flex: 6; background: #e7e5e4; position: relative; display: flex; align-items: center; justify-content: center; min-height: 320px; padding: 24px; }\n'
    + '  .m-left img { max-width: 100%; max-height: 78vh; border-radius: 18px; display: block; object-fit: contain; }\n'
    + '  .m-pill { position: absolute; top: 18px; left: 18px; background: #fef9c3; color: #854d0e; font-size: 12px; font-weight: 700; padding: 6px 12px; border-radius: 999px; letter-spacing: 1px; }\n'
    + '  .m-arrow { position: absolute; top: 50%; transform: translateY(-50%); width: 44px; height: 44px; border-radius: 50%; border: none; background: rgba(255,255,255,.92); color: #1c1917; font-size: 20px; cursor: pointer; box-shadow: 0 4px 16px rgba(0,0,0,.18); }\n'
    + '  .m-arrow:hover { background: #fff; }\n'
    + '  .m-prev { left: 16px; } .m-next { right: 16px; }\n'
    + '  .m-right { flex: 4; padding: 26px 26px 20px; overflow-y: auto; max-height: 92vh; }\n'
    + '  .m-meta { font-size: 12px; color: #a8a29e; letter-spacing: 1px; }\n'
    + '  .m-title { margin-top: 10px; font-size: 26px; font-weight: 800; line-height: 1.35; word-break: break-word; }\n'
    + '  .m-rows { margin-top: 16px; }\n'
    + '  .m-row { display: flex; gap: 12px; padding: 7px 0; border-bottom: 1px solid #f5f5f4; font-size: 13px; }\n'
    + '  .m-row .k { color: #a8a29e; width: 52px; flex-shrink: 0; }\n'
    + '  .m-row .v { color: #1c1917; word-break: break-word; }\n'
    + '  .m-big { display: block; width: 100%; margin-top: 20px; background: #1c1917; color: #fff; border: none; border-radius: 999px; padding: 14px; font-size: 15px; font-weight: 700; cursor: pointer; letter-spacing: 2px; }\n'
    + '  .m-big:hover { background: #44403c; }\n'
    + '  .m-rowbtns { display: flex; gap: 10px; margin-top: 12px; align-items: center; }\n'
    + '  .m-round { width: 44px; height: 44px; flex-shrink: 0; border-radius: 50%; border: 1px solid #d6d3d1; background: #fff; color: #1c1917; font-size: 17px; cursor: pointer; }\n'
    + '  .m-round:hover { border-color: #1c1917; }\n'
    + '  .m-dl { flex: 1; border: 1px solid #d6d3d1; background: #fff; color: #1c1917; border-radius: 999px; padding: 12px 10px; font-size: 13px; font-weight: 700; cursor: pointer; text-decoration: none; text-align: center; letter-spacing: 1px; }\n'
    + '  .m-dl:hover { border-color: #1c1917; }\n'
    + '  .m-half { flex: 1; border: 1px solid #d6d3d1; background: #fff; color: #1c1917; border-radius: 999px; padding: 11px 10px; font-size: 13px; font-weight: 600; cursor: pointer; letter-spacing: 1px; }\n'
    + '  .m-half:hover { border-color: #1c1917; }\n'
    + '  .m-half.danger { border-color: #fecaca; color: #dc2626; display: none; }\n'
    + '  body.manage .m-half.danger { display: block; }\n'
    + '  .m-desc { margin-top: 18px; background: #f5f5f4; border-radius: 14px; padding: 16px 18px; }\n'
    + '  .m-desc-head { display: flex; justify-content: space-between; align-items: center; margin-bottom: 10px; }\n'
    + '  .m-desc-head span { font-size: 12px; color: #78716c; letter-spacing: 1px; }\n'
    + '  .m-desc-head button { border: 1px solid #d6d3d1; background: #fff; border-radius: 999px; padding: 5px 12px; font-size: 12px; cursor: pointer; }\n'
    + '  .m-desc-body { font-size: 13.5px; line-height: 1.9; color: #292524; white-space: pre-wrap; word-break: break-word; max-height: 220px; overflow: auto; }\n'
    + '  .m-hint { margin-top: 16px; text-align: center; font-size: 12px; color: #a8a29e; letter-spacing: 1px; }\n'
    + '  .m-close { position: fixed; top: 18px; right: 18px; width: 44px; height: 44px; border-radius: 50%; background: rgba(255,255,255,.92); color: #1c1917; border: none; font-size: 22px; line-height: 1; cursor: pointer; z-index: 110; box-shadow: 0 4px 16px rgba(0,0,0,.2); }\n'
    + '  .form-overlay { position: fixed; inset: 0; z-index: 120; display: none; align-items: center; justify-content: center; padding: 20px; background: rgba(28,25,23,.55); backdrop-filter: blur(10px); -webkit-backdrop-filter: blur(10px); }\n'
    + '  .form-overlay.open { display: flex; }\n'
    + '  .form-box { background: #fff; border-radius: 20px; width: 100%; max-width: 520px; padding: 26px 26px 22px; max-height: 92vh; overflow: auto; }\n'
    + '  .form-box h2 { font-size: 20px; font-weight: 800; letter-spacing: 1px; }\n'
    + '  .form-box label { display: block; margin-top: 16px; font-size: 13px; font-weight: 600; color: #44403c; }\n'
    + '  .form-box input[type=text], .form-box select, .form-box textarea { width: 100%; margin-top: 6px; border: 1px solid #d6d3d1; border-radius: 10px; padding: 10px 12px; font-size: 14px; font-family: inherit; background: #fff; }\n'
    + '  .form-box textarea { min-height: 84px; resize: vertical; }\n'
    + '  .form-box .hint { margin-top: 6px; font-size: 12px; color: #a8a29e; line-height: 1.6; }\n'
    + '  .form-actions { display: flex; gap: 10px; margin-top: 20px; }\n'
    + '  .form-actions button { flex: 1; border-radius: 999px; padding: 12px; font-size: 14px; font-weight: 700; cursor: pointer; }\n'
    + '  .form-actions .submit { background: #1c1917; color: #fff; border: none; }\n'
    + '  .form-actions .cancel { background: #f5f5f4; color: #44403c; border: 1px solid #e7e5e4; }\n'
    + '</style></head><body>\n'
    + '<nav class="nav"><div class="nav-inner">\n'
    + '  <a class="brand" href="./"><span class="mark">画</span><span class="name">天涯画廊</span></a>\n'
    + '  <div class="tabs"><button class="tab" data-tab="prompts">提示词</button><button class="tab on" data-tab="images">图片</button><button class="tab" data-tab="flows">工作流分享</button><button class="tab" data-tab="manage">管理</button></div>\n'
    + '  <span class="nav-count">共 <b id="navCount">' + count + '</b> 张</span>\n'
    + '</div></nav>\n'
    + '<div class="wrap">\n'
    + '  <div class="crumbs">天涯画廊 / <span id="crumb">图片</span></div>\n'
    + '  <div class="hero"><h1 id="heroTitle">图片 · ' + count + ' 张</h1><p id="heroDesc">每一次生图，都在这里。原图直出，附完整提示词，点任意一张图查看大图与提示词。</p></div>\n'
    + '  <div class="view on" id="view-images">\n'
    + '    <div class="manage-banner">管理模式已开启：点图片右上角的 × 可以删除，删除后无法恢复。点顶栏「管理」可退出。</div>\n'
    + '    <div class="filters">' + capsules + '<span class="fcount"><b id="fcount">' + count + '</b> / ' + count + '</span></div>\n'
    + gridBody + '\n'
    + '  </div>\n'
    + '  <div class="view" id="view-prompts">\n'
    + promptsBody + '\n'
    + '  </div>\n'
    + '  <div class="view" id="view-flows">\n'
    + '    <div class="flow-head"><span></span><button class="upload-btn" id="uploadBtn">＋ 上传工作流</button></div>\n'
    + flowsBody + '\n'
    + '  </div>\n'
    + '</div>\n'
    + '<footer>天涯画廊 · 图片由管理站生图自动推送 · 原图直出</footer>\n'
    + '<div class="overlay" id="overlay"><button class="m-close" id="mClose" aria-label="关闭">×</button>\n'
    + '  <div class="modal"><div class="m-left"><span class="m-pill" id="mPill"></span><img id="mImg" src="" alt=""><button class="m-arrow m-prev" id="mPrev" aria-label="上一张">〈</button><button class="m-arrow m-next" id="mNext" aria-label="下一张">〉</button></div>\n'
    + '  <div class="m-right"><div class="m-meta" id="mMeta"></div><div class="m-title" id="mTitle"></div>\n'
    + '    <div class="m-rows"><div class="m-row"><span class="k">模型</span><span class="v" id="mModel"></span></div><div class="m-row"><span class="k">尺寸</span><span class="v" id="mSize"></span></div><div class="m-row"><span class="k">种子</span><span class="v" id="mSeed"></span></div><div class="m-row"><span class="k">时间</span><span class="v" id="mDate"></span></div></div>\n'
    + '    <button class="m-big" id="mCopy">复制提示词</button>\n'
    + '    <div class="m-rowbtns"><button class="m-round" id="mUp" title="上一张">↑</button><button class="m-round" id="mDown" title="下一张">↓</button><a class="m-dl" id="mDownload" href="" download>⭳ 下载原图</a></div>\n'
    + '    <div class="m-rowbtns"><button class="m-half" id="mShare">分享</button><button class="m-half" id="mManage">管理</button><button class="m-half danger" id="mDelete">删除这张图</button></div>\n'
    + '    <div class="m-desc"><div class="m-desc-head"><span>提示词，可直接放进生图</span><button id="mCopy2">复制</button></div><div class="m-desc-body" id="mPrompt"></div></div>\n'
    + '    <div class="m-hint">← → 换一张&nbsp;&nbsp;↑ ↓ 换一张&nbsp;&nbsp;Esc 关闭</div>\n'
    + '  </div></div></div>\n'
    + '<div class="form-overlay" id="keyModal"><div class="form-box"><h2>管理密钥</h2>\n'
+ '  <p class="hint" style="margin-bottom:14px">输入推送密钥（与管理站推送密钥相同），进入管理后可删除图片和工作流。</p>\n'
+ '  <label>管理密钥<input type="password" id="keyInput" placeholder="输入管理密钥" autocomplete="off"></label>\n'
+ '  <div class="key-err" id="keyErr">密钥不对，请重试。</div>\n'
+ '  <div class="form-actions"><button type="button" class="cancel" id="keyCancel">取消</button><button type="button" class="submit" id="keySubmit">进入管理</button></div>\n'
+ '</div></div>\n'
+ '<div class="form-overlay" id="flowForm"><div class="form-box"><h2>上传工作流</h2>\n'
    + '  <form id="flowUploadForm"><label>工作流名称 *<input type="text" name="name" required maxlength="80" placeholder="例如：Qwen 人像写真工作流"></label>\n'
    + '  <label>适用模型<select name="model"><option>MOSS-Image</option><option>Qwen Image 2.1 Turbo</option><option>Krea2</option><option>其他</option></select></label>\n'
    + '  <label>分享者（可选）<input type="text" name="author" maxlength="40" placeholder="留空为匿名"></label>\n'
    + '  <label>介绍（可选）<textarea name="description" maxlength="500" placeholder="简单说说这个工作流适合画什么、有什么特点"></textarea></label>\n'
    + '  <label>工作流文件（.json）*<input type="file" name="workflow" accept=".json,application/json" required><div class="hint">ComfyUI 里导出的工作流 JSON 文件，2MB 以内。上传后任何人都可以下载。</div></label>\n'
    + '  <div class="form-actions"><button type="button" class="cancel" id="flowCancel">取消</button><button type="submit" class="submit">上传分享</button></div></form>\n'
    + '</div></div>\n'
    + '<script>\n'
    + 'var ITEMS = ' + itemsJson + ';\n'
    + 'var currentList = ITEMS.slice();\n'
    + 'var currentIdx = 0;\n'
    + 'var ADMIN_KEY = sessionStorage.getItem("gallery_admin_key") || "";\n'
    + 'var overlay = document.getElementById("overlay");\n'
    + 'function copyText(t, btn, okMsg) {\n'
    + '  function done(msg) { if (!btn) return; var old = btn.textContent; btn.textContent = msg; setTimeout(function () { btn.textContent = old; }, 1500); }\n'
    + '  if (navigator.clipboard && navigator.clipboard.writeText) { navigator.clipboard.writeText(t).then(function () { done(okMsg || "已复制 ✓"); }, function () { done("复制失败"); }); }\n'
    + '  else { var ta = document.createElement("textarea"); ta.value = t; document.body.appendChild(ta); ta.select(); try { document.execCommand("copy"); done(okMsg || "已复制 ✓"); } catch (e) { done("复制失败"); } document.body.removeChild(ta); }\n'
    + '}\n'
    + 'function apiPost(path, data) {\n'
    + '  return fetch(path, { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify(data) }).then(function (r) { return r.json(); });\n'
    + '}\n'
    + 'var HERO = {\n'
    + '  images: ["图片 · " + ITEMS.length + " 张", "每一次生图，都在这里。原图直出，附完整提示词，点任意一张图查看大图与提示词。", "图片"],\n'
    + '  prompts: ["提示词 · " + ITEMS.length + " 条", "所有图片的完整提示词，点复制直接拿去生图。", "提示词"],\n'
    + '  flows: ["工作流分享", "站长实测的工作流配置，和大家分享的工作流。下载 JSON 直接导入 ComfyUI 就能用。", "工作流分享"],\n'
    + '  manage: ["管理 · " + ITEMS.length + " 张", "输入管理密钥后，点图片右上角的 × 删除图片，删除后无法恢复。", "管理"]\n'
    + '};\n'
    + 'function setManage(on) {\n'
    + '  document.body.classList.toggle("manage", on);\n'
    + '  var tab = document.querySelector(\'.tab[data-tab="manage"]\');\n'
    + '  if (tab) tab.textContent = on ? "退出管理" : "管理";\n'
    + '}\n'
    + 'function askKey(cb, onCancel) {\n'
    + '  var modal = document.getElementById("keyModal");\n'
    + '  var input = document.getElementById("keyInput");\n'
    + '  var err = document.getElementById("keyErr");\n'
    + '  err.classList.remove("on"); input.value = "";\n'
    + '  modal.classList.add("open");\n'
    + '  setTimeout(function () { input.focus(); }, 60);\n'
    + '  function close(cancelled) {\n'
    + '    modal.classList.remove("open");\n'
    + '    document.getElementById("keySubmit").onclick = null;\n'
    + '    document.getElementById("keyCancel").onclick = null;\n'
    + '    input.onkeydown = null; modal.onclick = null;\n'
    + '    if (cancelled && onCancel) onCancel();\n'
    + '  }\n'
    + '  document.getElementById("keySubmit").onclick = function () {\n'
    + '    var k = input.value.trim();\n'
    + '    if (!k) { err.textContent = "请输入管理密钥。"; err.classList.add("on"); return; }\n'
    + '    apiPost("/api/manage-check", { key: k }).then(function (r) {\n'
    + '      if (r && r.ok) { ADMIN_KEY = k; sessionStorage.setItem("gallery_admin_key", k); setManage(true); close(false); if (cb) cb(); }\n'
    + '      else { err.textContent = "密钥不对，请重试。"; err.classList.add("on"); input.select(); }\n'
    + '    }).catch(function () { err.textContent = "请求失败，请检查网络后重试。"; err.classList.add("on"); });\n'
    + '  };\n'
    + '  document.getElementById("keyCancel").onclick = function () { close(true); };\n'
    + '  modal.onclick = function (e) { if (e.target === modal) close(true); };\n'
    + '  input.onkeydown = function (e) { if (e.key === "Enter") { e.preventDefault(); document.getElementById("keySubmit").click(); } };\n'
    + '}\n'
    + 'function ensureManage(cb, onCancel) {\n'
    + '  if (document.body.classList.contains("manage")) { if (cb) cb(); return; }\n'
    + '  if (ADMIN_KEY) {\n'
    + '    apiPost("/api/manage-check", { key: ADMIN_KEY }).then(function (r) {\n'
    + '      if (r && r.ok) { setManage(true); if (cb) cb(); }\n'
    + '      else { ADMIN_KEY = ""; sessionStorage.removeItem("gallery_admin_key"); askKey(cb, onCancel); }\n'
    + '    }).catch(function () { askKey(cb, onCancel); });\n'
    + '  } else askKey(cb, onCancel);\n'
    + '}\n'
    + 'function showManageView() { showView("images"); setHero("manage"); markTab("manage"); }\n'
    + 'function switchTab(name) {\n'
    + '  if (name === "manage") {\n'
    + '    if (document.body.classList.contains("manage")) { setManage(false); switchTab("images"); return; }\n'
    + '    showManageView();\n'
    + '    ensureManage(null, function () { switchTab("images"); });\n'
    + '    return;\n'
    + '  }\n'
    + '  showView(name); setHero(name); markTab(name);\n'
    + '}\n'
    + 'function showView(name) {\n'
    + '  document.querySelectorAll(".view").forEach(function (v) { v.classList.remove("on"); });\n'
    + '  var el = document.getElementById("view-" + name);\n'
    + '  if (el) el.classList.add("on");\n'
    + '}\n'
    + 'function setHero(name) {\n'
    + '  var h = HERO[name]; if (!h) return;\n'
    + '  document.getElementById("heroTitle").textContent = h[0];\n'
    + '  document.getElementById("heroDesc").textContent = h[1];\n'
    + '  document.getElementById("crumb").textContent = h[2];\n'
    + '}\n'
    + 'function markTab(name) {\n'
    + '  document.querySelectorAll(".tab").forEach(function (t) { t.classList.toggle("on", t.dataset.tab === name); });\n'
    + '}\n'
    + 'document.querySelectorAll(".tab").forEach(function (t) { t.addEventListener("click", function () { switchTab(t.dataset.tab); }); });\n'
    + 'document.querySelectorAll(".cap").forEach(function (c) {\n'
    + '  c.addEventListener("click", function () {\n'
    + '    document.querySelectorAll(".cap").forEach(function (x) { x.classList.remove("on"); });\n'
    + '    c.classList.add("on");\n'
    + '    var m = c.dataset.model;\n'
    + '    currentList = m === "全部" ? ITEMS.slice() : ITEMS.filter(function (it) { return it.model === m; });\n'
    + '    var n = 0;\n'
    + '    document.querySelectorAll(".card").forEach(function (card) {\n'
    + '      var show = m === "全部" || card.dataset.model === m;\n'
    + '      card.style.display = show ? "" : "none";\n'
    + '      if (show) n++;\n'
    + '    });\n'
    + '    document.getElementById("fcount").textContent = n;\n'
    + '  });\n'
    + '});\n'
    + 'function openDetail(listIdx) {\n'
    + '  var it = currentList[listIdx]; if (!it) return;\n'
    + '  currentIdx = listIdx;\n'
    + '  document.getElementById("mImg").src = it.file;\n'
    + '  document.getElementById("mPill").textContent = (listIdx + 1) + " / " + currentList.length;\n'
    + '  document.getElementById("mMeta").textContent = (it.model || "") + " · " + String(it.created_at || "").slice(0, 10) + " · " + (listIdx + 1) + "/" + currentList.length;\n'
    + '  var title = (it.prompt || "").trim().slice(0, 24) || it.model || "无标题";\n'
    + '  document.getElementById("mTitle").textContent = title;\n'
    + '  document.getElementById("mModel").textContent = it.model || "—";\n'
    + '  document.getElementById("mSize").textContent = (it.width && it.height) ? (it.width + " × " + it.height) : "—";\n'
    + '  document.getElementById("mSeed").textContent = it.seed ? it.seed : "—";\n'
    + '  document.getElementById("mDate").textContent = String(it.created_at || "").slice(0, 16).replace("T", " ");\n'
    + '  document.getElementById("mPrompt").textContent = it.prompt || "（无提示词）";\n'
    + '  document.getElementById("mDownload").href = it.file;\n'
    + '  overlay.classList.add("open"); document.body.style.overflow = "hidden";\n'
    + '  try { history.replaceState(null, "", "#" + it.id); } catch (e) {}\n'
    + '}\n'
    + 'function closeDetail() { overlay.classList.remove("open"); document.body.style.overflow = ""; try { history.replaceState(null, "", location.pathname); } catch (e) {} }\n'
    + 'function stepDetail(d) { var n = currentList.length; if (!n) return; openDetail((currentIdx + d + n) % n); }\n'
    + 'function cardIndex(card) { return currentList.indexOf(ITEMS[parseInt(card.dataset.idx, 10)]); }\n'
    + 'document.querySelectorAll(".card").forEach(function (card) {\n'
    + '  card.addEventListener("click", function () { var li = cardIndex(card); if (li >= 0) openDetail(li); });\n'
    + '});\n'
    + 'document.querySelectorAll(".del-btn").forEach(function (btn) {\n'
    + '  btn.addEventListener("click", function (e) { e.stopPropagation(); deleteImage(btn.dataset.id); });\n'
    + '});\n'
    + 'document.getElementById("mClose").addEventListener("click", closeDetail);\n'
    + 'overlay.addEventListener("click", function (e) { if (e.target === overlay) closeDetail(); });\n'
    + 'document.getElementById("mPrev").addEventListener("click", function () { stepDetail(-1); });\n'
    + 'document.getElementById("mNext").addEventListener("click", function () { stepDetail(1); });\n'
    + 'document.getElementById("mUp").addEventListener("click", function () { stepDetail(-1); });\n'
    + 'document.getElementById("mDown").addEventListener("click", function () { stepDetail(1); });\n'
    + 'document.getElementById("mCopy").addEventListener("click", function () { copyText(document.getElementById("mPrompt").textContent, document.getElementById("mCopy"), "已复制 ✓"); });\n'
    + 'document.getElementById("mCopy2").addEventListener("click", function () { copyText(document.getElementById("mPrompt").textContent, document.getElementById("mCopy2"), "已复制 ✓"); });\n'
    + 'document.getElementById("mShare").addEventListener("click", function () { copyText(location.origin + location.pathname + "#" + (currentList[currentIdx] || {}).id, document.getElementById("mShare"), "链接已复制 ✓"); });\n'
    + 'document.getElementById("mManage").addEventListener("click", function () { ensureManage(function () { closeDetail(); showManageView(); }); });\n'
    + 'document.getElementById("mDelete").addEventListener("click", function () { var it = currentList[currentIdx]; if (it) deleteImage(it.id, closeDetail); });\n'
    + 'document.addEventListener("keydown", function (e) {\n'
    + '  if (!overlay.classList.contains("open")) return;\n'
    + '  if (e.key === "Escape") closeDetail();\n'
    + '  else if (e.key === "ArrowLeft") stepDetail(-1);\n'
    + '  else if (e.key === "ArrowRight") stepDetail(1);\n'
    + '  else if (e.key === "ArrowUp") { e.preventDefault(); stepDetail(-1); }\n'
    + '  else if (e.key === "ArrowDown") { e.preventDefault(); stepDetail(1); }\n'
    + '});\n'
    + 'function deleteImage(id, done) {\n'
    + '  if (!id) return;\n'
    + '  if (!confirm("确定删除这张图吗？删除后无法恢复。")) return;\n'
    + '  apiPost("/api/delete", { id: id, key: ADMIN_KEY }).then(function (r) {\n'
    + '    if (r && r.ok) {\n'
    + '      var gi = -1;\n'
    + '      ITEMS.forEach(function (it, i) { if (it.id === id) gi = i; });\n'
    + '      if (gi >= 0) ITEMS.splice(gi, 1);\n'
    + '      currentList = currentList.filter(function (it) { return it.id !== id; });\n'
    + '      var card = document.querySelector(\'.card[data-id="\' + id + \'"]\');\n'
    + '      if (card) card.remove();\n'
    + '      var pc = document.querySelector(\'.pcard[data-idx="\' + gi + \'"]\');\n'
    + '      if (pc) pc.remove();\n'
    + '      document.querySelectorAll(".card").forEach(function (c, i) { c.dataset.idx = i; });\n'
    + '      var n = document.getElementById("navCount"); if (n) n.textContent = r.remaining;\n'
    + '      var f = document.getElementById("fcount"); if (f) f.textContent = currentList.length;\n'
    + '      if (done) done();\n'
    + '    } else if (r && r.error === "密钥不对") { alert("密钥不对，请退出管理后重新输入。"); }\n'
    + '    else alert("删除失败：" + ((r && r.error) || "未知错误"));\n'
    + '  }).catch(function () { alert("请求失败，请检查网络后重试。"); });\n'
    + '}\n'
    + 'function deleteFlow(id, card) {\n'
    + '  if (!id) return;\n'
    + '  if (!confirm("确定删除这个工作流吗？删除后无法恢复。")) return;\n'
    + '  apiPost("/api/workflow/delete", { id: id, key: ADMIN_KEY }).then(function (r) {\n'
    + '    if (r && r.ok) { if (card) card.remove(); }\n'
    + '    else if (r && r.error === "密钥不对") { alert("密钥不对，请退出管理后重新输入。"); }\n'
    + '    else alert("删除失败：" + ((r && r.error) || "未知错误"));\n'
    + '  }).catch(function () { alert("请求失败，请检查网络后重试。"); });\n'
    + '}\n'
    + 'document.querySelectorAll(".flow-del").forEach(function (btn) {\n'
    + '  btn.addEventListener("click", function (e) { e.stopPropagation(); deleteFlow(btn.dataset.fid, btn.closest(".fcard")); });\n'
    + '});\n'
    + 'document.querySelectorAll(".copy-btn").forEach(function (btn) {\n'
    + '  btn.addEventListener("click", function () {\n'
    + '    var it = ITEMS[parseInt(btn.dataset.idx, 10)];\n'
    + '    if (it) copyText(it.prompt || "", btn, "已复制 ✓");\n'
    + '  });\n'
    + '});\n'
    + 'document.querySelectorAll(".copy-params").forEach(function (btn) {\n'
    + '  btn.addEventListener("click", function () { copyText(btn.dataset.params || "", btn, "已复制 ✓"); });\n'
    + '});\n'
    + 'document.querySelectorAll(".copy-flow").forEach(function (btn) {\n'
    + '  btn.addEventListener("click", function () {\n'
    + '    fetch(btn.dataset.file).then(function (r) { return r.text(); }).then(function (t) { copyText(t, btn, "已复制 ✓"); }).catch(function () { alert("读取失败，请检查网络后重试。"); });\n'
    + '  });\n'
    + '});\n'
    + 'var flowForm = document.getElementById("flowForm");\n'
    + 'document.getElementById("uploadBtn").addEventListener("click", function () { flowForm.classList.add("open"); });\n'
    + 'document.getElementById("flowCancel").addEventListener("click", function () { flowForm.classList.remove("open"); });\n'
    + 'flowForm.addEventListener("click", function (e) { if (e.target === flowForm) flowForm.classList.remove("open"); });\n'
    + 'document.getElementById("flowUploadForm").addEventListener("submit", function (e) {\n'
    + '  e.preventDefault();\n'
    + '  var btn = e.target.querySelector(".submit");\n'
    + '  btn.disabled = true; btn.textContent = "上传中…";\n'
    + '  fetch("/api/workflow/upload", { method: "POST", body: new FormData(e.target) }).then(function (r) { return r.json(); }).then(function (r) {\n'
    + '    if (r && r.ok) { alert("上传成功，已分享。"); location.reload(); }\n'
    + '    else { alert("上传失败：" + ((r && r.error) || "未知错误")); btn.disabled = false; btn.textContent = "上传分享"; }\n'
    + '  }).catch(function () { alert("请求失败，请检查网络后重试。"); btn.disabled = false; btn.textContent = "上传分享"; });\n'
    + '});\n'
    + '(function () {\n'
    + '  if (!location.hash || location.hash.length < 2) return;\n'
    + '  var id = location.hash.slice(1);\n'
    + '  var li = -1;\n'
    + '  currentList.forEach(function (it, i) { if (it.id === id) li = i; });\n'
    + '  if (li >= 0) openDetail(li);\n'
    + '})();\n'
    + '</script></body></html>';
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
function keyOk(key) {
  if (!SHOWCASE_KEY) return false;
  const a = Buffer.from(String(key || '')), b = Buffer.from(SHOWCASE_KEY);
  return a.length === b.length && crypto.timingSafeEqual(a, b);
}
function readJsonBody(req, limit) {
  return readBody(req, limit).then(buf => {
    try { return JSON.parse(buf.toString('utf8') || '{}'); } catch { return null; }
  });
}

const server = http.createServer(async (req, res) => {
  try {
    const url = new URL(req.url, 'http://x');
    const p = url.pathname;
    if (req.method === 'GET' && p === '/api/health') return sendJson(res, 200, { ok: true, service: 'tianya-gallery', time: new Date().toISOString() });
    if (req.method === 'GET' && p === '/api/gallery') return sendJson(res, 200, { ok: true, items: loadItems() });
    if (req.method === 'GET' && p === '/api/workflows') return sendJson(res, 200, { ok: true, items: loadFlows() });
    if (req.method === 'GET' && (p === '/' || p === '/index.html')) {
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      return res.end(galleryHtml(loadItems(), loadFlows()));
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
    if (req.method === 'GET' && p.startsWith('/workflows/')) {
      const name = path.basename(p);
      if (!name.endsWith('.json')) return sendJson(res, 404, { ok: false, error: 'not found' });
      const f = path.join(WORKFLOW_DIR, name);
      if (!fs.existsSync(f)) return sendJson(res, 404, { ok: false, error: 'not found' });
      res.writeHead(200, { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'public, max-age=3600' });
      return res.end(fs.readFileSync(f));
    }
    // 管理：校验密钥（进入管理模式时用，不删任何东西）
    if (req.method === 'POST' && p === '/api/manage-check') {
      if (!SHOWCASE_KEY) return sendJson(res, 500, { ok: false, error: '服务端未配置密钥' });
      const body = await readJsonBody(req, 4096);
      if (!body) return sendJson(res, 400, { ok: false, error: '请求格式不对' });
      if (!keyOk(body.key)) return sendJson(res, 403, { ok: false, error: '密钥不对' });
      return sendJson(res, 200, { ok: true });
    }
    // 管理：删一张图（删文件 + 从索引移除），密钥与推送密钥相同
    if (req.method === 'POST' && p === '/api/delete') {
      if (!SHOWCASE_KEY) return sendJson(res, 500, { ok: false, error: '服务端未配置密钥' });
      const body = await readJsonBody(req, 4096);
      if (!body) return sendJson(res, 400, { ok: false, error: '请求格式不对' });
      if (!keyOk(body.key)) return sendJson(res, 403, { ok: false, error: '密钥不对' });
      const id = String(body.id || '');
      const items = loadItems();
      const idx = items.findIndex(it => it.id === id);
      if (idx === -1) return sendJson(res, 404, { ok: false, error: '找不到这张图' });
      const removed = items.splice(idx, 1)[0];
      if (removed && removed.file) {
        const fp = path.join(IMAGE_DIR, path.basename(removed.file));
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      }
      saveItems(items);
      return sendJson(res, 200, { ok: true, id, remaining: items.length });
    }
    // 管理：删一个已上传的工作流（删文件 + 从索引移除），密钥与推送密钥相同
    if (req.method === 'POST' && p === '/api/workflow/delete') {
      if (!SHOWCASE_KEY) return sendJson(res, 500, { ok: false, error: '服务端未配置密钥' });
      const body = await readJsonBody(req, 4096);
      if (!body) return sendJson(res, 400, { ok: false, error: '请求格式不对' });
      if (!keyOk(body.key)) return sendJson(res, 403, { ok: false, error: '密钥不对' });
      const id = String(body.id || '');
      const flows = loadFlows();
      const idx = flows.findIndex(fl => fl.id === id);
      if (idx === -1) return sendJson(res, 404, { ok: false, error: '找不到这个工作流' });
      const removed = flows.splice(idx, 1)[0];
      if (removed && removed.file) {
        const fp = path.join(WORKFLOW_DIR, path.basename(removed.file));
        if (fs.existsSync(fp)) fs.unlinkSync(fp);
      }
      saveFlows(flows);
      return sendJson(res, 200, { ok: true, id, remaining: flows.length });
    }
    // 工作流分享：上传一个 ComfyUI 工作流 JSON（公开上传，任何人可分享）
    if (req.method === 'POST' && p === '/api/workflow/upload') {
      const ct = req.headers['content-type'] || '';
      const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/);
      if (!m) return sendJson(res, 400, { ok: false, error: '需要 multipart 表单' });
      const body = await readBody(req, MAX_FLOW_BYTES + 1024 * 1024);
      const { fields, file } = parseMultipart(body, (m[1] || m[2]).trim());
      const name = String(fields.name || '').trim();
      if (!name) return sendJson(res, 400, { ok: false, error: '请填写工作流名称' });
      if (!file || !file.data || file.data.length === 0) return sendJson(res, 400, { ok: false, error: '没有收到工作流文件' });
      if (file.data.length > MAX_FLOW_BYTES) return sendJson(res, 400, { ok: false, error: '工作流文件超出 2MB 限制' });
      if (!/\.json$/i.test(file.filename || '')) return sendJson(res, 400, { ok: false, error: '只接受 .json 工作流文件' });
      let parsed;
      try { parsed = JSON.parse(file.data.toString('utf8')); } catch { return sendJson(res, 400, { ok: false, error: '文件不是有效的 JSON' }); }
      if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return sendJson(res, 400, { ok: false, error: '工作流 JSON 格式不对' });
      const id = new Date().toISOString().slice(0, 19).replace(/[-:T]/g, '') + '-' + crypto.randomBytes(4).toString('hex');
      const filename = id + '.json';
      fs.writeFileSync(path.join(WORKFLOW_DIR, filename), file.data);
      const entry = {
        id, file: 'workflows/' + filename,
        name: name.slice(0, 80),
        model: String(fields.model || '其他').trim().slice(0, 40),
        description: String(fields.description || '').trim().slice(0, 500),
        author: String(fields.author || '').trim().slice(0, 40),
        created_at: new Date().toISOString(),
      };
      const flows = loadFlows();
      flows.unshift(entry);
      while (flows.length > MAX_ITEMS) {
        const old = flows.pop();
        if (old && old.file) { const fp = path.join(WORKFLOW_DIR, path.basename(old.file)); if (fs.existsSync(fp)) fs.unlinkSync(fp); }
      }
      saveFlows(flows);
      return sendJson(res, 200, { ok: true, id, url: 'workflows/' + filename });
    }
    if (req.method === 'POST' && (p === '/upload.php' || p === '/upload')) {
      if (!SHOWCASE_KEY) return sendJson(res, 500, { ok: false, error: '服务端未配置推送密钥' });
      const ct = req.headers['content-type'] || '';
      const m = ct.match(/boundary=(?:"([^"]+)"|([^;]+))/);
      if (!m) return sendJson(res, 400, { ok: false, error: '需要 multipart 表单' });
      const body = await readBody(req, MAX_BYTES + 1024 * 1024);
      const { fields, file } = parseMultipart(body, (m[1] || m[2]).trim());
      const key = String(fields.key || '');
      if (!keyOk(key)) return sendJson(res, 403, { ok: false, error: '密钥不对' });
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
        if (old && old.file) { const fp = path.join(IMAGE_DIR, path.basename(old.file)); if (fs.existsSync(fp)) fs.unlinkSync(fp); }
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

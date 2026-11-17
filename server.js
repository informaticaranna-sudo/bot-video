// Servidor local (Node 18+, sem dependências).
//  - serve o app
//  - consulta a API de afiliados da Shopee (dados + foto do produto)
//  - Vídeo HD: gera clipes animados por IA a partir das fotos (fal.ai OU Kling AI direto, imagem → vídeo)
//  - Narração: voz sintética (Google Gemini TTS ou OpenAI TTS) para entrar dentro do vídeo
//  - Converte o vídeo gravado pelo navegador num MP4 padrão de celular (H.264 + AAC) com o ffmpeg
// Uso: crie um arquivo .env (veja .env.example) e rode:  node server.js
// Depois abra http://localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const os = require('os');
const { spawn, spawnSync } = require('child_process');

// --- carrega .env simples ---
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_0-9]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

// ---- credenciais (variáveis de ambiente OU credentials.json salvo pelo painel Ajustes) ----
const CRED_FILE = path.join(process.env.DATA_DIR || __dirname, 'credentials.json');
const creds = {
  appId: process.env.SHOPEE_APP_ID || '',
  secret: process.env.SHOPEE_SECRET || '',
  falKey: process.env.FAL_KEY || '',
  falModel: process.env.FAL_MODEL || '',
  openaiKey: process.env.OPENAI_API_KEY || '',
  voice: process.env.TTS_VOICE || '',
  // Vídeo: 'fal' (padrão) ou 'kling' (API oficial da Kling)
  videoProvider: process.env.VIDEO_PROVIDER || '',
  klingAccessKey: process.env.KLING_ACCESS_KEY || '',
  klingSecretKey: process.env.KLING_SECRET_KEY || '',
  klingModel: process.env.KLING_MODEL || '',
  klingBase: process.env.KLING_BASE_URL || '',
  // Narração: 'gemini' (Google AI Studio) ou 'openai'
  ttsProvider: process.env.TTS_PROVIDER || '',
  geminiKey: process.env.GEMINI_API_KEY || '',
  geminiVoice: process.env.GEMINI_VOICE || '',
  geminiModel: process.env.GEMINI_TTS_MODEL || '',
};
try {
  const saved = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'));
  for (const k of Object.keys(creds)) if (!creds[k] && saved[k]) creds[k] = saved[k];
} catch {}
const DEFAULT_FAL_MODEL = 'fal-ai/kling-video/v2.1/pro/image-to-video';
const falModel = () => (creds.falModel || DEFAULT_FAL_MODEL).replace(/^\/+|\/+$/g, '');
const DEFAULT_KLING_MODEL = 'kling-v2-6';
const DEFAULT_KLING_BASE = 'https://api-singapore.klingai.com';
const klingModel = () => creds.klingModel || DEFAULT_KLING_MODEL;
const klingBase = () => (creds.klingBase || DEFAULT_KLING_BASE).replace(/\/+$/, '');
const klingReady = () => !!(creds.klingAccessKey && creds.klingSecretKey);
const falReady = () => !!creds.falKey;
// provedor de vídeo efetivo: o escolhido (se tiver chave), senão o que tiver chave configurada
const videoProvider = () => {
  const want = creds.videoProvider === 'kling' ? 'kling' : creds.videoProvider === 'fal' ? 'fal' : '';
  if (want === 'kling' && klingReady()) return 'kling';
  if (want === 'fal' && falReady()) return 'fal';
  if (falReady()) return 'fal';
  if (klingReady()) return 'kling';
  return want || 'fal';
};
const videoReady = () => falReady() || klingReady();
const ttsReady = () => !!(creds.geminiKey || creds.openaiKey);
const ttsProvider = () => {
  const want = creds.ttsProvider === 'openai' ? 'openai' : creds.ttsProvider === 'gemini' ? 'gemini' : '';
  if (want === 'openai' && creds.openaiKey) return 'openai';
  if (want === 'gemini' && creds.geminiKey) return 'gemini';
  if (creds.geminiKey) return 'gemini';
  if (creds.openaiKey) return 'openai';
  return want || 'gemini';
};

const PASSWORD = process.env.APP_PASSWORD || ''; // opcional: protege o app se for hospedado publicamente
// ================= ffmpeg: MP4 que abre no celular e na Shopee =================
// O navegador grava um MP4 "fragmentado", com cor yuvj420p e taxa de quadros variável: toca no computador, mas galerias e o upload
// da Shopee costumam recusar. O ffmpeg refaz o arquivo como MP4 padrão: H.264 (yuv420p), AAC, 30 fps fixos e índice no começo (faststart).
// Procura, nesta ordem: FFMPEG_PATH, o pacote ffmpeg-static (instalado pelo npm install) e o "ffmpeg" do sistema.
let FFMPEG = null;
(function findFfmpeg() {
  let stat = null; try { stat = require('ffmpeg-static'); } catch {}
  for (const c of [process.env.FFMPEG_PATH, stat, 'ffmpeg'].filter(Boolean)) {
    try {
      const v = spawnSync(c, ['-hide_banner', '-encoders'], { timeout: 10000, encoding: 'utf8' });
      if (v.status === 0 && /libx264/.test(v.stdout) && /\baac\b/.test(v.stdout)) { FFMPEG = c; return; }
    } catch {}
  }
})();

const readBuf = async (req, limit) => {
  const parts = []; let n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new Error('Vídeo grande demais.'); parts.push(c); }
  return Buffer.concat(parts);
};

async function convertVideo(req, res, qs) {
  if (!FFMPEG) return send(res, 501, { error: 'O servidor não tem o ffmpeg. Rode "npm install" na pasta do app e reinicie.' });
  let buf; try { buf = await readBuf(req, 400e6); } catch (e) { return send(res, 413, { error: e.message }); }
  if (buf.length < 1000) return send(res, 400, { error: 'Vídeo vazio.' });
  const hasAudio = qs.get('audio') === '1';
  const dir = await fs.promises.mkdtemp(path.join(os.tmpdir(), 'shopee-video-')), inp = path.join(dir, 'in.bin'), out = path.join(dir, 'out.mp4');
  try {
    await fs.promises.writeFile(inp, buf); buf = null;
    const args = ['-y', '-hide_banner', '-loglevel', 'error', '-i', inp];
    if (!hasAudio) args.push('-f', 'lavfi', '-i', 'anullsrc=r=44100:cl=stereo'); // sem áudio: coloca uma faixa muda (alguns apps exigem trilha de áudio)
    args.push('-map', '0:v:0', '-map', hasAudio ? '0:a:0?' : '1:a:0');
    if (!hasAudio) args.push('-shortest');
    args.push('-vf', 'fps=30,scale=trunc(iw/2)*2:trunc(ih/2)*2:out_range=tv,format=yuv420p',
      '-c:v', 'libx264', '-profile:v', 'high', '-level', '4.0', '-preset', 'fast', '-crf', '20', '-maxrate', '10M', '-bufsize', '20M', '-g', '60',
      '-colorspace', 'bt709', '-color_primaries', 'bt709', '-color_trc', 'bt709', '-color_range', 'tv',
      '-c:a', 'aac', '-b:a', '160k', '-ar', '44100', '-ac', '2',
      '-movflags', '+faststart', '-map_metadata', '-1', out);
    await new Promise((ok, fail) => {
      const p = spawn(FFMPEG, args, { stdio: ['ignore', 'ignore', 'pipe'] });
      let err = ''; p.stderr.on('data', d => { if (err.length < 4000) err += d; });
      const kill = setTimeout(() => { p.kill('SIGKILL'); fail(new Error('A conversão demorou demais.')); }, 240000);
      p.on('error', e => { clearTimeout(kill); fail(e); });
      p.on('close', code => { clearTimeout(kill); code === 0 ? ok() : fail(new Error('ffmpeg: ' + (err.trim().split('\n').pop() || 'código ' + code))); });
    });
    const mp4 = await fs.promises.readFile(out);
    res.writeHead(200, { 'Content-Type': 'video/mp4', 'Content-Length': mp4.length });
    res.end(mp4);
  } catch (e) { if (!res.headersSent) send(res, 500, { error: 'Falha ao converter o vídeo: ' + e.message }); else res.end(); }
  finally { fs.promises.rm(dir, { recursive: true, force: true }).catch(() => {}); }
}

// Hospedado (a plataforma define PORT) = público: exige APP_PASSWORD. Local = só aceita conexões do próprio computador.
const PUBLIC = !!process.env.PORT || process.env.HOST === '0.0.0.0';
const HOST = process.env.HOST || (PUBLIC ? '0.0.0.0' : '127.0.0.1');
const authed = (req) => (PUBLIC && !PASSWORD) ? false : (!PASSWORD || req.headers['x-app-password'] === PASSWORD);
const PORT = process.env.PORT || 3000;
const ENDPOINT = 'https://open-api.affiliate.shopee.com.br/graphql';

const readBody = async (req, limit = 12e6) => {
  let b = '', n = 0;
  for await (const c of req) { n += c.length; if (n > limit) throw new Error('Corpo da requisição grande demais.'); b += c; }
  return b;
};
const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');
const send = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};
const denied = (res) => send(res, 401, { error: 'Acesso negado: defina APP_PASSWORD no servidor e informe a mesma senha em Ajustes.' });

// ================= Shopee =================
const SHOPEE_HOST = /(^|\.)(shopee\.[a-z.]+|shope\.ee|shp\.ee)$/i;
function extractIds(u) {
  const m = u.match(/-i\.(\d+)\.(\d+)/) || u.match(/\/product\/(\d+)\/(\d+)/) || u.match(/\/(\d+)\/(\d+)(?:[/?#]|$)/);
  return m ? { shopId: m[1], itemId: m[2] } : null;
}

async function resolveIds(link) {
  let ids = extractIds(link);
  if (ids) return ids;
  const r = await fetch(link, { redirect: 'follow', headers: { 'User-Agent': 'Mozilla/5.0' } });
  ids = extractIds(r.url);
  if (ids) return ids;
  const text = await r.text();
  const m = text.match(/shopee\.com\.br\/[^"' <]*?(?:-i\.\d+\.\d+|product\/\d+\/\d+)/);
  return m ? extractIds(m[0]) : null;
}

async function shopeeQuery(query) {
  const ts = Math.floor(Date.now() / 1000);
  const payload = JSON.stringify({ query });
  const sig = sha256(creds.appId + ts + payload + creds.secret);
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `SHA256 Credential=${creds.appId}, Timestamp=${ts}, Signature=${sig}`,
    },
    body: payload,
  });
  return r.json();
}

// A API de afiliados só devolve 1 imagem. Tenta achar as outras na página pública do anúncio (pode falhar: a Shopee protege a página).
async function collectImages(p) {
  const hashOf = (u) => (u.match(/\/file\/([a-z0-9\-_]{16,})/i) || [])[1];
  const seen = new Set(), out = [];
  const add = (h) => { h = h && h.replace(/_tn$/, ''); if (h && !seen.has(h) && out.length < 6) { seen.add(h); out.push('https://down-br.img.susercontent.com/file/' + h); } };
  if (p.imageUrl) { add(hashOf(p.imageUrl)); if (!out.length) out.push(p.imageUrl); }
  try {
    const r0 = await fetch(`https://shopee.com.br/api/v4/item/get?itemid=${p.itemId}&shopid=${p.shopId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) Chrome/124 Safari/537.36', 'Accept-Language': 'pt-BR' }, signal: AbortSignal.timeout(6000) });
    const j = await r0.json(); (j?.data?.images || []).forEach(add);
  } catch {}
  try {
    const r = await fetch(p.productLink || `https://shopee.com.br/product/${p.shopId}/${p.itemId}`, {
      headers: { 'User-Agent': 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124 Safari/537.36', 'Accept-Language': 'pt-BR,pt;q=0.9' },
      signal: AbortSignal.timeout(8000),
    });
    const html = await r.text();
    for (const m of html.matchAll(/\/file\/([a-z0-9\-_]{16,})/gi)) add(m[1]);
  } catch {}
  return out;
}

async function imageToDataUrl(url) {
  try {
    const r = await fetch(url);
    const type = r.headers.get('content-type') || 'image/jpeg';
    return `data:${type};base64,${Buffer.from(await r.arrayBuffer()).toString('base64')}`;
  } catch { return null; }
}

async function handleProduct(req, res) {
  if (!authed(req)) return denied(res);
  if (!creds.appId || !creds.secret) return send(res, 500, { error: 'Credenciais da Shopee não configuradas. Abra Ajustes, preencha AppID e Secret e salve (ou defina SHOPEE_APP_ID e SHOPEE_SECRET no .env).' });
  let link;
  try { link = JSON.parse(await readBody(req)).url; } catch { return send(res, 400, { error: 'JSON inválido.' }); }
  let host = ''; try { host = new URL(link).hostname; } catch {}
  if (!host) return send(res, 400, { error: 'Link inválido.' });
  if (!SHOPEE_HOST.test(host)) return send(res, 400, { error: 'Cole um link da Shopee (shopee.com.br ou shope.ee).' });

  try {
    const ids = await resolveIds(link);
    if (!ids) return send(res, 422, { error: 'Não consegui identificar o produto no link. Cole o link completo (shopee.com.br/...-i.SHOP.ITEM).' });

    const q = `{ productOfferV2(itemId: ${ids.itemId}, shopId: ${ids.shopId}) {
      nodes { itemId shopId productName imageUrl price priceMin priceMax offerLink productLink shopName ratingStar sales }
    } }`;
    const data = await shopeeQuery(q);
    if (data.errors) return send(res, 502, { error: 'Erro da API Shopee', details: data.errors });

    const p = data?.data?.productOfferV2?.nodes?.[0];
    if (!p) return send(res, 404, { error: 'Produto não encontrado no catálogo de afiliados.' });
    const urls = await collectImages(p);
    const images = (await Promise.all(urls.map(imageToDataUrl))).filter(Boolean);
    send(res, 200, { ...p, images, imageData: images[0] || null });
  } catch (e) {
    send(res, 500, { error: 'Falha no servidor: ' + e.message });
  }
}

// ================= Vídeo HD com IA (imagem → vídeo: fal.ai ou Kling AI) =================
// Fluxo: /api/ai/start envia a foto + prompt de movimento → /api/ai/status (consulta) → /api/ai/file (baixa o mp4 já pronto)
const jobs = new Map(); // id -> { provider, statusUrl, responseUrl, videoUrl, created }
const falHeaders = () => ({ Authorization: 'Key ' + creds.falKey, 'Content-Type': 'application/json' });
setInterval(() => { for (const [k, j] of jobs) if (Date.now() - j.created > 3600e3) jobs.delete(k); }, 600e3).unref();

const NEG_PROMPT = 'blur, distortion, warped product, changed logo, extra objects, text, watermark, low quality, morphing';

// --- Kling: autenticação por JWT (HS256) com Access Key + Secret Key ---
const b64u = (x) => Buffer.from(x).toString('base64url');
function klingToken() {
  const now = Math.floor(Date.now() / 1000);
  const head = b64u(JSON.stringify({ alg: 'HS256', typ: 'JWT' }));
  const body = b64u(JSON.stringify({ iss: creds.klingAccessKey, exp: now + 1800, nbf: now - 5 }));
  const sig = crypto.createHmac('sha256', creds.klingSecretKey).update(head + '.' + body).digest('base64url');
  return `${head}.${body}.${sig}`;
}
const klingHeaders = () => ({ Authorization: 'Bearer ' + klingToken(), 'Content-Type': 'application/json' });

async function aiStart(req, res) {
  const provider = videoProvider();
  if (provider === 'kling' ? !klingReady() : !falReady())
    return send(res, 400, { error: provider === 'kling' ? 'Chaves da Kling não configuradas. Abra Ajustes → IA de vídeo.' : 'Chave do fal.ai não configurada. Abra Ajustes → IA de vídeo.' });
  let d; try { d = JSON.parse(await readBody(req)); } catch { return send(res, 400, { error: 'JSON inválido.' }); }
  const m = /^data:image\/(jpeg|png|webp);base64,(.+)$/s.exec(d.image || '');
  if (!m) return send(res, 400, { error: 'Imagem inválida.' });
  const prompt = String(d.prompt || '').slice(0, 1500);
  const duration = d.duration === 10 ? '10' : '5';
  const id = crypto.randomUUID();

  if (provider === 'kling') {
    const model = klingModel();
    const input = {
      model_name: model, mode: 'pro', duration, prompt,
      image: m[2], // Kling quer o base64 puro, sem "data:image/...;base64,"
      negative_prompt: NEG_PROMPT,
    };
    if (/^kling-v1/.test(model)) input.cfg_scale = 0.6; // os modelos v2+ não aceitam cfg_scale
    const r = await fetch(klingBase() + '/v1/videos/image2video', { method: 'POST', headers: klingHeaders(), body: JSON.stringify(input) });
    const j = await r.json().catch(() => ({}));
    const taskId = j?.data?.task_id;
    if (!r.ok || j.code !== 0 || !taskId)
      return send(res, 502, { error: `Kling recusou o pedido (${r.status}${j.code ? ', código ' + j.code : ''}). ${String(j.message || '').slice(0, 300)}` });
    jobs.set(id, { provider, statusUrl: `${klingBase()}/v1/videos/image2video/${taskId}`, created: Date.now() });
    return send(res, 200, { id });
  }

  const input = {
    prompt, image_url: d.image, duration, aspect_ratio: '9:16',
    negative_prompt: NEG_PROMPT, cfg_scale: 0.6,
  };
  const r = await fetch('https://queue.fal.run/' + falModel(), { method: 'POST', headers: falHeaders(), body: JSON.stringify(input) });
  const j = await r.json().catch(() => ({}));
  if (!r.ok || !j.request_id) {
    const msg = typeof j.detail === 'string' ? j.detail : JSON.stringify(j.detail || j).slice(0, 300);
    return send(res, 502, { error: `fal.ai recusou o pedido (${r.status}). ${msg}` });
  }
  jobs.set(id, {
    provider,
    statusUrl: j.status_url || `https://queue.fal.run/${falModel()}/requests/${j.request_id}/status`,
    responseUrl: j.response_url || `https://queue.fal.run/${falModel()}/requests/${j.request_id}`,
    created: Date.now(),
  });
  send(res, 200, { id });
}

async function aiStatus(req, res, id) {
  const job = jobs.get(id);
  if (!job) return send(res, 404, { error: 'Tarefa não encontrada.' });
  if (job.videoUrl) return send(res, 200, { status: 'done' });

  if (job.provider === 'kling') {
    const r = await fetch(job.statusUrl, { headers: klingHeaders() });
    const j = await r.json().catch(() => ({}));
    if (!r.ok || j.code !== 0) return send(res, 502, { error: `Kling: erro ${r.status} ao consultar. ${String(j.message || '').slice(0, 200)}` });
    const st = j.data?.task_status;
    if (st === 'succeed') {
      const url = j.data?.task_result?.videos?.[0]?.url;
      if (!url) return send(res, 200, { status: 'error', error: 'A Kling terminou, mas não devolveu vídeo.' });
      job.videoUrl = url;
      return send(res, 200, { status: 'done' });
    }
    if (st === 'failed') return send(res, 200, { status: 'error', error: 'A Kling falhou ao animar esta foto' + (j.data?.task_status_msg ? ': ' + String(j.data.task_status_msg).slice(0, 200) : '.') });
    return send(res, 200, { status: st === 'processing' ? 'running' : 'queued' });
  }

  const r = await fetch(job.statusUrl, { headers: falHeaders() });
  const s = await r.json().catch(() => ({}));
  if (!r.ok) return send(res, 502, { error: `fal.ai: erro ${r.status} ao consultar.` });
  if (s.status === 'COMPLETED') {
    const rr = await fetch(job.responseUrl, { headers: falHeaders() });
    const out = await rr.json().catch(() => ({}));
    const url = out?.video?.url;
    if (!rr.ok || !url) return send(res, 200, { status: 'error', error: 'A IA terminou, mas não devolveu vídeo' + (out?.detail ? ': ' + JSON.stringify(out.detail).slice(0, 200) : '.') });
    job.videoUrl = url;
    return send(res, 200, { status: 'done' });
  }
  if (s.status === 'FAILED' || s.error) return send(res, 200, { status: 'error', error: 'A IA falhou ao animar esta foto.' });
  send(res, 200, { status: s.status === 'IN_PROGRESS' ? 'running' : 'queued', position: s.queue_position });
}

async function aiFile(req, res, id) {
  const job = jobs.get(id);
  if (!job || !job.videoUrl) { res.writeHead(404); return res.end(); }
  const r = await fetch(job.videoUrl);
  if (!r.ok) { res.writeHead(502); return res.end(); }
  res.writeHead(200, { 'Content-Type': r.headers.get('content-type') || 'video/mp4' });
  res.end(Buffer.from(await r.arrayBuffer()));
}

// ================= Narração (TTS): Google Gemini ou OpenAI =================
const OPENAI_VOICES = ['nova', 'shimmer', 'coral', 'alloy', 'echo', 'onyx', 'sage', 'ash', 'fable', 'ballad'];
const GEMINI_VOICES = ['Zephyr', 'Puck', 'Charon', 'Kore', 'Fenrir', 'Leda', 'Orus', 'Aoede', 'Callirrhoe', 'Autonoe', 'Enceladus', 'Iapetus', 'Umbriel', 'Algieba', 'Despina', 'Erinome', 'Algenib', 'Rasalgethi', 'Laomedeia', 'Achernar', 'Alnilam', 'Schedar', 'Gacrux', 'Pulcherrima', 'Achird', 'Zubenelgenubi', 'Vindemiatrix', 'Sadachbia', 'Sadaltager', 'Sulafat'];
const DEFAULT_GEMINI_VOICE = 'Leda';
// Modelos tentados em ordem (o primeiro que responder vale). Pode fixar um com GEMINI_TTS_MODEL / Ajustes.
const GEMINI_MODELS = ['gemini-3.8-flash-tts', 'gemini-2.5-flash-preview-tts', 'gemini-2.5-flash-tts'];
const SHOPEE_STYLE = 'Direção de voz: fale português do Brasil como uma pessoa de verdade gravando um story para uma amiga, e não como uma locutora. É UM ÚNICO take contínuo: mantenha a mesma energia e o mesmo jeito de falar do começo ao fim, sem recomeçar a entonação a cada frase. Cada linha do texto é só uma pausa natural de respiração. Tom de conversa, caloroso e espontâneo, com sorriso na voz; ritmo variado (acelera um pouco nas partes empolgadas, desacelera no preço), respiração leve, ênfase só nas palavras-chave, entonação que sobe e desce como no dia a dia. Sem soar robótica, sem leitura de comercial. Diga exatamente este texto, sem acrescentar nada:';
// Deixa o texto "falável": preço por extenso, tira emojis/hashtags/símbolos que o TTS lê de forma estranha
function speakable(t) {
  return String(t)
    .replace(/R\$\s*(\d{1,3}(?:\.\d{3})*|\d+)(?:[,.](\d{1,2}))?/g, (_, r, c) => { const reais = Number(r.replace(/\./g, '')), cts = c ? Number(c.padEnd(2, '0')) : 0; return reais + (reais === 1 ? ' real' : ' reais') + (cts ? ' e ' + cts + ' centavos' : ''); })
    .replace(/(\d+)\s*%/g, '$1 por cento')
    .replace(/[\u{1F000}-\u{1FFFF}\u{2600}-\u{27BF}\u{FE0F}]/gu, '')
    .replace(/#\w+/g, '').replace(/[*_~|<>]/g, ' ')
    .replace(/[^\S\n]+/g, ' ').replace(/ ?\n ?/g, '\n').replace(/\n{2,}/g, '\n').trim(); // mantém as quebras de linha (pausas naturais)
}

function pcmToWav(pcm, rate = 24000) {
  const h = Buffer.alloc(44);
  h.write('RIFF', 0); h.writeUInt32LE(36 + pcm.length, 4); h.write('WAVEfmt ', 8);
  h.writeUInt32LE(16, 16); h.writeUInt16LE(1, 20); h.writeUInt16LE(1, 22);
  h.writeUInt32LE(rate, 24); h.writeUInt32LE(rate * 2, 28); h.writeUInt16LE(2, 32); h.writeUInt16LE(16, 34);
  h.write('data', 36); h.writeUInt32LE(pcm.length, 40);
  return Buffer.concat([h, pcm]);
}

async function geminiSpeech(text, voice) {
  const models = creds.geminiModel ? [creds.geminiModel] : GEMINI_MODELS;
  let last = 'sem resposta';
  for (const model of models) {
    // 2 formatos de configuração de voz (o antigo e o novo da API); usa o que o modelo aceitar
    const configs = [
      { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { prebuiltVoiceConfig: { voiceName: voice } } } },
      { responseModalities: ['AUDIO'], speechConfig: { voiceConfig: { voice } } },
    ];
    for (const generationConfig of configs) {
      const r = await fetch(`https://generativelanguage.googleapis.com/v1beta/models/${encodeURIComponent(model)}:generateContent`, {
        method: 'POST',
        headers: { 'x-goog-api-key': creds.geminiKey, 'Content-Type': 'application/json' },
        body: JSON.stringify({ contents: [{ role: 'user', parts: [{ text: SHOPEE_STYLE + '\n' + text }] }], generationConfig }),
      });
      const j = await r.json().catch(() => ({}));
      const part = j?.candidates?.[0]?.content?.parts?.find((p) => p.inlineData?.data);
      if (r.ok && part) {
        const raw = Buffer.from(part.inlineData.data, 'base64');
        if (raw.slice(0, 4).toString() === 'RIFF') return raw; // já vem como WAV
        const rate = Number((/rate=(\d+)/.exec(part.inlineData.mimeType || '') || [])[1]) || 24000;
        return pcmToWav(raw, rate);
      }
      last = `${r.status} ${String(j?.error?.message || 'sem áudio na resposta').slice(0, 200)}`;
      if (r.status === 401 || r.status === 403 || r.status === 429) throw new Error(last); // chave/cota: não adianta tentar outro modelo
    }
  }
  throw new Error(last);
}

async function tts(req, res) {
  const provider = ttsProvider();
  if (!ttsReady()) return send(res, 400, { error: 'Nenhuma chave de narração configurada (Ajustes → Narração).' });
  let d; try { d = JSON.parse(await readBody(req, 1e5)); } catch { return send(res, 400, { error: 'JSON inválido.' }); }
  const text = speakable(String(d.text || '').slice(0, 1800)); // roteiro inteiro numa chamada só
  if (!text) return send(res, 400, { error: 'Texto vazio.' });

  if (provider === 'gemini') {
    const voice = GEMINI_VOICES.includes(d.voice) ? d.voice : (GEMINI_VOICES.includes(creds.geminiVoice) ? creds.geminiVoice : DEFAULT_GEMINI_VOICE);
    try {
      const wav = await geminiSpeech(text, voice);
      res.writeHead(200, { 'Content-Type': 'audio/wav' });
      return res.end(wav);
    } catch (e) { return send(res, 502, { error: 'Gemini recusou a narração (' + e.message + ').' }); }
  }

  const voice = OPENAI_VOICES.includes(d.voice) ? d.voice : (OPENAI_VOICES.includes(creds.voice) ? creds.voice : 'nova');
  const r = await fetch('https://api.openai.com/v1/audio/speech', {
    method: 'POST',
    headers: { Authorization: 'Bearer ' + creds.openaiKey, 'Content-Type': 'application/json' },
    body: JSON.stringify({
      model: 'gpt-4o-mini-tts', voice, input: text, response_format: 'mp3',
      instructions: 'Fale em português do Brasil como uma pessoa real gravando um story para uma amiga, em um único take contínuo: mesma energia do começo ao fim, sem recomeçar a entonação a cada frase (cada linha é só uma pausa de respiração). Tom de conversa, espontâneo e sorridente, ritmo variado, ênfase só nas palavras-chave e no preço. Nada de voz de locutor ou de robô.',
    }),
  });
  if (!r.ok) return send(res, 502, { error: `OpenAI recusou a narração (${r.status}).` });
  res.writeHead(200, { 'Content-Type': 'audio/mpeg' });
  res.end(Buffer.from(await r.arrayBuffer()));
}

// ================= Credenciais (painel Ajustes) =================
async function saveCreds(req, res) {
  if (!authed(req)) return denied(res);
  try {
    const d = JSON.parse(await readBody(req, 1e5));
    // campos em branco = mantém o valor atual (os segredos nunca voltam para o navegador)
    for (const k of ['appId', 'secret', 'falKey', 'falModel', 'openaiKey', 'voice', 'videoProvider', 'klingAccessKey', 'klingSecretKey', 'klingModel', 'klingBase', 'ttsProvider', 'geminiKey', 'geminiVoice', 'geminiModel']) {
      if (typeof d[k] === 'string' && d[k].trim()) creds[k] = d[k].trim();
    }
    for (const k of Array.isArray(d.clear) ? d.clear : []) if (k in creds) creds[k] = '';
    try { fs.writeFileSync(CRED_FILE, JSON.stringify(creds), { mode: 0o600 }); }
    catch { return send(res, 200, { ok: true, warning: 'Salvo só na memória (o servidor não conseguiu gravar em disco); será perdido ao reiniciar.' }); }
    return send(res, 200, { ok: true });
  } catch { return send(res, 400, { error: 'JSON inválido.' }); }
}

// ================= Rotas =================
http.createServer(async (req, res) => {
  try {
    const url = req.url.split('?')[0], qs = new URLSearchParams(req.url.split('?')[1] || '');
    if (req.method === 'GET' && url === '/api/status')
      return send(res, 200, { configured: !!(creds.appId && creds.secret), ai: videoReady(), tts: ttsReady(),
        needsPassword: !!PASSWORD, convert: !!FFMPEG, falModel: falModel(), voice: creds.voice || 'nova',
        videoProvider: videoProvider(), videoChoice: creds.videoProvider || '', falOk: falReady(), klingOk: klingReady(),
        klingModel: klingModel(), klingBase: klingBase(),
        ttsProvider: ttsProvider(), ttsChoice: creds.ttsProvider || '', geminiOk: !!creds.geminiKey, openaiOk: !!creds.openaiKey,
        geminiVoice: creds.geminiVoice || DEFAULT_GEMINI_VOICE, geminiModel: creds.geminiModel || '' });
    if (req.method === 'POST' && url === '/api/credentials') return saveCreds(req, res);

    if (url.startsWith('/api/ai/') || url === '/api/tts' || url === '/api/convert') {
      if (!authed(req)) return denied(res);
      if (req.method === 'POST' && url === '/api/convert') return await convertVideo(req, res, qs);
      if (req.method === 'POST' && url === '/api/ai/start') return await aiStart(req, res);
      if (req.method === 'GET' && url === '/api/ai/status') return await aiStatus(req, res, qs.get('id'));
      if (req.method === 'GET' && url === '/api/ai/file') return await aiFile(req, res, qs.get('id'));
      if (req.method === 'POST' && url === '/api/tts') return await tts(req, res);
    }

    if (req.method === 'GET' && url === '/api/image') {
      if (!authed(req)) { res.writeHead(401); return res.end(); }
      try {
        const u = new URL(qs.get('u'));
        if (!/(^|\.)(susercontent\.com|shopee\.com\.br)$/.test(u.hostname)) { res.writeHead(403); return res.end(); }
        const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
        res.writeHead(r.ok ? 200 : 502, { 'Content-Type': r.headers.get('content-type') || 'image/jpeg' });
        return res.end(Buffer.from(await r.arrayBuffer()));
      } catch { res.writeHead(400); return res.end(); }
    }
    if (req.method === 'POST' && url === '/api/product') return await handleProduct(req, res);
    if (req.method === 'GET' && (url === '/' || url === '/index.html')) {
      return fs.readFile(path.join(__dirname, 'index.html'), (err, buf) => {
        if (err) { res.writeHead(404); return res.end('index.html não encontrado'); }
        res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
        res.end(buf);
      });
    }
    res.writeHead(404); res.end('Not found');
  } catch (e) {
    if (!res.headersSent) send(res, 500, { error: 'Falha no servidor: ' + e.message }); else res.end();
  }
}).listen(PORT, HOST, () => {
  console.log(`App rodando em http://localhost:${PORT}`);
  if (!creds.appId || !creds.secret) console.log('Atenção: credenciais da Shopee não configuradas (.env ou Ajustes).');
  if (!videoReady()) console.log('Vídeo HD (IA): sem FAL_KEY nem chaves da Kling — o modo HD usará o vídeo animado local.');
  else console.log('Vídeo HD (IA): ' + (videoProvider() === 'kling' ? 'Kling AI (' + klingModel() + ')' : 'fal.ai'));
  if (!ttsReady()) console.log('Narração: sem GEMINI_API_KEY nem OPENAI_API_KEY — o vídeo sairá só com música e legendas.');
  else console.log('Narração: ' + (ttsProvider() === 'gemini' ? 'Google Gemini' : 'OpenAI'));
  console.log(FFMPEG ? 'MP4 para celular/Shopee: ativo (ffmpeg).' : 'ATENÇÃO: sem ffmpeg — o vídeo sairá no formato do navegador, que pode não abrir no celular/Shopee. Rode "npm install" (instala o ffmpeg-static) ou defina FFMPEG_PATH.');
  if (PUBLIC && !PASSWORD) console.log('ATENÇÃO: servidor público sem APP_PASSWORD. A API ficará bloqueada até você definir essa variável.');
});

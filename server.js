// Servidor local (Node 18+, sem dependências). Serve o app e consulta a API de afiliados da Shopee.
// Uso: crie um arquivo .env (veja .env.example) e rode:  node server.js
// Depois abra http://localhost:3000

const http = require('http');
const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// --- carrega .env simples ---
try {
  for (const line of fs.readFileSync(path.join(__dirname, '.env'), 'utf8').split(/\r?\n/)) {
    const m = line.match(/^\s*([A-Z_]+)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) process.env[m[1]] = m[2].replace(/^["']|["']$/g, '');
  }
} catch {}

let APP_ID = process.env.SHOPEE_APP_ID, SECRET = process.env.SHOPEE_SECRET;
const PASSWORD = process.env.APP_PASSWORD || '';          // opcional: protege o app se for hospedado publicamente
const CRED_FILE = path.join(process.env.DATA_DIR || __dirname, 'credentials.json');
if (!APP_ID || !SECRET) {
  try { ({ appId: APP_ID, secret: SECRET } = JSON.parse(fs.readFileSync(CRED_FILE, 'utf8'))); } catch {}
}
// Hospedado (a plataforma define PORT) = público: exige APP_PASSWORD. Local = só aceita conexões do próprio computador.
const PUBLIC = !!process.env.PORT || process.env.HOST === '0.0.0.0';
const HOST = process.env.HOST || (PUBLIC ? '0.0.0.0' : '127.0.0.1');
const authed = (req) => (PUBLIC && !PASSWORD) ? false : (!PASSWORD || req.headers['x-app-password'] === PASSWORD);
const readBody = async (req) => { let b = ''; for await (const c of req) b += c; return b; };
const PORT = process.env.PORT || 3000;
const ENDPOINT = 'https://open-api.affiliate.shopee.com.br/graphql';

const sha256 = (s) => crypto.createHash('sha256').update(s).digest('hex');

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
  const sig = sha256(APP_ID + ts + payload + SECRET);
  const r = await fetch(ENDPOINT, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      Authorization: `SHA256 Credential=${APP_ID}, Timestamp=${ts}, Signature=${sig}`,
    },
    body: payload,
  });
  return r.json();
}


// A API de afiliados só devolve 1 imagem. Tenta achar as outras na página pública do anúncio (pode falhar: a Shopee protege a página).
async function collectImages(p) {
  const hashOf = (u) => (u.match(/\/file\/([a-z0-9\-_]{16,})/i) || [])[1];
  const seen = new Set(), out = [];
  const add = (h) => { h = h && h.replace(/_tn$/, ''); if (h && !seen.has(h) && out.length < 4) { seen.add(h); out.push('https://down-br.img.susercontent.com/file/' + h); } };
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

const send = (res, status, data) => {
  res.writeHead(status, { 'Content-Type': 'application/json; charset=utf-8' });
  res.end(JSON.stringify(data));
};

async function handleProduct(req, res) {
  if (!authed(req)) return send(res, 401, { error: 'Acesso negado: defina APP_PASSWORD no servidor e informe a mesma senha no painel.' });
  if (!APP_ID || !SECRET) return send(res, 500, { error: 'Credenciais não configuradas. Preencha o painel "Conexão com a Shopee" e salve. Se aparecer isso, defina SHOPEE_APP_ID e SHOPEE_SECRET ou no arquivo .env.' });
  let body = '';
  for await (const chunk of req) body += chunk;
  let link;
  try { link = JSON.parse(body).url; } catch { return send(res, 400, { error: 'JSON inválido.' }); }
  if (!link || !/^https?:\/\//.test(link)) return send(res, 400, { error: 'Link inválido.' });

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

http.createServer(async (req, res) => {
  if (req.method === 'GET' && req.url === '/api/status') return send(res, 200, { configured: !!(APP_ID && SECRET), needsPassword: !!PASSWORD });
  if (req.method === 'POST' && req.url === '/api/credentials') {
    if (!authed(req)) return send(res, 401, { error: 'Acesso negado: defina APP_PASSWORD no servidor e informe a mesma senha no painel.' });
    try {
      const d = JSON.parse(await readBody(req));
      const id = String(d.appId || '').trim(), sec = String(d.secret || '').trim() || SECRET;
      if (!id || !sec) return send(res, 400, { error: 'Informe AppID e Secret.' });
      APP_ID = id; SECRET = sec;
      try { fs.writeFileSync(CRED_FILE, JSON.stringify({ appId: APP_ID, secret: SECRET }), { mode: 0o600 }); }
      catch { return send(res, 200, { ok: true, warning: 'Salvo só na memória (o servidor não conseguiu gravar em disco); será perdido ao reiniciar.' }); }
      return send(res, 200, { ok: true });
    } catch { return send(res, 400, { error: 'JSON inválido.' }); }
  }
  if (req.method === 'GET' && req.url.startsWith('/api/image?')) {
    if (!authed(req)) { res.writeHead(401); return res.end(); }
    try {
      const u = new URL(new URLSearchParams(req.url.split('?')[1]).get('u'));
      if (!/(^|\.)(susercontent\.com|shopee\.com\.br)$/.test(u.hostname)) { res.writeHead(403); return res.end(); }
      const r = await fetch(u, { signal: AbortSignal.timeout(10000) });
      res.writeHead(r.ok ? 200 : 502, { 'Content-Type': r.headers.get('content-type') || 'image/jpeg' });
      return res.end(Buffer.from(await r.arrayBuffer()));
    } catch { res.writeHead(400); return res.end(); }
  }
  if (req.method === 'POST' && req.url === '/api/product') return handleProduct(req, res);
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/index.html'))) {
    return fs.readFile(path.join(__dirname, 'index.html'), (err, buf) => {
      if (err) { res.writeHead(404); return res.end('index.html não encontrado'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
  }
  res.writeHead(404); res.end('Not found');
}).listen(PORT, HOST, () => {
  console.log(`App rodando em http://localhost:${PORT}`);
  if (!APP_ID || !SECRET) console.log('Atenção: credenciais não configuradas (.env).');
  if (PUBLIC && !PASSWORD) console.log('ATENÇÃO: servidor público sem APP_PASSWORD. A API ficará bloqueada até você definir essa variável.');
});

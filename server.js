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

const APP_ID = process.env.SHOPEE_APP_ID, SECRET = process.env.SHOPEE_SECRET;
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
  if (!APP_ID || !SECRET) return send(res, 500, { error: 'Defina SHOPEE_APP_ID e SHOPEE_SECRET no arquivo .env e reinicie o servidor.' });
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
    send(res, 200, { ...p, imageData: p.imageUrl ? await imageToDataUrl(p.imageUrl) : null });
  } catch (e) {
    send(res, 500, { error: 'Falha no servidor: ' + e.message });
  }
}

http.createServer((req, res) => {
  if (req.method === 'POST' && req.url === '/api/product') return handleProduct(req, res);
  if (req.method === 'GET' && (req.url === '/' || req.url.startsWith('/index.html'))) {
    return fs.readFile(path.join(__dirname, 'index.html'), (err, buf) => {
      if (err) { res.writeHead(404); return res.end('index.html não encontrado'); }
      res.writeHead(200, { 'Content-Type': 'text/html; charset=utf-8' });
      res.end(buf);
    });
  }
  res.writeHead(404); res.end('Not found');
}).listen(PORT, '127.0.0.1', () => {
  console.log(`App rodando em http://localhost:${PORT}`);
  if (!APP_ID || !SECRET) console.log('Atenção: credenciais não configuradas (.env).');
});

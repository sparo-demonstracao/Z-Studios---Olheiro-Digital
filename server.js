const express = require('express');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const nodemailer = require('nodemailer');

const app = express();
const PORT = process.env.PORT || 3000;

// SMTP transporter — usa Senha de App do Gmail. Variáveis na Railway: SMTP_USER, SMTP_PASS.
const SMTP_USER = process.env.SMTP_USER || '';
const SMTP_PASS = process.env.SMTP_PASS || '';
const SMTP_FROM_NAME = process.env.SMTP_FROM_NAME || 'Felipe Araújo — Z Studios';

const APIFY_TOKEN = process.env.APIFY_TOKEN || '';
const APIFY_PROFILES_PER_PLATFORM = Number(process.env.APIFY_PROFILES_PER_PLATFORM || 15);
const APIFY_ACTOR_TIKTOK = 'clockworks~tiktok-scraper';
const APIFY_ACTOR_YOUTUBE = 'streamers~youtube-scraper';
if (!APIFY_TOKEN) console.warn('[apify] APIFY_TOKEN não definido — /api/scrape e o cron diário vão falhar até a var ser configurada.');
let mailTransporter = null;
if (SMTP_USER && SMTP_PASS) {
  // family: 4 força IPv4 (Railway tem problemas com IPv6 pra smtp.gmail.com).
  // Timeouts generosos pra absorver latência entre regiões do Railway e do Google.
  mailTransporter = nodemailer.createTransport({
    host: 'smtp.gmail.com',
    port: 465,
    secure: true,
    auth: { user: SMTP_USER, pass: (SMTP_PASS || '').replace(/\s+/g, '') },
    tls: { family: 4, servername: 'smtp.gmail.com' },
    connectionTimeout: 60000,
    greetingTimeout: 30000,
    socketTimeout: 60000,
    family: 4
  });
  mailTransporter.verify((err) => {
    if (err) console.error('[mail] verify failed:', err && err.message, '| code=', err && err.code);
    else console.log(`[mail] Transporter ready (smtp.gmail.com:465, IPv4). From: ${SMTP_USER}`);
  });
} else {
  console.log('[mail] Transporter disabled (SMTP_USER/SMTP_PASS not set).');
}


const DATA_DIR = process.env.DATA_DIR || path.join(__dirname, 'data');
const DATA_FILE = path.join(DATA_DIR, 'artists.json');
const STATE_FILE = path.join(DATA_DIR, 'state.json');
const SEED_FILE = path.join(__dirname, 'data', 'artists.seed.json');

const SCHEDULE_TZ = 'America/Sao_Paulo';
const SCHEDULE_HOUR = 8; // 08:00 São Paulo

// Ensure the data directory and data file exist. On Railway, mount a Volume at /data
// and set DATA_DIR=/data so the JSON survives across deploys.
function ensureDataFile() {
  if (!fs.existsSync(DATA_DIR)) fs.mkdirSync(DATA_DIR, { recursive: true });
  if (!fs.existsSync(DATA_FILE)) {
    const seed = fs.readFileSync(SEED_FILE, 'utf-8');
    fs.writeFileSync(DATA_FILE, seed, 'utf-8');
    console.log('[init] seeded artists.json from seed file');
  }
}
ensureDataFile();

function readArtists() {
  try {
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  } catch (err) {
    console.error('[read] failed to parse artists.json, re-seeding', err);
    ensureDataFile();
    return JSON.parse(fs.readFileSync(DATA_FILE, 'utf-8'));
  }
}

function writeArtists(artists) {
  fs.writeFileSync(DATA_FILE, JSON.stringify(artists, null, 2), 'utf-8');
}

function readState() {
  try {
    if (fs.existsSync(STATE_FILE)) return JSON.parse(fs.readFileSync(STATE_FILE, 'utf-8'));
  } catch (err) { console.error('[state] parse failed', err); }
  return { lastAutoScrape: null, lastManualScrape: null, history: [] };
}

function writeState(state) {
  fs.writeFileSync(STATE_FILE, JSON.stringify(state, null, 2), 'utf-8');
}

// Compute next 08:00 in America/Sao_Paulo (UTC-3, no DST since 2019)
function getNextRunISO() {
  const SP_OFFSET_MS = -3 * 60 * 60 * 1000;
  const now = new Date();
  const spNow = new Date(now.getTime() + SP_OFFSET_MS);
  const next = new Date(spNow);
  next.setUTCHours(SCHEDULE_HOUR, 0, 0, 0);
  if (next <= spNow) next.setUTCDate(next.getUTCDate() + 1);
  return new Date(next.getTime() - SP_OFFSET_MS).toISOString();
}

// ---------- Real scraping via Apify actors ----------
function formatFollowers(n) {
  const num = Number(n) || 0;
  if (num >= 1_000_000) return (num / 1_000_000).toFixed(1).replace(/\.0$/, '') + 'M';
  if (num >= 1000) return (num / 1000).toFixed(1).replace(/\.0$/, '') + 'k';
  return String(num);
}

function extractEmail(text) {
  if (!text) return null;
  const m = String(text).match(/[a-zA-Z0-9._+-]+@[a-zA-Z0-9.-]+\.[a-zA-Z]{2,}/);
  return m ? m[0] : null;
}

// Infer genre from hashtags + query + bio. Returns one of the niche labels the
// UI already filters on, or 'Indefinido' when nothing matches — keeps chips stable.
function inferGenre(tags = [], query = '', bio = '') {
  const hay = [...tags, query, bio].filter(Boolean).join(' ').toLowerCase();
  if (/\bdrill\b/.test(hay)) return 'Rap / Drill';
  if (/trap.*melod|melodic.*trap/.test(hay)) return 'Trap Melódico';
  if (/trap.*experiment|experiment.*trap/.test(hay)) return 'Trap Experimental';
  if (/\btrap\b/.test(hay)) return 'Trap';
  if (/ostenta/.test(hay)) return 'Funk Ostentação';
  if (/conscient/.test(hay)) return 'Funk Consciente';
  if (/funk.*pop|pop.*funk/.test(hay)) return 'Funk Pop';
  if (/\bfunk\b|tamborzão|tamborzao|mandelão|mandelao|150bpm|150 bpm/.test(hay)) return 'Funk Carioca';
  if (/rap.*fem|fem.*rap|mina.*rap|rap.*mina|mulher.*rap/.test(hay)) return 'Rap Feminino';
  if (/\brap\b|hip.?hop|hiphop/.test(hay)) return 'Rap';
  if (/synth|vapor/.test(hay)) return 'Synthwave';
  if (/\bhouse\b/.test(hay)) return 'Eletrônica / House';
  if (/eletr[oô]nica|\bedm\b|techno|trance|dubstep/.test(hay)) return 'Eletrônica';
  return 'Indefinido';
}

function deriveStatus(engagement) {
  if (engagement >= 19) return 'Viralizando';
  if (engagement >= 12) return 'Em Alta';
  return 'Estável';
}

function buildInitials(name) {
  const parts = String(name || '?').trim().split(/\s+/);
  const a = (parts[0] || '?')[0] || '?';
  const b = (parts[1] || '')[0] || '';
  return (a + b).toUpperCase();
}

// ---------- Apify API: async run + poll + dataset ----------
const APIFY_API = 'https://api.apify.com/v2';
const APIFY_TERMINAL_STATUSES = new Set(['SUCCEEDED', 'FAILED', 'ABORTED', 'TIMED-OUT']);

async function startApifyRun(actorId, input) {
  if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN não configurado');
  const url = `${APIFY_API}/acts/${actorId}/runs?token=${encodeURIComponent(APIFY_TOKEN)}`;
  const res = await fetch(url, {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify(input),
    signal: AbortSignal.timeout(30_000)
  });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`Apify start ${actorId} ${res.status}: ${body.slice(0, 300)}`);
  }
  const body = await res.json();
  const data = body.data || {};
  return { runId: data.id, datasetId: data.defaultDatasetId, status: data.status };
}

async function getApifyRun(runId) {
  const url = `${APIFY_API}/actor-runs/${runId}?token=${encodeURIComponent(APIFY_TOKEN)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(20_000) });
  if (!res.ok) throw new Error(`Apify get run ${runId} ${res.status}`);
  const body = await res.json();
  const data = body.data || {};
  const stats = data.stats || {};
  const itemCount = stats.datasetItemCount ?? stats.itemsPublished ?? data.itemCount ?? 0;
  return { status: data.status, itemCount: Number(itemCount) || 0 };
}

async function getApifyDatasetItems(datasetId) {
  const url = `${APIFY_API}/datasets/${datasetId}/items?token=${encodeURIComponent(APIFY_TOKEN)}&format=json&clean=1`;
  const res = await fetch(url, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`Apify dataset ${datasetId} ${res.status}`);
  const data = await res.json();
  return Array.isArray(data) ? data : [];
}

// Pure transform: TikTok video items → unique-author Artists.
function transformTiktokItems(items, query, maxProfiles) {
  const byAuthor = new Map();
  for (const item of items) {
    const meta = item.authorMeta || {};
    const name = meta.name || meta.uniqueId;
    if (!name) continue;
    if (!byAuthor.has(name)) {
      byAuthor.set(name, {
        handle: '@' + name,
        displayName: meta.nickName || name,
        bio: meta.signature || '',
        followers: Number(meta.fans || meta.followers || 0),
        views: 0, likes: 0, comments: 0,
        hashtags: new Set()
      });
    }
    const p = byAuthor.get(name);
    p.views += Number(item.playCount || 0);
    p.likes += Number(item.diggCount || 0);
    p.comments += Number(item.commentCount || 0);
    (item.hashtags || []).forEach(h => { if (h && h.name) p.hashtags.add(String(h.name).toLowerCase()); });
  }
  return [...byAuthor.values()]
    .sort((a, b) => b.followers - a.followers)
    .slice(0, maxProfiles)
    .map(p => toArtist(p, 'tiktok', query));
}

// Pure transform: YouTube video items → unique-channel Artists.
function transformYoutubeItems(items, query, maxProfiles) {
  const byChannel = new Map();
  for (const item of items) {
    const rawHandle = item.channelHandle || item.channelUsername || item.channelId;
    if (!rawHandle) continue;
    const key = String(rawHandle).toLowerCase();
    if (!byChannel.has(key)) {
      const handle = String(rawHandle).startsWith('@') ? rawHandle : ('@' + String(rawHandle).replace(/^@?/, ''));
      byChannel.set(key, {
        handle,
        displayName: item.channelName || item.channelTitle || rawHandle,
        bio: item.channelDescription || item.aboutChannelInfo?.description || '',
        followers: Number(item.numberOfSubscribers || item.channelTotalSubscribers || 0),
        views: 0, likes: 0, comments: 0,
        hashtags: new Set()
      });
    }
    const c = byChannel.get(key);
    c.views += Number(item.viewCount || item.views || 0);
    c.likes += Number(item.likes || 0);
    c.comments += Number(item.commentsCount || item.comments || 0);
    (item.hashtags || []).forEach(h => { if (h) c.hashtags.add(String(h).toLowerCase().replace(/^#/, '')); });
    (item.text ? item.text.match(/#\w+/g) || [] : []).forEach(h => c.hashtags.add(h.slice(1).toLowerCase()));
  }
  return [...byChannel.values()]
    .sort((a, b) => b.followers - a.followers)
    .slice(0, maxProfiles)
    .map(c => toArtist(c, 'youtube', query));
}

function toArtist(profile, platform, query) {
  const engagement = profile.views > 0
    ? Math.max(0, Math.min(99, Math.round(((profile.likes + profile.comments) / profile.views) * 100)))
    : 0;
  const email = extractEmail(profile.bio);
  const genre = inferGenre([...profile.hashtags], query, profile.bio);
  return {
    id: 0, // set by caller
    name: profile.displayName || profile.handle,
    handle: profile.handle,
    email,
    hasEmail: !!email,
    platform,
    genre,
    followers: formatFollowers(profile.followers),
    engagement,
    status: deriveStatus(engagement),
    avatar: buildInitials(profile.displayName || profile.handle),
    crmAdded: false,
    scrapedAt: new Date().toISOString(),
    query
  };
}

// ---------- Middleware ----------
app.use(express.json());
app.use(express.static(path.join(__dirname, 'public')));

// ---------- Routes ----------
app.get('/health', (req, res) => {
  res.json({ ok: true, dataFile: DATA_FILE, count: readArtists().length });
});

app.get('/api/artists', (req, res) => {
  res.json({ artists: readArtists() });
});

// Shared real-scrape pipeline. Runs both actors in parallel, dedupes against
// existing artists by handle + name (case-insensitive), persists and returns.
async function runScrape(query, { perPlatform = APIFY_PROFILES_PER_PLATFORM } = {}) {
  const q = String(query || '').trim();
  if (!q) throw new Error('query é obrigatório');

  const [tiktokArtists, youtubeArtists] = await Promise.all([
    scrapeTiktok(q, perPlatform).catch(err => { console.error('[scrape/tiktok]', err.message); return []; }),
    scrapeYoutube(q, perPlatform).catch(err => { console.error('[scrape/youtube]', err.message); return []; })
  ]);

  const existing = readArtists();
  const handleSet = new Set(existing.map(a => String(a.handle || '').toLowerCase()));
  const nameSet = new Set(existing.map(a => String(a.name || '').toLowerCase()));
  let nextId = existing.reduce((m, a) => Math.max(m, a.id || 0), 0) + 1;

  const novel = [];
  for (const cand of [...tiktokArtists, ...youtubeArtists]) {
    const h = String(cand.handle || '').toLowerCase();
    const n = String(cand.name || '').toLowerCase();
    if (!h || handleSet.has(h) || nameSet.has(n)) continue;
    handleSet.add(h); nameSet.add(n);
    cand.id = nextId++;
    novel.push(cand);
  }

  const updated = existing.concat(novel);
  writeArtists(updated);
  return {
    newArtists: novel,
    artists: updated,
    query: q,
    diagnostics: { tiktok: tiktokArtists.length, youtube: youtubeArtists.length, dedupedOut: (tiktokArtists.length + youtubeArtists.length) - novel.length }
  };
}

app.post('/api/scrape', async (req, res) => {
  const query = String((req.body && req.body.query) || '').trim();
  if (!query) return res.status(400).json({ error: 'query é obrigatório' });
  if (!APIFY_TOKEN) return res.status(503).json({ error: 'APIFY_TOKEN não configurado no servidor' });

  try {
    const result = await runScrape(query);
    const state = readState();
    state.lastManualScrape = new Date().toISOString();
    state.history = [
      { type: 'manual', at: state.lastManualScrape, count: result.newArtists.length, query },
      ...(state.history || [])
    ].slice(0, 20);
    writeState(state);
    res.json(result);
  } catch (err) {
    console.error('[scrape] failed', err);
    res.status(500).json({ error: err.message || 'Falha no scrape' });
  }
});

app.get('/api/status', (req, res) => {
  const state = readState();
  const artists = readArtists();
  res.json({
    totalArtists: artists.length,
    schedule: { timezone: SCHEDULE_TZ, hour: SCHEDULE_HOUR, cron: `0 ${SCHEDULE_HOUR} * * *` },
    nextRun: getNextRunISO(),
    lastAutoScrape: state.lastAutoScrape,
    lastManualScrape: state.lastManualScrape,
    history: state.history || []
  });
});

// Cron: prospeção diária às 08:00 (America/Sao_Paulo). Rotaciona entre queries
// do nicho — 1 por dia — pra não queimar crédito do Apify e cobrir o espectro.
const DEFAULT_CRON_QUERIES = [
  'funk brasileiro 2026',
  'rap nacional novo',
  'trap brasil novo',
  'eletrônica brasil',
  'funk 150 bpm',
  'rap feminino brasil',
  'funk consciente'
];

cron.schedule(`0 ${SCHEDULE_HOUR} * * *`, async () => {
  if (!APIFY_TOKEN) {
    console.warn('[cron] APIFY_TOKEN não definido — pulando prospeção diária.');
    return;
  }
  const dayIdx = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
  const query = DEFAULT_CRON_QUERIES[dayIdx % DEFAULT_CRON_QUERIES.length];
  console.log(`[cron] 🕗 Daily prospection query="${query}" at ${new Date().toISOString()}`);
  try {
    const result = await runScrape(query);
    const state = readState();
    state.lastAutoScrape = new Date().toISOString();
    state.history = [
      { type: 'auto', at: state.lastAutoScrape, count: result.newArtists.length, query },
      ...(state.history || [])
    ].slice(0, 20);
    writeState(state);
    console.log(`[cron] ✅ Added ${result.newArtists.length} new artists (tt=${result.diagnostics.tiktok}, yt=${result.diagnostics.youtube}). Total: ${result.artists.length}`);
  } catch (err) {
    console.error('[cron] ❌ Daily scrape failed', err);
  }
}, { timezone: SCHEDULE_TZ });


app.post('/api/artists/:id/crm', (req, res) => {
  const id = Number(req.params.id);
  const artists = readArtists();
  const artist = artists.find(a => a.id === id);
  if (!artist) return res.status(404).json({ error: 'Artist not found' });
  artist.crmAdded = true;
  artist.crmAddedAt = new Date().toISOString();
  writeArtists(artists);
  res.json({ artist });
});

// Envia o e-mail de prospecção via SMTP Gmail. O front-end passa o subject + html
// já renderizados; o backend só encaminha.
app.post('/api/artists/:id/send-email', async (req, res) => {
  const id = Number(req.params.id);
  const artists = readArtists();
  const artist = artists.find(a => a.id === id);
  if (!artist) return res.status(404).json({ error: 'Artist not found' });
  if (!artist.email) {
    return res.status(400).json({
      success: false,
      error: 'Artista não tem e-mail público na bio — envio automático não disponível.'
    });
  }
  if (!mailTransporter) {
    return res.status(503).json({
      success: false,
      error: 'SMTP não configurado. Defina SMTP_USER e SMTP_PASS nas env vars.'
    });
  }
  const { subject, html } = req.body || {};
  if (!subject || !html) {
    return res.status(400).json({ success: false, error: 'subject e html são obrigatórios' });
  }
  try {
    const info = await mailTransporter.sendMail({
      from: `"${SMTP_FROM_NAME}" <${SMTP_USER}>`,
      to: artist.email,
      subject,
      html
    });
    console.log(`[mail] sent to ${artist.email} (messageId=${info.messageId})`);
    res.json({ success: true, messageId: info.messageId, to: artist.email });
  } catch (err) {
    console.error('[mail] send failed', err);
    res.status(500).json({ success: false, error: err.message || 'Falha ao enviar e-mail' });
  }
});

app.get('/', (req, res) => {
  res.sendFile(path.join(__dirname, 'public', 'index.html'));
});

app.listen(PORT, () => {
  console.log(`🎧 Olheiro Digital listening on http://localhost:${PORT}`);
  console.log(`   Data file: ${DATA_FILE}`);
  console.log(`   📅 Cron job scheduled: daily at 0${SCHEDULE_HOUR}:00 (${SCHEDULE_TZ})`);
  console.log(`   Next run: ${getNextRunISO()}`);
});

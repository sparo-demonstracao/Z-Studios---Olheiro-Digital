require('dotenv').config();
const express = require('express');
const path = require('path');
const fs = require('fs');
const cron = require('node-cron');
const nodemailer = require('nodemailer');
const ytMusic = require('./youtube-music');

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

// ---------- YouTube Music discovery config ----------
// Foco: artistas EMERGENTES (iniciantes/em ascensão). Por isso o teto padrão de
// seguidores é baixo — superstars ficam de fora por padrão.
const YTM_MAX_ARTISTS_PER_RUN = Number(process.env.YTM_MAX_ARTISTS_PER_RUN || 20);
const YTM_MIN_SUBSCRIBERS = Number(process.env.YTM_MIN_SUBSCRIBERS || 500);
const YTM_MAX_SUBSCRIBERS = Number(process.env.YTM_MAX_SUBSCRIBERS || 80_000);
const YTM_PER_SEED_LIMIT = Number(process.env.YTM_PER_SEED_LIMIT || 15);
const YTM_SEED_COUNT = Number(process.env.YTM_SEED_COUNT || 12);
if (!process.env.YOUTUBE_API_KEY) {
  console.warn('[youtube] YOUTUBE_API_KEY não definida — /api/scrape vai falhar até configurar.');
}
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

// Normaliza nome pra matching cross-platform (remove acentos, pontuação, case).
function normalizeName(s) {
  return String(s || '')
    .normalize('NFD').replace(/[̀-ͯ]/g, '')
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, ' ')
    .trim();
}

// Pure transform: TikTok video items → mapa normalizedName → perfil agregado.
// Ao contrário da versão anterior, não corta nem transforma em Artist — quem faz
// o matching com os artistas do Spotify é o finalizeJob.
function buildTiktokProfileMap(items) {
  const byAuthor = new Map();
  for (const item of items) {
    const meta = item.authorMeta || {};
    const name = meta.name || meta.uniqueId;
    if (!name) continue;
    if (!byAuthor.has(name)) {
      byAuthor.set(name, {
        platform: 'tiktok',
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
  // Indexa por nome normalizado (display + handle) pra matching fuzzy
  const byKey = new Map();
  for (const p of byAuthor.values()) {
    const keys = new Set([
      normalizeName(p.displayName),
      normalizeName(p.handle.replace(/^@/, ''))
    ].filter(Boolean));
    for (const k of keys) {
      if (!byKey.has(k)) byKey.set(k, p);
    }
  }
  return byKey;
}

// Dado um nome de artista (Spotify) e o mapa de perfis TikTok, acha o melhor match.
// Estratégia: (1) nome exato normalizado; (2) subconjunto de tokens contidos.
function matchTiktokProfile(spotifyName, profileMap) {
  if (!profileMap || !profileMap.size) return null;
  const target = normalizeName(spotifyName);
  if (!target) return null;
  if (profileMap.has(target)) return profileMap.get(target);
  // Fuzzy: pega o profile cujos tokens batem com o nome do artista
  const targetTokens = new Set(target.split(' ').filter(t => t.length >= 3));
  if (!targetTokens.size) return null;
  let best = null, bestScore = 0;
  for (const [key, profile] of profileMap) {
    const keyTokens = key.split(' ').filter(t => t.length >= 3);
    if (!keyTokens.length) continue;
    const hits = keyTokens.filter(t => targetTokens.has(t)).length;
    const score = hits / Math.max(keyTokens.length, targetTokens.size);
    if (score > bestScore && score >= 0.6) {
      bestScore = score;
      best = profile;
    }
  }
  return best;
}

// Pure transform: YouTube video items → unique-channel Artists.
// Constrói um Artist combinando dados do YouTube Music (fonte da verdade: é artista real)
// + perfil social do TikTok (opcional — enriquecimento de engajamento).
function buildArtist(ytArtist, ttProfile, query) {
  const name = ytArtist.name;
  const channel = ytArtist.channel || {};
  const stats = channel.statistics || {};
  const snippet = channel.snippet || {};
  const branding = channel.brandingSettings || {};
  const topic = (channel.topicDetails && channel.topicDetails.topicCategories) || [];

  const ytSubscribers = Number(stats.subscriberCount || 0);
  const ytViewCount = Number(stats.viewCount || 0);
  const ytVideoCount = Number(stats.videoCount || 0);

  // Engajamento: vem do TikTok se tiver match. Senão deriva de views/subs do YT.
  let engagement = 0;
  if (ttProfile && ttProfile.views > 0) {
    engagement = Math.max(0, Math.min(99, Math.round(((ttProfile.likes + ttProfile.comments) / ttProfile.views) * 100)));
  } else if (ytSubscribers > 0 && ytViewCount > 0) {
    // Proxy: views por inscrito. Artista médio: ~10-30 views/sub em carreira toda.
    const viewsPerSub = ytViewCount / ytSubscribers;
    engagement = Math.min(22, Math.round(viewsPerSub / 3));
  }

  // Seguidores: prefere TikTok (mais líquido) se tiver, senão YT.
  const socialFollowers = ttProfile ? ttProfile.followers : 0;
  const displayFollowers = socialFollowers || ytSubscribers;

  // Handle: TikTok se bateu, senão derivado do nome do artista.
  const handle = ttProfile
    ? ttProfile.handle
    : '@' + String(name).toLowerCase().replace(/[^a-z0-9]+/g, '');

  // E-mail: só existe se o perfil TikTok ou descrição do canal tiver.
  const email = (ttProfile && extractEmail(ttProfile.bio)) || extractEmail(snippet.description || branding.channel?.description);

  // Gênero: topic do YT > hashtags do TikTok > inferência por query/bio.
  let genre = ytMusic.normalizeGenre(topic, query);
  if (genre === 'Indefinido' && ttProfile) {
    const inferred = inferGenre([...(ttProfile.hashtags || [])], query, ttProfile.bio);
    if (inferred !== 'Indefinido') genre = inferred;
  }

  // Thumbnail: prefere YT Data (HD) → fallback YT Music → sem imagem.
  const ytThumb = snippet.thumbnails?.high?.url
    || snippet.thumbnails?.medium?.url
    || snippet.thumbnails?.default?.url
    || (ytArtist.ytMusicData?.thumbnails && ytArtist.ytMusicData.thumbnails[0]?.url)
    || null;

  const ytMusicUrl = `https://music.youtube.com/channel/${ytArtist.artistId}`;
  const ytChannelUrl = `https://www.youtube.com/channel/${ytArtist.artistId}`;

  const score = computeArtistScore({
    ytSubscribers,
    socialFollowers,
    engagement,
    ytScore: ytArtist._score || 0,
    hasSocial: !!ttProfile
  });

  return {
    id: 0,
    name,
    handle,
    email,
    hasEmail: !!email,
    // platform usa os rótulos que a UI já filtra ('tiktok'/'youtube').
    // O diferencial "YouTube Music" aparece via ytMusicUrl/ytMusicId no card.
    platform: ttProfile ? 'tiktok' : 'youtube',
    genre,
    genresOfficial: topic.map(t => String(t).split('/').pop().replace(/_/g, ' ')),
    followers: formatFollowers(displayFollowers),
    followersRaw: displayFollowers,
    ytSubscribers,
    ytViewCount,
    ytVideoCount,
    engagement,
    status: deriveStatus(engagement),
    avatar: buildInitials(name),
    ytMusicId: ytArtist.artistId,
    ytMusicUrl,
    ytChannelUrl,
    imageUrl: ytThumb,
    socialMatch: !!ttProfile,
    score,
    crmAdded: false,
    scrapedAt: new Date().toISOString(),
    query: query || ''
  };
}

function computeArtistScore({ ytSubscribers, socialFollowers, engagement, ytScore, hasSocial }) {
  // Escala: 0-100. Peso: ytSubscribers (30), sweet-spot ytScore (30), engagement (20), presença social (20)
  const subsScore = Math.min(100, Math.log10((ytSubscribers || 0) + 1) * 18);
  const engScore = Math.min(100, (engagement || 0) * 4.5);
  const socialScore = hasSocial ? 100 : 40;
  const weighted = subsScore * 0.3 + (ytScore || 0) * 0.3 + engScore * 0.2 + socialScore * 0.2;
  return Math.round(Math.min(100, weighted));
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

// ---------- Scrape job store + SSE streaming ----------
// In-memory only. Jobs live ~5min after terminal for late reconnects, then GC.
const jobs = new Map();
const JOB_POLL_MS = 2000;
const JOB_GC_MS = 5 * 60 * 1000;

function makeJobId() {
  return Date.now().toString(36) + '-' + Math.random().toString(36).slice(2, 8);
}

function jobSnapshot(job) {
  return {
    id: job.id,
    query: job.query,
    phase: job.phase,
    elapsed: Math.floor((Date.now() - job.createdAt) / 1000),
    ytMusic: {
      status: job.ytMusic.status,
      artistCount: job.ytMusic.artistCount,
      error: job.ytMusic.error
    },
    tiktok: { status: job.tiktok.status, itemCount: job.tiktok.itemCount, error: job.tiktok.error },
    error: job.error
  };
}

function broadcast(job, event, data) {
  const payload = `event: ${event}\ndata: ${JSON.stringify(data)}\n\n`;
  for (const res of job.listeners) {
    try { res.write(payload); } catch (_) { /* listener gone */ }
  }
}

function scheduleJobGC(job) {
  setTimeout(() => {
    for (const res of job.listeners) { try { res.end(); } catch (_) {} }
    jobs.delete(job.id);
  }, JOB_GC_MS);
}

async function pollJob(jobId) {
  const job = jobs.get(jobId);
  if (!job) return;
  if (job.phase === 'done' || job.phase === 'error' || job.phase === 'processing' || job.phase === 'saving') return;

  const tt = job.tiktok.runId ? await getApifyRun(job.tiktok.runId).catch(e => ({ _error: e.message })) : null;
  if (tt) {
    if (tt._error) job.tiktok.error = tt._error;
    else { job.tiktok.status = tt.status; job.tiktok.itemCount = tt.itemCount; }
  }

  const ttDone = !job.tiktok.runId || APIFY_TERMINAL_STATUSES.has(job.tiktok.status) || !!job.tiktok.error;

  if (job.phase === 'social_enrichment' && ttDone) {
    job.phase = 'processing';
    broadcast(job, 'status', jobSnapshot(job));
    if (job.pollTimer) { clearInterval(job.pollTimer); job.pollTimer = null; }
    finalizeJob(job).catch(err => {
      console.error(`[job ${job.id}] finalize threw`, err);
      job.phase = 'error';
      job.error = err.message || 'erro no processamento';
      broadcast(job, 'error', { error: job.error });
      scheduleJobGC(job);
    });
  } else {
    broadcast(job, 'status', jobSnapshot(job));
  }
}

async function finalizeJob(job) {
  // Fetch TikTok items (se houve run)
  let ttProfileMap = new Map();
  if (job.tiktok.status === 'SUCCEEDED' && job.tiktok.datasetId) {
    try {
      const items = await getApifyDatasetItems(job.tiktok.datasetId);
      ttProfileMap = buildTiktokProfileMap(items);
    } catch (e) {
      console.error(`[job ${job.id}] tiktok dataset`, e.message);
      job.tiktok.error = e.message;
    }
  }

  const ytArtists = job.ytArtists || [];
  if (!ytArtists.length) {
    job.phase = 'error';
    job.error = job.ytMusic.error || 'Nenhum artista retornado pelo YouTube Music.';
    broadcast(job, 'error', { error: job.error });
    scheduleJobGC(job);
    return;
  }

  let matched = 0;
  const built = ytArtists.map(ya => {
    const tt = matchTiktokProfile(ya.name, ttProfileMap);
    if (tt) matched++;
    return buildArtist(ya, tt, job.query);
  });

  job.phase = 'saving';
  broadcast(job, 'status', jobSnapshot(job));

  const existing = readArtists();
  const handleSet = new Set(existing.map(a => String(a.handle || '').toLowerCase()));
  const nameSet = new Set(existing.map(a => String(a.name || '').toLowerCase()));
  const ytIdSet = new Set(existing.map(a => a.ytMusicId).filter(Boolean));
  let nextId = existing.reduce((m, a) => Math.max(m, a.id || 0), 0) + 1;

  const novel = [];
  for (const cand of built) {
    const h = String(cand.handle || '').toLowerCase();
    const n = String(cand.name || '').toLowerCase();
    const yid = cand.ytMusicId;
    if (yid && ytIdSet.has(yid)) continue;
    if (!h || handleSet.has(h) || nameSet.has(n)) continue;
    handleSet.add(h); nameSet.add(n);
    if (yid) ytIdSet.add(yid);
    cand.id = nextId++;
    novel.push(cand);
  }
  const updated = existing.concat(novel);
  writeArtists(updated);

  const now = new Date().toISOString();
  const state = readState();
  if (job.type === 'manual') state.lastManualScrape = now;
  else if (job.type === 'auto') state.lastAutoScrape = now;
  state.history = [
    { type: job.type, at: now, count: novel.length, query: job.query },
    ...(state.history || [])
  ].slice(0, 20);
  writeState(state);

  job.result = {
    newArtists: novel,
    artists: updated,
    query: job.query,
    diagnostics: {
      ytMusic: ytArtists.length,
      tiktokMatched: matched,
      tiktokItems: ttProfileMap.size,
      dedupedOut: built.length - novel.length,
      tiktokError: job.tiktok.error,
      ytMusicError: job.ytMusic.error
    }
  };
  job.phase = 'done';
  broadcast(job, 'done', job.result);
  console.log(`[job ${job.id}] ✅ done | yt=${ytArtists.length} tt_matched=${matched}/${ttProfileMap.size} new=${novel.length}`);
  scheduleJobGC(job);
}

async function createScrapeJob({ query, type = 'manual' }) {
  if (!process.env.YOUTUBE_API_KEY) {
    throw new Error('YOUTUBE_API_KEY não configurada');
  }
  if (!APIFY_TOKEN) throw new Error('APIFY_TOKEN não configurado');
  const q = String(query || '').trim();

  const jobId = makeJobId();
  const job = {
    id: jobId,
    query: q,
    type,
    createdAt: Date.now(),
    phase: 'ytmusic_discovery',
    ytMusic: { status: 'RUNNING', artistCount: 0, error: null },
    tiktok: { runId: null, datasetId: null, status: 'PENDING', itemCount: 0, error: null },
    ytArtists: [],
    result: null,
    error: null,
    listeners: new Set(),
    pollTimer: null
  };
  jobs.set(jobId, job);
  console.log(`[job ${jobId}] 🚀 started query="${q || '(sem filtro)'}"`);

  // Fase 1: descoberta YouTube Music — exclui artistas já no banco pra cada run
  // explorar território novo (sem isso, as seeds devolvem sempre os mesmos tops).
  const existingYtIds = readArtists()
    .map(a => a.ytMusicId)
    .filter(Boolean);
  try {
    const ytArtists = await ytMusic.discoverArtists({
      maxArtists: YTM_MAX_ARTISTS_PER_RUN,
      query: q,
      minSubscribers: YTM_MIN_SUBSCRIBERS,
      maxSubscribers: YTM_MAX_SUBSCRIBERS,
      perSeedLimit: YTM_PER_SEED_LIMIT,
      seedCount: YTM_SEED_COUNT,
      excludeIds: existingYtIds
    });
    job.ytArtists = ytArtists;
    job.ytMusic.artistCount = ytArtists.length;
    job.ytMusic.status = 'SUCCEEDED';
    console.log(`[job ${jobId}] 🎵 youtube-music: ${ytArtists.length} artistas candidatos`);
  } catch (err) {
    job.ytMusic.status = 'FAILED';
    job.ytMusic.error = err.message;
    job.phase = 'error';
    job.error = `Descoberta YouTube Music falhou: ${err.message}`;
    console.error(`[job ${jobId}] ❌ youtube-music`, err.message);
    scheduleJobGC(job);
    return job;
  }

  if (!job.ytArtists.length) {
    job.phase = 'error';
    job.error = 'YouTube Music não retornou artistas dentro dos critérios. Relaxe os filtros (YTM_MIN/MAX_SUBSCRIBERS).';
    scheduleJobGC(job);
    return job;
  }

  // Fase 2: enriquecimento via TikTok — uma run batched com array de queries.
  job.phase = 'social_enrichment';
  broadcast(job, 'status', jobSnapshot(job));

  const perPlatform = APIFY_PROFILES_PER_PLATFORM;
  const ttRun = await startApifyRun(APIFY_ACTOR_TIKTOK, {
    searchQueries: job.ytArtists.map(a => a.name),
    resultsPerPage: Math.max(perPlatform, 10),
    shouldDownloadVideos: false,
    shouldDownloadCovers: false,
    shouldDownloadSubtitles: false,
    shouldDownloadSlideshowImages: false,
    proxyCountryCode: 'None'
  }).catch(e => ({ _error: e.message }));

  job.tiktok.runId = ttRun && ttRun.runId ? ttRun.runId : null;
  job.tiktok.datasetId = ttRun && ttRun.datasetId ? ttRun.datasetId : null;
  job.tiktok.status = ttRun && ttRun._error ? 'FAILED' : 'READY';
  job.tiktok.error = ttRun && ttRun._error ? ttRun._error : null;

  if (job.tiktok.status === 'FAILED') {
    // TikTok falhou, mas ainda temos Spotify — prossegue direto pro finalize.
    console.warn(`[job ${jobId}] ⚠️  tiktok falhou ao iniciar: ${job.tiktok.error}. Prosseguindo sem enriquecimento.`);
    job.phase = 'processing';
    broadcast(job, 'status', jobSnapshot(job));
    finalizeJob(job).catch(err => {
      console.error(`[job ${job.id}] finalize threw`, err);
      job.phase = 'error';
      job.error = err.message || 'erro no processamento';
      broadcast(job, 'error', { error: job.error });
      scheduleJobGC(job);
    });
  } else {
    job.pollTimer = setInterval(() => pollJob(jobId).catch(e => console.error(`[job ${jobId}] poll`, e)), JOB_POLL_MS);
    setImmediate(() => pollJob(jobId).catch(() => {}));
  }
  return job;
}

// Promise that resolves to the final result (or rejects). Used by the cron.
function waitForJob(job) {
  return new Promise((resolve, reject) => {
    const tick = () => {
      if (job.phase === 'done')  return resolve(job.result);
      if (job.phase === 'error') return reject(new Error(job.error || 'scrape falhou'));
      setTimeout(tick, 1000);
    };
    tick();
  });
}

app.post('/api/scrape', async (req, res) => {
  // query é opcional — vira seed no YouTube Music (ex: "funk", "rap", "trap").
  const query = String((req.body && req.body.query) || '').trim();
  if (!APIFY_TOKEN) return res.status(503).json({ error: 'APIFY_TOKEN não configurado no servidor' });
  if (!process.env.YOUTUBE_API_KEY) {
    return res.status(503).json({ error: 'YOUTUBE_API_KEY não configurada no servidor' });
  }
  try {
    const job = await createScrapeJob({ query, type: 'manual' });
    res.status(201).json({ jobId: job.id });
  } catch (err) {
    console.error('[scrape] failed to start', err);
    res.status(500).json({ error: err.message || 'Falha ao iniciar scrape' });
  }
});

// Polling fallback — returns current snapshot. Also returns final payload on `done`.
app.get('/api/scrape/:jobId', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).json({ error: 'job não encontrado' });
  const body = { phase: job.phase, snapshot: jobSnapshot(job) };
  if (job.phase === 'done')  body.result = job.result;
  if (job.phase === 'error') body.error  = job.error;
  res.json(body);
});

// SSE stream of job events.
app.get('/api/scrape/:jobId/stream', (req, res) => {
  const job = jobs.get(req.params.jobId);
  if (!job) return res.status(404).end();
  res.writeHead(200, {
    'Content-Type': 'text/event-stream',
    'Cache-Control': 'no-cache, no-transform',
    'Connection': 'keep-alive',
    'X-Accel-Buffering': 'no'
  });
  res.flushHeaders && res.flushHeaders();
  res.write(`event: status\ndata: ${JSON.stringify(jobSnapshot(job))}\n\n`);
  if (job.phase === 'done')  res.write(`event: done\ndata: ${JSON.stringify(job.result)}\n\n`);
  if (job.phase === 'error') res.write(`event: error\ndata: ${JSON.stringify({ error: job.error })}\n\n`);

  const keepalive = setInterval(() => { try { res.write(': ping\n\n'); } catch (_) {} }, 15000);
  job.listeners.add(res);
  req.on('close', () => {
    clearInterval(keepalive);
    job.listeners.delete(res);
    try { res.end(); } catch (_) {}
  });
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

// Admin: inspeciona o estado atual do banco — útil pra debug remoto.
app.get('/api/admin/state', (req, res) => {
  const artists = readArtists();
  const byPlatform = {};
  artists.forEach(a => { byPlatform[a.platform || 'unknown'] = (byPlatform[a.platform || 'unknown'] || 0) + 1; });
  const withYtId = artists.filter(a => a.ytMusicId).length;
  const scraped = artists.filter(a => a.scrapedAt).sort((a, b) => (b.scrapedAt || '').localeCompare(a.scrapedAt || '')).slice(0, 10);
  res.json({
    total: artists.length,
    withYtMusicId: withYtId,
    byPlatform,
    last10Scraped: scraped.map(a => ({ id: a.id, name: a.name, platform: a.platform, ytMusicId: a.ytMusicId || null, scrapedAt: a.scrapedAt })),
    ytMusicIdsCount: artists.map(a => a.ytMusicId).filter(Boolean).length
  });
});

// Admin: corrige o campo platform dos artistas já salvos antes do fix
// ('youtube-music' → 'youtube'). Idempotente — pode rodar várias vezes.
app.post('/api/admin/fix-platforms', (req, res) => {
  const artists = readArtists();
  let fixed = 0;
  for (const a of artists) {
    if (a.platform === 'youtube-music') { a.platform = 'youtube'; fixed++; }
  }
  writeArtists(artists);
  console.log(`[admin] 🔧 fix-platforms: ${fixed} artistas atualizados`);
  res.json({ ok: true, fixed, total: artists.length });
});

// Admin: reseta o banco de volta ao seed. Exige ?confirm=sim pra evitar acidente.
app.post('/api/admin/reset-data', (req, res) => {
  if (req.query.confirm !== 'sim') {
    return res.status(400).json({ error: 'Adicione ?confirm=sim na URL pra confirmar o reset.' });
  }
  try {
    if (fs.existsSync(DATA_FILE)) fs.unlinkSync(DATA_FILE);
    ensureDataFile();
    const artists = readArtists();
    console.log(`[admin] 🧹 reset-data executado. Banco voltou a ${artists.length} artistas do seed.`);
    res.json({ ok: true, total: artists.length, message: 'Banco resetado pro seed.' });
  } catch (err) {
    res.status(500).json({ error: err.message });
  }
});

// Cron: prospeção diária às 08:00 (America/Sao_Paulo). Rotaciona entre filtros de
// gênero — 1 por dia — pra cobrir o espectro e economizar crédito do Apify.
const DEFAULT_CRON_QUERIES = [
  'funk', 'rap', 'trap', 'eletrônica', 'rap feminino', 'funk consciente', ''
];

cron.schedule(`0 ${SCHEDULE_HOUR} * * *`, async () => {
  if (!APIFY_TOKEN) {
    console.warn('[cron] APIFY_TOKEN não definido — pulando prospeção diária.');
    return;
  }
  if (!process.env.YOUTUBE_API_KEY) {
    console.warn('[cron] YOUTUBE_API_KEY não definida — pulando prospeção diária.');
    return;
  }
  const dayIdx = Math.floor(Date.now() / (24 * 60 * 60 * 1000));
  const query = DEFAULT_CRON_QUERIES[dayIdx % DEFAULT_CRON_QUERIES.length];
  console.log(`[cron] 🕗 Daily prospection query="${query || '(sem filtro)'}" at ${new Date().toISOString()}`);
  try {
    const job = await createScrapeJob({ query, type: 'auto' });
    const result = await waitForJob(job);
    const d = result.diagnostics || {};
    console.log(`[cron] ✅ Added ${result.newArtists.length} new artists (ytmusic=${d.ytMusic}, matched=${d.tiktokMatched}). Total: ${result.artists.length}`);
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

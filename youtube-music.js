// YouTube Music / YouTube Data API — descoberta + enriquecimento de artistas.
//
// Pipeline:
//   1. ytmusic-api (biblioteca não-oficial) busca artistas por gênero/palavra-chave.
//      Retorna apenas entidades "artista" do YT Music — sem label/agregador.
//   2. YouTube Data API v3 (channels.list) enriquece com seguidores, país, thumb.
//
// ytmusic-api é ESM-only; usamos dynamic import num wrapper singleton.

const YT_DATA_API = 'https://www.googleapis.com/youtube/v3';

// Seeds de busca montadas combinando gêneros × modificadores × prefixos.
// Total de ~500 variações; por run pegamos uma amostra aleatória pra não ficar
// preso sempre nos mesmos artistas ranqueados no topo do YT Music.
const SEED_GENRES = [
  'funk', 'funk carioca', 'funk mandelão', 'funk 150', 'funk bh', 'funk sp',
  'funk paulista', 'funk rj', 'funk automotivo', 'funk melody',
  'rap', 'rap nacional', 'rap sp', 'rap rj', 'rap consciente', 'rap feminino',
  'trap', 'trap melódico', 'trap nacional', 'trap rj', 'drill brasileiro',
  'hip hop brasil', 'hip hop nacional',
  'phonk brasil', 'phonk brasileiro',
  'eletrônica brasil', 'deep house brasil',
  'sertanejo universitário novo', 'arrocha novo', 'piseiro novo', 'pagode novo'
];
const SEED_MODIFIERS = [
  '', 'novo', '2026', '2025', 'tiktok', 'viral', 'emergente',
  'novinho', 'recente', 'underground', 'independente', 'lançamento'
];
const SEED_PREFIXES = ['', 'mc ', 'dj ', 'novo '];

function buildAllSeeds() {
  const out = new Set();
  for (const g of SEED_GENRES) {
    for (const m of SEED_MODIFIERS) {
      for (const p of SEED_PREFIXES) {
        const s = (p + g + ' ' + m).trim().replace(/\s+/g, ' ');
        if (s.length >= 3) out.add(s);
      }
    }
  }
  return [...out];
}

function pickRandomSeeds(all, count) {
  const copy = all.slice();
  for (let i = copy.length - 1; i > 0; i--) {
    const j = Math.floor(Math.random() * (i + 1));
    [copy[i], copy[j]] = [copy[j], copy[i]];
  }
  return copy.slice(0, count);
}

const ALL_SEEDS = buildAllSeeds();

// ytmusic-api é ESM. Em CommonJS usamos dynamic import e cacheamos a instância.
let ytCache = { api: null, initPromise: null };
async function getYTMusic() {
  if (ytCache.api) return ytCache.api;
  if (!ytCache.initPromise) {
    ytCache.initPromise = (async () => {
      const { default: YTMusic } = await import('ytmusic-api');
      const api = new YTMusic();
      await api.initialize({ GL: 'BR', HL: 'pt' });
      ytCache.api = api;
      return api;
    })();
  }
  return ytCache.initPromise;
}

// Reinicia o cache em caso de falha — próxima chamada re-cria.
function resetYTMusic() {
  ytCache = { api: null, initPromise: null };
}

// ---------- YouTube Data API v3 (enriquecimento) ----------

async function ytDataFetch(path) {
  const key = process.env.YOUTUBE_API_KEY;
  if (!key) throw new Error('YOUTUBE_API_KEY não configurada');
  const sep = path.includes('?') ? '&' : '?';
  const url = `${YT_DATA_API}${path}${sep}key=${encodeURIComponent(key)}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(30_000) });
  if (!res.ok) {
    const body = await res.text().catch(() => '');
    throw new Error(`YT Data ${path} ${res.status}: ${body.slice(0, 200)}`);
  }
  return res.json();
}

// Batch de até 50 canais por chamada. Retorna snippet + stats + topic + branding.
async function getChannelsBatch(ids) {
  if (!ids || !ids.length) return [];
  const unique = [...new Set(ids)];
  const results = [];
  for (let i = 0; i < unique.length; i += 50) {
    const batch = unique.slice(i, i + 50);
    const data = await ytDataFetch(
      `/channels?part=snippet,statistics,topicDetails,brandingSettings&id=${batch.join(',')}`
    );
    results.push(...(data.items || []));
  }
  return results;
}

// ---------- Normalizações ----------

// Traduz lista de topicCategories do YT pro rótulo de gênero que a UI filtra.
function normalizeGenre(topicCategories = [], fallbackHint = '') {
  const hay = [...topicCategories, fallbackHint].join(' ').toLowerCase();
  if (/drill/.test(hay)) return 'Rap / Drill';
  if (/trap/.test(hay)) return 'Trap';
  if (/funk_music|\bfunk\b/.test(hay)) return 'Funk Carioca';
  if (/hip_hop|hip hop/.test(hay)) return 'Rap';
  if (/electronic_music|electronic/.test(hay)) return 'Eletrônica';
  if (/pop_music|pop music/.test(hay)) return 'Pop';
  if (/music/.test(hay)) return 'Indefinido';
  return 'Indefinido';
}

// Filtros pra janela de seguidores (sweet-spot de artistas em ascensão).
function filterRising(channels, {
  minSubscribers = 1000,
  maxSubscribers = 1_000_000,
  requireBR = true
} = {}) {
  return channels.filter(c => {
    const subs = Number(c.statistics?.subscriberCount || 0);
    if (subs < minSubscribers || subs > maxSubscribers) return false;
    const topic = c.topicDetails?.topicCategories || [];
    // Sinal forte de "é artista": canal tem tópico musical
    const isMusic = topic.some(t => /Music|music/.test(t));
    if (!isMusic) return false;
    if (requireBR) {
      const country = c.brandingSettings?.channel?.country || c.snippet?.country;
      // Aceita se country explícito é BR, OU se country ausente mas descrição/idioma indicam BR
      const bio = `${c.snippet?.description || ''} ${c.brandingSettings?.channel?.description || ''}`.toLowerCase();
      const brHint = /brasil|brazil|brazilian|brasileir|portuguese|português|portugues/.test(bio);
      if (country && country !== 'BR' && !brHint) return false;
    }
    return true;
  });
}

// Score: sweet-spot de inscritos (log-scale centrado em ~50k) + presença BR explícita.
function computeChannelScore(channel) {
  const subs = Number(channel.statistics?.subscriberCount || 0);
  const logSubs = Math.log10(subs + 1);
  // Sweet-spot: ~4.7 (≈ 50k subs). Penaliza afastamento.
  const sweet = 100 - Math.abs(logSubs - 4.7) * 25;
  const brBonus = channel.brandingSettings?.channel?.country === 'BR' ? 15 : 0;
  return Math.max(0, Math.round(sweet + brBonus));
}

// ---------- Orquestrador principal ----------

async function discoverArtists({
  maxArtists = 20,
  query = '',
  minSubscribers = 1000,
  maxSubscribers = 100_000,
  seedCount = 12,
  perSeedLimit = 15,
  excludeIds = []
} = {}) {
  const api = await getYTMusic();
  const excludeSet = new Set(excludeIds);

  // 1) Seeds — se query vier preenchida, usa ela direto; senão amostra aleatória.
  const queries = query
    ? [query, `${query} novo`, `mc ${query}`, `${query} 2026`].filter(Boolean)
    : pickRandomSeeds(ALL_SEEDS, seedCount);
  console.log(`[ytmusic] ${queries.length} seeds:`, queries);

  const artistMap = new Map(); // artistId → {name, thumbnails, source}

  // 2a) searchArtists — resultados mais ranqueados (grandes primeiro)
  for (const q of queries) {
    try {
      const results = await api.searchArtists(q);
      for (const a of results.slice(0, perSeedLimit)) {
        if (!a.artistId || excludeSet.has(a.artistId)) continue;
        if (!artistMap.has(a.artistId)) {
          artistMap.set(a.artistId, { ...a, _source: 'artist-search', _seed: q });
        }
      }
    } catch (err) {
      console.warn(`[ytmusic] searchArtists("${q}") falhou: ${err.message}`);
      if (/unauthor|403|context/i.test(err.message)) resetYTMusic();
    }
  }

  // 2b) searchSongs — pega artistas de lançamentos recentes (menos mainstream)
  // Só usa metade das seeds pra economizar chamadas.
  const songSeeds = queries.slice(0, Math.ceil(queries.length / 2));
  for (const q of songSeeds) {
    try {
      const songs = await api.searchSongs(q);
      for (const s of songs.slice(0, perSeedLimit)) {
        const a = s.artist;
        if (!a || !a.artistId || excludeSet.has(a.artistId)) continue;
        if (!artistMap.has(a.artistId)) {
          artistMap.set(a.artistId, {
            artistId: a.artistId,
            name: a.name,
            thumbnails: s.thumbnails || [],
            _source: 'song-search',
            _seed: q
          });
        }
      }
    } catch (err) {
      console.warn(`[ytmusic] searchSongs("${q}") falhou: ${err.message}`);
    }
  }

  console.log(`[ytmusic] ${artistMap.size} artistas únicos antes do enriquecimento`);
  if (!artistMap.size) return [];

  // 3) Enriquecimento via YT Data API (subscribers, topic, country, thumb HD)
  const ids = [...artistMap.keys()];
  const channels = await getChannelsBatch(ids);
  const channelById = new Map(channels.map(c => [c.id, c]));

  // 4) Merge + filtro + scoring
  const merged = [];
  for (const [artistId, ytMusicArtist] of artistMap) {
    const channel = channelById.get(artistId);
    if (!channel) continue;
    merged.push({
      artistId,
      name: ytMusicArtist.name,
      channel,
      ytMusicData: ytMusicArtist
    });
  }

  const filtered = merged.filter(({ channel }) => {
    const rising = filterRising([channel], { minSubscribers, maxSubscribers });
    return rising.length > 0;
  });

  console.log(`[ytmusic] ${filtered.length} passaram no filtro (${minSubscribers}-${maxSubscribers} subs, tópico musical, BR)`);

  const scored = filtered.map(item => ({
    ...item,
    _score: computeChannelScore(item.channel)
  }));
  // Ordenação: menores primeiro dentro do sweet-spot (mais "em ascensão")
  scored.sort((a, b) => {
    const subsA = Number(a.channel.statistics.subscriberCount || 0);
    const subsB = Number(b.channel.statistics.subscriberCount || 0);
    // Prioriza quem está MAIS perto do minSubscribers (artistas menores)
    return subsA - subsB;
  });

  return scored.slice(0, maxArtists);
}

module.exports = {
  discoverArtists,
  getChannelsBatch,
  normalizeGenre,
  filterRising,
  computeChannelScore,
  resetYTMusic
};

import { StreamLink, UnifiedChannel } from '../types/iptv';

interface ParsedClientM3uEntry {
  id: string;
  baseId: string;
  feedId: string;
  name: string;
  logo: string;
  group: string;
  streams: StreamLink[];
}

function expandAstraClientStreams(stream: StreamLink): StreamLink[] {
  const url = (stream.url || '').trim();
  const astraMatch = url.match(/^(https?:\/\/[^/]+\/play\/[a-z0-9_-]+)\/index\.m3u8(?:\?.*)?$/i);
  if (astraMatch) {
    return [
      {
        ...stream,
        url: astraMatch[1],
      },
      stream,
    ];
  }
  return [stream];
}

let clientCachedCatalog: UnifiedChannel[] | null = null;
let clientLastSyncTime = 0;
let clientSyncPromise: Promise<UnifiedChannel[]> | null = null;
const CLIENT_SYNC_TTL_MS = 5 * 60 * 1000;

export function resetClientCatalogCache() {
  clientCachedCatalog = null;
  clientLastSyncTime = 0;
  clientSyncPromise = null;
}

async function fetchTextWithTimeout(url: string, timeoutMs = 12000): Promise<string> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return '';
    return await res.text();
  } catch {
    return '';
  } finally {
    clearTimeout(timer);
  }
}

async function fetchJsonWithTimeout<T>(url: string, fallback: T, timeoutMs = 12000): Promise<T> {
  const controller = new AbortController();
  const timer = window.setTimeout(() => controller.abort(), timeoutMs);
  try {
    const res = await fetch(url, { signal: controller.signal });
    if (!res.ok) return fallback;
    const cType = res.headers.get('content-type') || '';
    if (cType.includes('text/html')) return fallback;
    return (await res.json()) as T;
  } catch {
    return fallback;
  } finally {
    clearTimeout(timer);
  }
}

function prioritizePlayableStreams(streams: StreamLink[]): StreamLink[] {
  if (streams.length <= 1) return streams;
  return [...streams].sort((a, b) => {
    const score = (s: StreamLink): number => {
      let pts = 0;
      if (s.isGeoBlocked) pts -= 120;
      const u = s.url.toLowerCase();
      if (/\/play\/[a-z0-9_-]+$/i.test(u)) pts += 35;
      else if (u.includes('.m3u8') || u.includes('m3u8')) pts += 25;
      return pts;
    };
    return score(b) - score(a);
  });
}

function parseOfficialIndexM3uClient(m3uText: string): {
  byId: Map<string, ParsedClientM3uEntry>;
  byIdLower: Map<string, ParsedClientM3uEntry>;
  unmatchedByName: Map<string, ParsedClientM3uEntry>;
} {
  const byId = new Map<string, ParsedClientM3uEntry>();
  const byIdLower = new Map<string, ParsedClientM3uEntry>();
  const unmatchedByName = new Map<string, ParsedClientM3uEntry>();

  const lines = m3uText.split(/\r?\n/);
  let currentId = '';
  let currentName = '';
  let currentLogo = '';
  let currentGroup = 'general';
  let currentQuality = 'Live';
  let currentReferrer: string | undefined = undefined;
  let currentUserAgent: string | undefined = undefined;
  let currentGeoBlocked = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      const commaIdx = line.lastIndexOf(',');
      const rawTitle = commaIdx !== -1 ? line.slice(commaIdx + 1).trim() : 'Channel';

      currentGeoBlocked = /\[geo-?blocked\]/i.test(rawTitle);

      const resMatch = rawTitle.match(/\((1080p|720p|576p|540p|480p|360p|240p|144p)\)/i);
      currentQuality = resMatch ? resMatch[1] : 'Live';

      currentName =
        rawTitle
          .replace(/\((1080p|720p|576p|540p|480p|360p|240p|144p)\)/gi, '')
          .replace(/\[.*?\]/g, '')
          .trim() || rawTitle;

      const idMatch = line.match(/tvg-id="([^"]*)"/i);
      currentId = idMatch && idMatch[1].trim() ? idMatch[1].trim() : '';

      const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
      currentLogo = logoMatch && logoMatch[1].trim() ? logoMatch[1].trim() : '';

      const groupMatch = line.match(/group-title="([^"]*)"/i);
      currentGroup = groupMatch && groupMatch[1].trim() ? groupMatch[1].trim() : 'general';

      const refMatch = line.match(/http-referrer="([^"]*)"/i);
      currentReferrer = refMatch && refMatch[1].trim() ? refMatch[1].trim() : undefined;

      const uaMatch = line.match(/http-user-agent="([^"]*)"/i);
      currentUserAgent = uaMatch && uaMatch[1].trim() ? uaMatch[1].trim() : undefined;
    } else if (line.startsWith('#EXTVLCOPT:')) {
      const opt = line.slice('#EXTVLCOPT:'.length).trim();
      if (opt.toLowerCase().startsWith('http-referrer=')) {
        currentReferrer = opt.slice('http-referrer='.length).trim();
      } else if (opt.toLowerCase().startsWith('http-user-agent=')) {
        currentUserAgent = opt.slice('http-user-agent='.length).trim();
      }
    } else if (!line.startsWith('#') && (line.startsWith('http://') || line.startsWith('https://'))) {
      const baseStreamObj: StreamLink = {
        url: line,
        quality: currentQuality,
        httpReferrer: currentReferrer,
        userAgent: currentUserAgent,
        title: currentName,
        isGeoBlocked: currentGeoBlocked,
      };
      const streamVariants = expandAstraClientStreams(baseStreamObj);

      const fullChannelId = currentId.trim();
      const atIdx = fullChannelId.indexOf('@');
      const baseChannelId = atIdx !== -1 ? fullChannelId.slice(0, atIdx).trim() : fullChannelId;
      const feedId = atIdx !== -1 ? fullChannelId.slice(atIdx + 1).trim() : '';

      if (fullChannelId) {
        const lowerKey = fullChannelId.toLowerCase();
        const existing = byId.get(fullChannelId) || byIdLower.get(lowerKey);
        if (existing) {
          for (const st of streamVariants) {
            if (!existing.streams.some((s) => s.url === st.url)) {
              existing.streams.push(st);
            }
          }
          if (!existing.logo && currentLogo) {
            existing.logo = currentLogo;
          }
          if (existing.group === 'general' && currentGroup && currentGroup !== 'general') {
            existing.group = currentGroup;
          }
        } else {
          const entry: ParsedClientM3uEntry = {
            id: fullChannelId,
            baseId: baseChannelId,
            feedId,
            name: currentName || baseChannelId,
            logo: currentLogo,
            group: currentGroup,
            streams: [...streamVariants],
          };
          byId.set(fullChannelId, entry);
          byIdLower.set(lowerKey, entry);
        }
      } else if (currentName) {
        const nameKey = currentName.toLowerCase().trim();
        const existing = unmatchedByName.get(nameKey);
        if (existing) {
          for (const st of streamVariants) {
            if (!existing.streams.some((s) => s.url === st.url)) {
              existing.streams.push(st);
            }
          }
          if (!existing.logo && currentLogo) {
            existing.logo = currentLogo;
          }
        } else {
          unmatchedByName.set(nameKey, {
            id: `m3u-${nameKey.replace(/[^a-z0-9]/g, '-')}`,
            baseId: `m3u-${nameKey.replace(/[^a-z0-9]/g, '-')}`,
            feedId: '',
            name: currentName,
            logo: currentLogo,
            group: currentGroup,
            streams: [...streamVariants],
          });
        }
      }

      currentId = '';
      currentName = '';
      currentLogo = '';
      currentGroup = 'general';
      currentQuality = 'Live';
      currentReferrer = undefined;
      currentUserAgent = undefined;
      currentGeoBlocked = false;
    }
  }

  return { byId, byIdLower, unmatchedByName };
}

export async function getOfficialIptvOrgCatalogClient(forceRefresh = false): Promise<UnifiedChannel[]> {
  if (forceRefresh) {
    resetClientCatalogCache();
  }
  const now = Date.now();
  if (
    clientCachedCatalog &&
    clientCachedCatalog.length > 0 &&
    now - clientLastSyncTime < CLIENT_SYNC_TTL_MS
  ) {
    return clientCachedCatalog;
  }

  if (clientSyncPromise) {
    return clientSyncPromise;
  }

  clientSyncPromise = (async () => {
    try {
      const [
        indexM3uText,
        rawChannels,
        rawStreams,
        rawLogos,
        rawLanguages,
        rawCountries,
        rawFeeds,
      ] = await Promise.all([
        fetchTextWithTimeout('https://iptv-org.github.io/iptv/index.m3u', 14000),
        fetchJsonWithTimeout<any[]>('https://iptv-org.github.io/api/channels.json', [], 12000),
        fetchJsonWithTimeout<any[]>('https://iptv-org.github.io/api/streams.json', [], 12000),
        fetchJsonWithTimeout<any[]>('https://iptv-org.github.io/api/logos.json', [], 10000),
        fetchJsonWithTimeout<any[]>('https://iptv-org.github.io/api/languages.json', [], 8000),
        fetchJsonWithTimeout<any[]>('https://iptv-org.github.io/api/countries.json', [], 8000),
        fetchJsonWithTimeout<any[]>('https://iptv-org.github.io/api/feeds.json', [], 10000),
      ]);

      const parsedM3u = parseOfficialIndexM3uClient(indexM3uText);

      const langCodeMap = new Map<string, string>();
      if (Array.isArray(rawLanguages)) {
        for (const l of rawLanguages) {
          if (l.code && l.name) {
            langCodeMap.set(String(l.code).toLowerCase(), String(l.name));
          }
        }
      }

      const countryMap = new Map<string, { name: string; langs: string[] }>();
      if (Array.isArray(rawCountries)) {
        for (const c of rawCountries) {
          if (c.code && c.name) {
            const code = String(c.code).toUpperCase();
            const langNames = Array.isArray(c.languages)
              ? c.languages
                  .map((lc: string) => langCodeMap.get(String(lc).toLowerCase()) || lc)
                  .filter(Boolean)
              : [];
            countryMap.set(code, { name: String(c.name), langs: langNames });
          }
        }
      }

      const channelLangsMapLower = new Map<string, Set<string>>();
      const feedLangsByFullIdLower = new Map<string, Set<string>>();
      if (Array.isArray(rawFeeds)) {
        for (const f of rawFeeds) {
          if (f.channel && Array.isArray(f.languages)) {
            const lowerCh = String(f.channel).trim().toLowerCase();
            const lowerFeed = f.id ? String(f.id).trim().toLowerCase() : '';
            const set = channelLangsMapLower.get(lowerCh) || new Set<string>();
            const feedSet = new Set<string>();
            for (const lc of f.languages) {
              const resolved = langCodeMap.get(String(lc).toLowerCase());
              if (resolved) {
                set.add(resolved);
                feedSet.add(resolved);
              }
            }
            channelLangsMapLower.set(lowerCh, set);
            if (lowerFeed && feedSet.size > 0) {
              feedLangsByFullIdLower.set(`${lowerCh}@${lowerFeed}`, feedSet);
            }
          }
        }
      }

      const logosByChannelLower = new Map<string, string[]>();
      const logosByFullIdLower = new Map<string, string[]>();
      if (Array.isArray(rawLogos)) {
        for (const l of rawLogos) {
          if (l.channel && l.url) {
            const urlStr = String(l.url).trim();
            if (!urlStr) continue;
            const lowerCh = String(l.channel).trim().toLowerCase();
            const list = logosByChannelLower.get(lowerCh) || [];
            if (!list.includes(urlStr)) {
              list.push(urlStr);
            }
            logosByChannelLower.set(lowerCh, list);

            if (l.feed) {
              const fullKey = `${lowerCh}@${String(l.feed).trim().toLowerCase()}`;
              const fList = logosByFullIdLower.get(fullKey) || [];
              if (!fList.includes(urlStr)) {
                fList.push(urlStr);
              }
              logosByFullIdLower.set(fullKey, fList);
            }
          }
        }
      }

      const channelMetaByIdLower = new Map<string, any>();
      if (Array.isArray(rawChannels)) {
        for (const ch of rawChannels) {
          if (ch && ch.id) {
            channelMetaByIdLower.set(String(ch.id).trim().toLowerCase(), ch);
          }
        }
      }

      const apiStreamsByFullIdLower = new Map<string, StreamLink[]>();
      const apiStreamsByBaseIdLower = new Map<string, StreamLink[]>();
      const unmatchedStreamsByNameLower = new Map<string, StreamLink[]>();

      if (Array.isArray(rawStreams)) {
        for (const s of rawStreams) {
          if (!s.url) continue;
          const rawChId = String(s.channel || '').trim();
          const rawFeed = s.feed ? String(s.feed).trim() : '';
          const baseChId = rawChId.includes('@') ? rawChId.split('@')[0].trim() : rawChId;
          const feedFromCh = rawChId.includes('@') ? rawChId.split('@')[1].trim() : '';
          const effectiveFeed = rawFeed || feedFromCh;

          const baseEntry: StreamLink = {
            url: String(s.url).trim(),
            quality: s.quality ? String(s.quality) : 'Live',
            httpReferrer: s.referrer ? String(s.referrer) : undefined,
            userAgent: s.user_agent ? String(s.user_agent) : undefined,
            title: s.title ? String(s.title) : undefined,
          };
          const variants = expandAstraClientStreams(baseEntry);

          if (baseChId) {
            const lowerBase = baseChId.toLowerCase();
            const baseList = apiStreamsByBaseIdLower.get(lowerBase) || [];
            for (const v of variants) {
              if (!baseList.some((existing) => existing.url === v.url)) {
                baseList.push(v);
              }
            }
            apiStreamsByBaseIdLower.set(lowerBase, baseList);

            if (effectiveFeed) {
              const lowerFull = `${lowerBase}@${effectiveFeed.toLowerCase()}`;
              const fullList = apiStreamsByFullIdLower.get(lowerFull) || [];
              for (const v of variants) {
                if (!fullList.some((existing) => existing.url === v.url)) {
                  fullList.push(v);
                }
              }
              apiStreamsByFullIdLower.set(lowerFull, fullList);
            }
          } else if (s.title) {
            const cleanTitle = String(s.title)
              .replace(/\((1080p|720p|576p|540p|480p|360p|240p|144p)\)/gi, '')
              .replace(/\[.*?\]/g, '')
              .trim()
              .toLowerCase();
            if (cleanTitle) {
              const list = unmatchedStreamsByNameLower.get(cleanTitle) || [];
              for (const v of variants) {
                if (!list.some((existing) => existing.url === v.url)) {
                  list.push(v);
                }
              }
              unmatchedStreamsByNameLower.set(cleanTitle, list);
            }
          }
        }
      }

      const isResolutionFeed = (feed: string) =>
        !feed || /^(\d+p|sd|hd|fhd|uhd|4k|main|plus1)$/i.test(feed.trim());

      const m3uResolutionStreamsByBaseIdLower = new Map<string, StreamLink[]>();
      for (const [, m3uEntry] of parsedM3u.byId.entries()) {
        if (!isResolutionFeed(m3uEntry.feedId)) continue;
        const lowerBase = m3uEntry.baseId.toLowerCase();
        const list = m3uResolutionStreamsByBaseIdLower.get(lowerBase) || [];
        for (const st of m3uEntry.streams) {
          if (!list.some((existing) => existing.url === st.url)) {
            list.push(st);
          }
        }
        m3uResolutionStreamsByBaseIdLower.set(lowerBase, list);
      }

      const seenFullIdsLower = new Set<string>();
      const seenBaseIdsLower = new Set<string>();
      const catalog: UnifiedChannel[] = [];

      // 1. Primary Authoritative Channel List & Logos from https://iptv-org.github.io/iptv/index.m3u
      for (const [chId, m3uEntry] of parsedM3u.byId.entries()) {
        const lowerFullId = chId.toLowerCase();
        const lowerBaseId = m3uEntry.baseId.toLowerCase();
        const meta = channelMetaByIdLower.get(lowerBaseId);
        if (meta?.is_nsfw) continue;
        if (/xxx|adult|porn/i.test(m3uEntry.group)) continue;

        seenFullIdsLower.add(lowerFullId);
        seenBaseIdsLower.add(lowerBaseId);

        const chName = m3uEntry.name || (meta?.name ? String(meta.name).trim() : m3uEntry.baseId);

        const exactFeedStreams = prioritizePlayableStreams([
          ...m3uEntry.streams,
          ...(apiStreamsByFullIdLower.get(lowerFullId) || []),
        ]);
        const allowResolutionFallback = isResolutionFeed(m3uEntry.feedId);
        const siblingM3uStreams = allowResolutionFallback
          ? prioritizePlayableStreams(m3uResolutionStreamsByBaseIdLower.get(lowerBaseId) || [])
          : [];
        const baseApiStreams =
          allowResolutionFallback || exactFeedStreams.length === 0
            ? prioritizePlayableStreams(apiStreamsByBaseIdLower.get(lowerBaseId) || [])
            : [];

        const combinedStreams: StreamLink[] = [];
        for (const st of [...exactFeedStreams, ...siblingM3uStreams, ...baseApiStreams]) {
          if (!combinedStreams.some((existing) => existing.url === st.url)) {
            combinedStreams.push(st);
          }
        }

        const dotParts = m3uEntry.baseId.split('.');
        const fallbackCountry =
          dotParts.length > 1 ? dotParts[dotParts.length - 1].toUpperCase() : 'INT';
        const countryCode = meta?.country
          ? String(meta.country).toUpperCase()
          : fallbackCountry;
        const countryInfo = countryMap.get(countryCode);
        const resolvedCountryName =
          countryInfo?.name ||
          (countryCode === 'INT'
            ? 'International'
            : countryCode === 'UK'
            ? 'United Kingdom'
            : countryCode);

        const rawLogoCandidates = [
          ...(m3uEntry.logo ? [m3uEntry.logo] : []),
          ...(logosByFullIdLower.get(lowerFullId) || []),
          ...(logosByChannelLower.get(lowerBaseId) || []),
          ...(meta?.logo && typeof meta.logo === 'string' ? [meta.logo] : []),
        ];
        const chLogos = Array.from(new Set(rawLogoCandidates.filter(Boolean)));

        const catSet = new Set<string>();
        m3uEntry.group
          .split(';')
          .map((g) => g.trim().toLowerCase())
          .filter(Boolean)
          .forEach((g) => catSet.add(g));
        if (Array.isArray(meta?.categories)) {
          meta.categories.forEach((c: string) => {
            if (c) catSet.add(String(c).trim().toLowerCase());
          });
        }
        if (catSet.size > 1 && catSet.has('general')) {
          catSet.delete('general');
        }
        if (catSet.size === 0) catSet.add('general');

        const langSet = new Set<string>();
        const specificFeedLangs = feedLangsByFullIdLower.get(lowerFullId);
        const baseFeedLangs = channelLangsMapLower.get(lowerBaseId);
        if (specificFeedLangs && specificFeedLangs.size > 0) {
          specificFeedLangs.forEach((l) => langSet.add(l));
        } else if (baseFeedLangs && baseFeedLangs.size > 0) {
          baseFeedLangs.forEach((l) => langSet.add(l));
        }
        if (Array.isArray(meta?.languages)) {
          meta.languages.forEach((lc: string) => {
            const resolved = langCodeMap.get(String(lc).toLowerCase()) || lc;
            if (resolved) langSet.add(resolved);
          });
        }
        if (langSet.size === 0 && countryInfo && countryInfo.langs.length > 0) {
          countryInfo.langs.forEach((l) => langSet.add(l));
        }
        if (langSet.size === 0) {
          langSet.add('English');
        }

        catalog.push({
          id: chId,
          name: chName,
          country: countryCode,
          countryName: resolvedCountryName,
          categories: Array.from(catSet),
          languages: Array.from(langSet),
          logo: chLogos[0] || '',
          logos: chLogos,
          streams: combinedStreams,
        });
      }

      // 2. Unmatched channels in index.m3u
      for (const [nameKey, m3uEntry] of parsedM3u.unmatchedByName.entries()) {
        if (/xxx|adult|porn/i.test(m3uEntry.group)) continue;
        const lowerId = m3uEntry.id.toLowerCase();
        if (seenFullIdsLower.has(lowerId)) continue;
        seenFullIdsLower.add(lowerId);

        const combinedStreams: StreamLink[] = [...prioritizePlayableStreams(m3uEntry.streams)];
        const extraUnmatched = prioritizePlayableStreams(
          unmatchedStreamsByNameLower.get(nameKey) || []
        );
        for (const es of extraUnmatched) {
          if (!combinedStreams.some((existing) => existing.url === es.url)) {
            combinedStreams.push(es);
          }
        }

        const unmatchedCats = m3uEntry.group
          .split(';')
          .map((g) => g.trim().toLowerCase())
          .filter(Boolean);

        catalog.push({
          id: m3uEntry.id,
          name: m3uEntry.name,
          country: 'INT',
          countryName: 'International',
          categories: unmatchedCats.length > 0 ? unmatchedCats : ['general'],
          languages: ['English'],
          logo: m3uEntry.logo || '',
          logos: m3uEntry.logo ? [m3uEntry.logo] : [],
          streams: combinedStreams,
        });
      }

      // 3. Additional channels from streams.json + channels.json
      if (Array.isArray(rawChannels)) {
        for (const ch of rawChannels) {
          if (ch.is_nsfw) continue;
          const chId = String(ch.id || '').trim();
          if (!chId) continue;
          const lowerBaseId = chId.toLowerCase();
          if (seenBaseIdsLower.has(lowerBaseId) || seenFullIdsLower.has(lowerBaseId)) continue;

          const chStreams = apiStreamsByBaseIdLower.get(lowerBaseId) || [];
          if (chStreams.length === 0) continue;
          seenBaseIdsLower.add(lowerBaseId);
          seenFullIdsLower.add(lowerBaseId);

          const chName = String(ch.name || chId).trim();
          const countryCode = String(ch.country || 'INT').toUpperCase();
          const countryInfo = countryMap.get(countryCode);
          const resolvedCountryName =
            countryInfo?.name ||
            (countryCode === 'INT'
              ? 'International'
              : countryCode === 'UK'
              ? 'United Kingdom'
              : countryCode);
          const rawLogoCandidates = [
            ...(ch.logo && typeof ch.logo === 'string' ? [ch.logo] : []),
            ...(logosByChannelLower.get(lowerBaseId) || []),
          ];
          const chLogos = Array.from(new Set(rawLogoCandidates.filter(Boolean)));

          const langSet = new Set<string>();
          const feedLangs = channelLangsMapLower.get(lowerBaseId);
          if (feedLangs && feedLangs.size > 0) {
            feedLangs.forEach((l) => langSet.add(l));
          }
          if (langSet.size === 0 && countryInfo && countryInfo.langs.length > 0) {
            countryInfo.langs.forEach((l) => langSet.add(l));
          }
          if (langSet.size === 0) {
            langSet.add('English');
          }

          catalog.push({
            id: chId,
            name: chName,
            country: countryCode,
            countryName: resolvedCountryName,
            categories:
              Array.isArray(ch.categories) && ch.categories.length > 0
                ? ch.categories
                : ['general'],
            languages: Array.from(langSet),
            logo: chLogos[0] || '',
            logos: chLogos,
            streams: prioritizePlayableStreams(chStreams),
          });
        }
      }

      catalog.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      );

      if (catalog.length > 0) {
        clientCachedCatalog = catalog;
        clientLastSyncTime = Date.now();
      }
      clientSyncPromise = null;
      return catalog;
    } catch (err) {
      clientSyncPromise = null;
      if (clientCachedCatalog && clientCachedCatalog.length > 0) {
        return clientCachedCatalog;
      }
      throw err;
    }
  })();

  return clientSyncPromise;
}

export async function queryOfficialCatalogWithFallback(
  query: string,
  filter: string,
  offset: number,
  limit = 100,
  forceRefresh = false,
  favoriteIds: string[] = []
): Promise<{ items: UnifiedChannel[]; total: number }> {
  try {
    const controller = new AbortController();
    const timer = window.setTimeout(() => controller.abort(), 5000);
    const syncParam = forceRefresh ? '&sync=1' : '';
    const idsParam =
      favoriteIds.length > 0 ? `&ids=${encodeURIComponent(favoriteIds.join(','))}` : '';
    const res = await fetch(
      `/api/iptv-org/catalog?q=${encodeURIComponent(query)}&filter=${encodeURIComponent(
        filter
      )}&offset=${offset}&limit=${limit}${syncParam}${idsParam}`,
      { signal: controller.signal }
    );
    clearTimeout(timer);
    const contentType = res.headers.get('content-type') || '';
    if (res.ok && contentType.includes('application/json')) {
      const data = await res.json();
      if (data && Array.isArray(data.items) && (data.items.length > 0 || filter === 'favorites')) {
        return {
          items: data.items,
          total: typeof data.total === 'number' ? data.total : data.items.length,
        };
      }
    }
  } catch {
    // Backend API not present (e.g. Cloudflare Pages / GitHub Pages static deployment) — fall through to direct client sync!
  }

  const catalog = await getOfficialIptvOrgCatalogClient(forceRefresh);
  const q = query.trim().toLowerCase();
  const f = filter.toLowerCase();

  let filtered = catalog.filter((c) => c.streams.length > 0);

  if (f === 'favorites' || favoriteIds.length > 0) {
    const favSet = new Set(favoriteIds.map((id) => id.toLowerCase()));
    filtered = filtered.filter((c) => favSet.has(c.id.toLowerCase()));
  } else if (f && f !== 'all') {
    if (f === 'entertainment') {
      filtered = filtered.filter((c) =>
        c.categories.some((cat) =>
          ['entertainment', 'general', 'lifestyle', 'comedy', 'culture'].includes(
            cat.toLowerCase()
          )
        )
      );
    } else if (f === 'kids') {
      filtered = filtered.filter((c) =>
        c.categories.some((cat) =>
          ['kids', 'animation', 'family', 'education'].includes(cat.toLowerCase())
        )
      );
    } else {
      filtered = filtered.filter((c) =>
        c.categories.some((cat) => cat.toLowerCase().includes(f))
      );
    }
  }

  if (q) {
    filtered = filtered.filter(
      (c) =>
        c.name.toLowerCase().includes(q) ||
        c.id.toLowerCase().includes(q) ||
        c.country.toLowerCase().includes(q) ||
        (c.countryName && c.countryName.toLowerCase().includes(q)) ||
        c.categories.some((cat) => cat.toLowerCase().includes(q)) ||
        (c.languages && c.languages.some((lang) => lang.toLowerCase().includes(q))) ||
        c.streams.some((s) => s.url.toLowerCase().includes(q))
    );
  }

  return {
    items: filtered.slice(offset, offset + limit),
    total: filtered.length,
  };
}

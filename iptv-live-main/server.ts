import express, { Request, Response } from 'express';
import { createServer as createViteServer } from 'vite';
import http from 'http';
import https from 'https';
import zlib from 'zlib';
import fs from 'fs';
import os from 'os';
import { URL } from 'url';
import path from 'path';
import { spawn } from 'child_process';
import ffmpegPath from 'ffmpeg-static';

const PORT = 3000;

const httpAgent = new http.Agent({ keepAlive: true, maxSockets: 128 });
const httpsAgent = new https.Agent({
  keepAlive: true,
  rejectUnauthorized: false,
  maxSockets: 128,
});

const DEFAULT_BROWSER_UA =
  'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

// Tracks runtime stream health: +1 for working URLs, -1 for dead URLs
const streamHealthScore = new Map<string, number>();
const streamVerifyStatus = new Map<string, 'alive' | 'dead'>();
const inFlightProbes = new Map<string, Promise<boolean>>();
const hostWorkingProfileMap = new Map<string, number>();

// Real-time byte counters for 100% accurate mobile data consumption accounting
let totalProxyBytesServed = 0;
let directElementBytesServed = 0;

function recordStreamOutcome(url: string, ok: boolean) {
  if (!url) return;
  const prev = streamHealthScore.get(url) || 0;
  streamHealthScore.set(url, ok ? Math.min(10, prev + 2) : Math.max(-10, prev - 2));
  streamVerifyStatus.set(url, ok ? 'alive' : 'dead');
}

function isManifestContent(text: string): boolean {
  const cleaned = text.replace(/^\uFEFF/, '').trimStart();
  return (
    cleaned.startsWith('#EXTM3U') ||
    cleaned.slice(0, 1024).includes('#EXTM3U') ||
    cleaned.slice(0, 1024).includes('#EXT-X-TargetDuration') ||
    cleaned.slice(0, 1024).includes('#EXT-X-TARGETDURATION') ||
    cleaned.slice(0, 1024).includes('#EXT-X-STREAM-INF') ||
    cleaned.slice(0, 1024).includes('#EXTINF:')
  );
}

/**
 * Scans the first 376 bytes for MPEG-TS 0x47 sync bytes spaced 188 bytes apart, or FLV magic header
 */
function hasMpegTsOrFlvSync(buf: Buffer): boolean {
  if (buf.length >= 4 && buf[0] === 0x46 && buf[1] === 0x4c && buf[2] === 0x56 && buf[3] === 0x01) {
    return true;
  }
  const limit = Math.min(188, buf.length - 188);
  for (let i = 0; i < limit; i++) {
    if (buf[i] === 0x47 && buf[i + 188] === 0x47) {
      if (buf.length >= i + 377) {
        if (buf[i + 376] === 0x47) return true;
      } else {
        return true;
      }
    }
  }
  return false;
}

function isBinarySegmentUrl(targetUrl: string): boolean {
  try {
    const parsed = new URL(targetUrl);
    const p = parsed.pathname.toLowerCase();
    return /\.(ts|m4s|mp4|aac|m4a|cmfv|cmfa|key|vtt|webvtt|flv|mkv)$/i.test(p);
  } catch {
    return false;
  }
}

/**
 * Helper to perform HTTP/HTTPS requests with redirect following, Set-Cookie preservation, and clean headers.
 */
function fetchUpstream(
  targetUrl: string,
  customHeaders: Record<string, string> = {},
  redirectsLeft = 8,
  timeoutMs = 5500
): Promise<{
  statusCode: number;
  headers: http.IncomingHttpHeaders;
  stream: http.IncomingMessage;
  finalUrl: string;
}> {
  return new Promise((resolve, reject) => {
    let parsed: URL;
    try {
      parsed = new URL(targetUrl);
    } catch {
      return reject(new Error(`Invalid URL: ${targetUrl}`));
    }

    const isHttps = parsed.protocol === 'https:';
    const client = isHttps ? https : http;

    const reqHeaders: Record<string, string> = {
      'User-Agent': customHeaders['user-agent'] || DEFAULT_BROWSER_UA,
      Accept: '*/*',
      'Accept-Language': 'en-US,en;q=0.9',
      'Accept-Encoding': 'identity',
      Connection: 'keep-alive',
    };

    if (customHeaders['Range'] || customHeaders['range']) {
      reqHeaders['Range'] = customHeaders['Range'] || customHeaders['range'];
    }

    if (customHeaders['referer']) {
      reqHeaders['Referer'] = customHeaders['referer'];
    }

    if (customHeaders['cookie']) {
      reqHeaders['Cookie'] = customHeaders['cookie'];
    }

    const options: https.RequestOptions = {
      protocol: parsed.protocol,
      hostname: parsed.hostname,
      port: parsed.port || (isHttps ? 443 : 80),
      path: parsed.pathname + parsed.search,
      method: 'GET',
      agent: isHttps ? httpsAgent : httpAgent,
      timeout: timeoutMs,
      headers: reqHeaders,
    };

    const req = client.request(options, (res) => {
      const status = res.statusCode || 200;
      if ([301, 302, 303, 307, 308].includes(status) && res.headers.location) {
        res.resume();
        if (redirectsLeft <= 0) {
          return reject(new Error('Too many redirects'));
        }
        let nextUrl: string;
        try {
          nextUrl = new URL(res.headers.location, targetUrl).toString();
        } catch {
          return reject(new Error('Invalid redirect location'));
        }

        const nextHeaders = { ...customHeaders };
        const setCookie = res.headers['set-cookie'];
        if (Array.isArray(setCookie) && setCookie.length > 0) {
          const cookiePairs = setCookie.map((c) => c.split(';')[0].trim()).filter(Boolean);
          if (cookiePairs.length > 0) {
            nextHeaders['cookie'] = [nextHeaders['cookie'], ...cookiePairs]
              .filter(Boolean)
              .join('; ');
          }
        }
        return resolve(fetchUpstream(nextUrl, nextHeaders, redirectsLeft - 1, timeoutMs));
      }

      resolve({
        statusCode: status,
        headers: res.headers,
        stream: res,
        finalUrl: targetUrl,
      });
    });

    req.on('timeout', () => {
      req.destroy(Object.assign(new Error('Upstream connection timed out'), { code: 'ETIMEDOUT' }));
    });

    req.on('error', (err) => {
      reject(err);
    });

    req.end();
  });
}

function decodeBufferIfCompressed(buf: Buffer, contentEncoding = ''): Buffer {
  const enc = contentEncoding.toLowerCase();
  try {
    if (enc.includes('gzip') || (buf.length >= 2 && buf[0] === 0x1f && buf[1] === 0x8b)) {
      return zlib.gunzipSync(buf);
    }
    if (enc.includes('deflate')) {
      return zlib.inflateSync(buf);
    }
    if (enc.includes('br')) {
      return zlib.brotliDecompressSync(buf);
    }
  } catch {
    // return original buffer if decompression fails
  }
  return buf;
}

function fetchBuffer(url: string, timeoutMs = 14000): Promise<Buffer> {
  return new Promise(async (resolve, reject) => {
    try {
      const up = await fetchUpstream(url, {}, 8, timeoutMs);
      if (up.statusCode >= 400) {
        up.stream.resume();
        return reject(new Error(`HTTP ${up.statusCode} for ${url}`));
      }
      const chunks: Buffer[] = [];
      up.stream.on('data', (c: Buffer) => chunks.push(c));
      up.stream.on('end', () => {
        const raw = Buffer.concat(chunks);
        const enc = String(up.headers['content-encoding'] || '');
        resolve(decodeBufferIfCompressed(raw, enc));
      });
      up.stream.on('error', reject);
    } catch (err) {
      reject(err);
    }
  });
}

/**
 * Rewrites relative and absolute URLs inside an HLS .m3u8 manifest
 * preserving custom referrer, userAgent, and parent query tokens ONLY when needed.
 */
function rewriteHlsManifest(
  manifestText: string,
  baseUrl: string,
  referrer = '',
  userAgent = ''
): string {
  const extraParams =
    (referrer ? `&referrer=${encodeURIComponent(referrer)}` : '') +
    (userAgent ? `&ua=${encodeURIComponent(userAgent)}` : '');

  let parentQuery = '';
  try {
    const parsedBase = new URL(baseUrl);
    parentQuery = parsedBase.search;
  } catch {
    // ignore
  }

  const resolveWithTokenInheritance = (rawTarget: string): string => {
    const resolvedObj = new URL(rawTarget, baseUrl);
    if (
      !resolvedObj.search &&
      parentQuery &&
      (parentQuery.includes('token') ||
        parentQuery.includes('hdnea') ||
        parentQuery.includes('wmsAuthSign') ||
        parentQuery.includes('auth') ||
        parentQuery.includes('key') ||
        parentQuery.includes('sig') ||
        parentQuery.includes('expires'))
    ) {
      resolvedObj.search = parentQuery;
    }
    return resolvedObj.toString();
  };

  const cleanedText = manifestText.replace(/^\uFEFF/, '');
  const lines = cleanedText.split(/\r?\n/);
  const rewrittenLines = lines.map((line) => {
    const trimmed = line.trim();
    if (!trimmed) return line;

    if (trimmed.startsWith('#')) {
      return line.replace(/URI="([^"]+)"/g, (_match, uriValue) => {
        try {
          const resolved = resolveWithTokenInheritance(uriValue);
          return `URI="/api/proxy/hls?url=${encodeURIComponent(resolved)}${extraParams}"`;
        } catch {
          return _match;
        }
      });
    }

    try {
      const resolved = resolveWithTokenInheritance(trimmed);
      return `/api/proxy/hls?url=${encodeURIComponent(resolved)}${extraParams}`;
    } catch {
      return line;
    }
  });

  return rewrittenLines.join('\n');
}

interface StreamEntry {
  url: string;
  quality: string;
  httpReferrer?: string;
  userAgent?: string;
  title?: string;
  isGeoBlocked?: boolean;
}

interface CachedCatalogItem {
  id: string;
  name: string;
  country: string;
  countryName: string;
  categories: string[];
  languages: string[];
  logo: string;
  logos: string[];
  streams: StreamEntry[];
}

interface ParsedM3uChannelData {
  id: string;
  baseId: string;
  feedId: string;
  name: string;
  logo: string;
  group: string;
  streams: StreamEntry[];
}

/**
 * Expands Astra Cesbo /play/aXXX/index.m3u8?hls URLs with their direct continuous MPEG-TS stream URL
 * because Astra HLS segments are 1.6MB and time out on slow links whereas raw /play/aXXX streams immediately.
 */
function expandAstraStreamVariants(stream: StreamEntry): StreamEntry[] {
  const url = (stream.url || '').trim();
  const astraMatch = url.match(/^(https?:\/\/[^/]+\/play\/[a-z0-9_-]+)\/index\.m3u8(?:\?.*)?$/i);
  if (astraMatch) {
    const directTsUrl = astraMatch[1];
    return [
      {
        ...stream,
        url: directTsUrl,
      },
      stream,
    ];
  }
  return [stream];
}

/**
 * Parses the official https://iptv-org.github.io/iptv/index.m3u master playlist
 * while preserving @feed specifiers so multi-feed channels never mix streams.
 */
function parseOfficialIndexM3u(m3uText: string): {
  byId: Map<string, ParsedM3uChannelData>;
  byIdLower: Map<string, ParsedM3uChannelData>;
  unmatchedByName: Map<string, ParsedM3uChannelData>;
} {
  const byId = new Map<string, ParsedM3uChannelData>();
  const byIdLower = new Map<string, ParsedM3uChannelData>();
  const unmatchedByName = new Map<string, ParsedM3uChannelData>();

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
      const baseStreamObj: StreamEntry = {
        url: line,
        quality: currentQuality,
        httpReferrer: currentReferrer,
        userAgent: currentUserAgent,
        title: currentName,
        isGeoBlocked: currentGeoBlocked,
      };
      const streamVariants = expandAstraStreamVariants(baseStreamObj);

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
          const entry: ParsedM3uChannelData = {
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

let cachedCatalog: CachedCatalogItem[] | null = null;
let lastSyncTimestamp = 0;
let catalogFetchPromise: Promise<CachedCatalogItem[]> | null = null;
const SYNC_TTL_MS = 5 * 60 * 1000;

function resetCatalogCache() {
  cachedCatalog = null;
  lastSyncTimestamp = 0;
  catalogFetchPromise = null;
  streamVerifyStatus.clear();
  streamHealthScore.clear();
}

function prioritizeServerStreams(streams: StreamEntry[]): StreamEntry[] {
  if (streams.length <= 1) return streams;
  return [...streams].sort((a, b) => {
    const score = (s: StreamEntry): number => {
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

/**
 * Fast live stream verifier: probes whether a stream URL actually responds with valid HLS manifest or MPEG-TS data
 */
async function probeStreamUrlAlive(stream: StreamEntry, timeoutMs = 2400): Promise<boolean> {
  const url = stream?.url;
  if (!url) return false;

  const existing = streamVerifyStatus.get(url);
  if (existing === 'alive') return true;
  if (existing === 'dead') return false;

  const inflight = inFlightProbes.get(url);
  if (inflight) return inflight;

  const p = (async () => {
    try {
      const headers: Record<string, string> = {
        'user-agent': stream.userAgent || DEFAULT_BROWSER_UA,
        ...(stream.httpReferrer ? { referer: stream.httpReferrer } : {}),
      };
      const up = await fetchUpstream(url, headers, 4, timeoutMs);
      if (up.statusCode >= 400) {
        up.stream.destroy();
        recordStreamOutcome(url, false);
        return false;
      }

      const contentEncoding = String(up.headers['content-encoding'] || '').toLowerCase();
      const contentType = String(up.headers['content-type'] || '').toLowerCase();

      const firstBytes = await new Promise<Buffer>((resolve) => {
        const chunks: Buffer[] = [];
        let len = 0;
        const timer = setTimeout(() => {
          up.stream.destroy();
          resolve(Buffer.concat(chunks));
        }, 1600);

        up.stream.on('data', (c: Buffer) => {
          chunks.push(c);
          len += c.length;
          if (len >= 4096) {
            clearTimeout(timer);
            up.stream.destroy();
            resolve(Buffer.concat(chunks));
          }
        });
        up.stream.on('end', () => {
          clearTimeout(timer);
          resolve(Buffer.concat(chunks));
        });
        up.stream.on('error', () => {
          clearTimeout(timer);
          resolve(Buffer.concat(chunks));
        });
      });

      if (firstBytes.length === 0) {
        recordStreamOutcome(url, false);
        return false;
      }

      if (
        (firstBytes.length >= 189 && firstBytes[0] === 0x47 && firstBytes[188] === 0x47) ||
        contentType.includes('video/')
      ) {
        recordStreamOutcome(url, true);
        return true;
      }

      const decoded = decodeBufferIfCompressed(firstBytes, contentEncoding);
      const text = decoded.toString('utf-8');
      if (isManifestContent(text)) {
        recordStreamOutcome(url, true);
        return true;
      }

      recordStreamOutcome(url, false);
      return false;
    } catch {
      recordStreamOutcome(url, false);
      return false;
    } finally {
      inFlightProbes.delete(url);
    }
  })();

  inFlightProbes.set(url, p);
  return p;
}

async function syncOfficialIptvOrgCatalog(forceRefresh = false): Promise<CachedCatalogItem[]> {
  const now = Date.now();
  if (!forceRefresh && cachedCatalog && cachedCatalog.length > 0 && now - lastSyncTimestamp < SYNC_TTL_MS) {
    return cachedCatalog;
  }
  if (catalogFetchPromise) {
    return catalogFetchPromise;
  }

  catalogFetchPromise = (async () => {
    try {
      const [
        indexM3uBuf,
        channelsBuf,
        streamsBuf,
        logosBuf,
        languagesBuf,
        countriesBuf,
        feedsBuf,
      ] = await Promise.all([
        fetchBuffer('https://iptv-org.github.io/iptv/index.m3u').catch(() => Buffer.from('')),
        fetchBuffer('https://iptv-org.github.io/api/channels.json').catch(() => Buffer.from('[]')),
        fetchBuffer('https://iptv-org.github.io/api/streams.json').catch(() => Buffer.from('[]')),
        fetchBuffer('https://iptv-org.github.io/api/logos.json').catch(() => Buffer.from('[]')),
        fetchBuffer('https://iptv-org.github.io/api/languages.json').catch(() => Buffer.from('[]')),
        fetchBuffer('https://iptv-org.github.io/api/countries.json').catch(() => Buffer.from('[]')),
        fetchBuffer('https://iptv-org.github.io/api/feeds.json').catch(() => Buffer.from('[]')),
      ]);

      const indexM3uText = indexM3uBuf.toString('utf-8');
      const parsedM3u = parseOfficialIndexM3u(indexM3uText);

      const rawChannels: any[] = JSON.parse(channelsBuf.toString('utf-8') || '[]');
      const rawStreams: any[] = JSON.parse(streamsBuf.toString('utf-8') || '[]');
      const rawLogos: any[] = JSON.parse(logosBuf.toString('utf-8') || '[]');
      const rawLanguages: any[] = JSON.parse(languagesBuf.toString('utf-8') || '[]');
      const rawCountries: any[] = JSON.parse(countriesBuf.toString('utf-8') || '[]');
      const rawFeeds: any[] = JSON.parse(feedsBuf.toString('utf-8') || '[]');

      const langCodeMap = new Map<string, string>();
      for (const l of rawLanguages) {
        if (l.code && l.name) {
          langCodeMap.set(String(l.code).toLowerCase(), String(l.name));
        }
      }

      const countryMap = new Map<string, { name: string; langs: string[] }>();
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

      const channelLangsMapLower = new Map<string, Set<string>>();
      const feedLangsByFullIdLower = new Map<string, Set<string>>();
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

      const logosByChannelLower = new Map<string, string[]>();
      const logosByFullIdLower = new Map<string, string[]>();
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

      const channelMetaByIdLower = new Map<string, any>();
      for (const ch of rawChannels) {
        if (ch && ch.id) {
          channelMetaByIdLower.set(String(ch.id).trim().toLowerCase(), ch);
        }
      }

      // Separate maps for feed-specific vs base channel streams from streams.json
      const apiStreamsByFullIdLower = new Map<string, StreamEntry[]>();
      const apiStreamsByBaseIdLower = new Map<string, StreamEntry[]>();
      const unmatchedStreamsByNameLower = new Map<string, StreamEntry[]>();

      for (const s of rawStreams) {
        if (!s.url) continue;
        const rawChId = String(s.channel || '').trim();
        const rawFeed = s.feed ? String(s.feed).trim() : '';
        const baseChId = rawChId.includes('@') ? rawChId.split('@')[0].trim() : rawChId;
        const feedFromCh = rawChId.includes('@') ? rawChId.split('@')[1].trim() : '';
        const effectiveFeed = rawFeed || feedFromCh;

        const baseEntry: StreamEntry = {
          url: String(s.url).trim(),
          quality: s.quality ? String(s.quality) : 'Live',
          httpReferrer: s.referrer ? String(s.referrer) : undefined,
          userAgent: s.user_agent ? String(s.user_agent) : undefined,
          title: s.title ? String(s.title) : undefined,
        };
        const variants = expandAstraStreamVariants(baseEntry);

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

      const isResolutionFeed = (feed: string) =>
        !feed || /^(\d+p|sd|hd|fhd|uhd|4k|main|plus1)$/i.test(feed.trim());

      const m3uResolutionStreamsByBaseIdLower = new Map<string, StreamEntry[]>();
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
      const catalog: CachedCatalogItem[] = [];

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

        // Combine official index.m3u streams with exact feed streams from streams.json, then append resolution-sibling backups
        const exactFeedStreams = prioritizeServerStreams([
          ...m3uEntry.streams,
          ...(apiStreamsByFullIdLower.get(lowerFullId) || []),
        ]);
        const allowResolutionFallback = isResolutionFeed(m3uEntry.feedId);
        const siblingM3uStreams = allowResolutionFallback
          ? prioritizeServerStreams(m3uResolutionStreamsByBaseIdLower.get(lowerBaseId) || [])
          : [];
        const baseApiStreams =
          allowResolutionFallback || exactFeedStreams.length === 0
            ? prioritizeServerStreams(apiStreamsByBaseIdLower.get(lowerBaseId) || [])
            : [];

        const combinedStreams: StreamEntry[] = [];
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

        // Always prioritize the exact tvg-logo from index.m3u at index 0!
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

      // 2. Channels in index.m3u without a tvg-id
      for (const [nameKey, m3uEntry] of parsedM3u.unmatchedByName.entries()) {
        if (/xxx|adult|porn/i.test(m3uEntry.group)) continue;
        const lowerId = m3uEntry.id.toLowerCase();
        if (seenFullIdsLower.has(lowerId)) continue;
        seenFullIdsLower.add(lowerId);

        const combinedStreams: StreamEntry[] = [...prioritizeServerStreams(m3uEntry.streams)];
        const extraUnmatched = prioritizeServerStreams(
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

      // 3. Any additional channels from https://iptv-org.github.io/api/streams.json + channels.json not already in index.m3u
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
            Array.isArray(ch.categories) && ch.categories.length > 0 ? ch.categories : ['general'],
          languages: Array.from(langSet),
          logo: chLogos[0] || '',
          logos: chLogos,
          streams: prioritizeServerStreams(chStreams),
        });
      }

      catalog.sort((a, b) =>
        a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
      );

      cachedCatalog = catalog;
      lastSyncTimestamp = Date.now();
      catalogFetchPromise = null;
      return catalog;
    } catch (err) {
      catalogFetchPromise = null;
      if (cachedCatalog && cachedCatalog.length > 0) {
        return cachedCatalog;
      }
      throw err;
    }
  })();

  return catalogFetchPromise;
}

const QUALITY_FFMPEG_PRESETS: Record<
  string,
  { height: number; videoBitrate: string; maxrate: string; bufsize: string }
> = {
  '1080p': { height: 1080, videoBitrate: '3200k', maxrate: '3500k', bufsize: '6400k' },
  '720p':  { height: 720,  videoBitrate: '1600k', maxrate: '1800k', bufsize: '3200k' },
  '480p':  { height: 480,  videoBitrate: '850k',  maxrate: '950k',  bufsize: '1700k' },
  '360p':  { height: 360,  videoBitrate: '480k',  maxrate: '550k',  bufsize: '960k' },
  '240p':  { height: 240,  videoBitrate: '230k',  maxrate: '260k',  bufsize: '460k' },
  '144p':  { height: 144,  videoBitrate: '110k',  maxrate: '130k',  bufsize: '220k' },
};

async function startServer() {
  const app = express();

  app.use('/api', (_req, res, next) => {
    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader('Access-Control-Allow-Methods', 'GET, POST, HEAD, OPTIONS');
    res.setHeader('Access-Control-Allow-Headers', 'Range, Content-Type, Accept, Origin');
    res.setHeader('Access-Control-Expose-Headers', 'Content-Length, Content-Range, X-Final-Url');
    if (_req.method === 'OPTIONS') {
      res.status(204).end();
      return;
    }
    next();
  });

  app.all('/api/iptv-org/reset-catalog', async (_req: Request, res: Response) => {
    resetCatalogCache();
    try {
      const catalog = await syncOfficialIptvOrgCatalog(true);
      res.json({
        success: true,
        message: 'IPTV catalog cache reset and synced from official index.m3u',
        totalChannels: catalog.length,
        syncedAt: lastSyncTimestamp,
      });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to re-sync catalog' });
    }
  });

  const FAVORITES_STORE_PATH = path.resolve(process.cwd(), '.streampulse-favorites.json');

  function readPersistedFavorites(): { ids: string[]; channels: any[] } {
    try {
      if (fs.existsSync(FAVORITES_STORE_PATH)) {
        const raw = fs.readFileSync(FAVORITES_STORE_PATH, 'utf-8');
        const parsed = JSON.parse(raw);
        return {
          ids: Array.isArray(parsed?.ids) ? parsed.ids.map(String) : [],
          channels: Array.isArray(parsed?.channels) ? parsed.channels : [],
        };
      }
    } catch {
      // ignore read errors
    }
    return { ids: [], channels: [] };
  }

  function writePersistedFavorites(ids: string[], channels: any[]) {
    try {
      fs.writeFileSync(
        FAVORITES_STORE_PATH,
        JSON.stringify({ ids, channels, updatedAt: Date.now() }),
        'utf-8'
      );
    } catch {
      // ignore write errors
    }
  }

  app.get('/api/favorites', (_req: Request, res: Response) => {
    const data = readPersistedFavorites();
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json(data);
  });

  app.post('/api/favorites', express.json({ limit: '5mb' }), (req: Request, res: Response) => {
    const ids = Array.isArray(req.body?.ids) ? req.body.ids.map(String) : [];
    const channels = Array.isArray(req.body?.channels) ? req.body.channels : [];
    writePersistedFavorites(ids, channels);
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({ success: true, ids, total: ids.length });
  });

  app.get('/api/iptv-org/catalog', async (req: Request, res: Response) => {
    try {
      const forceSync = req.query.sync === '1';
      if (forceSync) {
        resetCatalogCache();
      }
      const catalog = await syncOfficialIptvOrgCatalog(forceSync);
      const q = String(req.query.q || '').trim().toLowerCase();
      const filter = String(req.query.filter || 'all').toLowerCase();
      const rawIds = String(req.query.ids || '').trim();
      const requestedIdList = rawIds
        ? rawIds
            .split(',')
            .map((s) => s.trim())
            .filter(Boolean)
        : [];
      const offset = Math.max(0, parseInt(String(req.query.offset || '0'), 10) || 0);
      const maxAllowedLimit =
        filter === 'favorites' || requestedIdList.length > 0 ? 10000 : 300;
      const limit = Math.min(
        maxAllowedLimit,
        Math.max(20, parseInt(String(req.query.limit || '100'), 10) || 100)
      );

      let filtered = catalog.filter((c) => c.streams.length > 0);

      if (filter === 'favorites' || requestedIdList.length > 0) {
        const persisted = readPersistedFavorites();
        const effectiveIds =
          requestedIdList.length > 0 ? requestedIdList : persisted.ids;
        const idSetLower = new Set(effectiveIds.map((id) => id.toLowerCase()));
        filtered = filtered.filter((c) => idSetLower.has(c.id.toLowerCase()));
      } else if (filter && filter !== 'all') {
        if (filter === 'entertainment') {
          filtered = filtered.filter((c) =>
            c.categories.some((cat) =>
              ['entertainment', 'general', 'lifestyle', 'comedy', 'culture'].includes(
                cat.toLowerCase()
              )
            )
          );
        } else if (filter === 'kids') {
          filtered = filtered.filter((c) =>
            c.categories.some((cat) =>
              ['kids', 'animation', 'family', 'education'].includes(cat.toLowerCase())
            )
          );
        } else {
          filtered = filtered.filter((c) =>
            c.categories.some((cat) => cat.toLowerCase().includes(filter))
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

      const slice = filtered.slice(offset, offset + limit);

      res.json({
        total: filtered.length,
        totalCatalog: catalog.length,
        syncedAt: lastSyncTimestamp,
        offset,
        limit,
        items: slice,
      });
    } catch (err: any) {
      res.status(502).json({ error: err?.message || 'Failed to sync official IPTV-Org catalog' });
    }
  });

  /**
   * Live Stream Fallback Resolver (/api/iptv-org/resolve-stream):
   * Strictly matches ONLY the exact channel ID, exact base channel ID, or exact channel name.
   * Never uses substring matching so unrelated channels are never returned!
   */
  app.get('/api/iptv-org/resolve-stream', async (req: Request, res: Response) => {
    try {
      const channelId = String(req.query.channelId || '').trim().toLowerCase();
      const baseChannelId = channelId.includes('@') ? channelId.split('@')[0].trim() : channelId;
      const name = String(req.query.name || '').trim().toLowerCase();
      const failedUrl = String(req.query.failedUrl || '').trim();

      if (failedUrl) {
        recordStreamOutcome(failedUrl, false);
      }

      const catalog = await syncOfficialIptvOrgCatalog(false);
      const candidates: StreamEntry[] = [];
      const seenUrls = new Set<string>();
      if (failedUrl) seenUrls.add(failedUrl);

      // Pass 1: Exact full channel ID or exact channel name match
      for (const ch of catalog) {
        const chLowerId = ch.id.toLowerCase();
        const exactIdMatch = channelId && chLowerId === channelId;
        const exactNameMatch = name && name.length >= 3 && ch.name.toLowerCase() === name;
        if (exactIdMatch || exactNameMatch) {
          for (const st of ch.streams) {
            if (!seenUrls.has(st.url) && streamVerifyStatus.get(st.url) !== 'dead') {
              seenUrls.add(st.url);
              candidates.push(st);
            }
          }
        }
      }

      // Pass 2: Same base channel ID (e.g. another feed @SD/@HD of the exact same channel)
      if (baseChannelId) {
        for (const ch of catalog) {
          const chBaseId = ch.id.toLowerCase().split('@')[0].trim();
          if (chBaseId === baseChannelId) {
            for (const st of ch.streams) {
              if (!seenUrls.has(st.url) && streamVerifyStatus.get(st.url) !== 'dead') {
                seenUrls.add(st.url);
                candidates.push(st);
              }
            }
          }
        }
      }

      const toProbe = candidates.slice(0, 10);
      for (const st of toProbe) {
        if (streamVerifyStatus.get(st.url) === 'alive') {
          res.json({ stream: st });
          return;
        }
      }

      const results = await Promise.all(
        toProbe.map(async (st) => {
          const ok = await probeStreamUrlAlive(st, 2400);
          return ok ? st : null;
        })
      );

      const working = results.find((r) => r !== null);
      if (working) {
        res.json({ stream: working });
        return;
      }

      res.status(404).json({ error: 'No alternative live stream found for this channel' });
    } catch (err: any) {
      res.status(500).json({ error: err?.message || 'Failed to resolve stream' });
    }
  });

  app.get('/api/proxy/m3u', async (req: Request, res: Response) => {
    const rawUrl = String(req.query.url || '').trim();
    if (!rawUrl) {
      res.status(400).json({ error: 'Missing url query parameter' });
      return;
    }

    try {
      const upstream = await fetchUpstream(rawUrl, {}, 8, 10000);
      if (upstream.statusCode >= 400) {
        upstream.stream.resume();
        res.status(upstream.statusCode).json({ error: `Upstream returned HTTP ${upstream.statusCode}` });
        return;
      }

      res.setHeader('Content-Type', 'text/plain; charset=utf-8');
      res.setHeader('Cache-Control', 'public, max-age=120');
      upstream.stream.pipe(res);
    } catch (err: any) {
      res.status(502).json({ error: err?.message || 'Failed to fetch playlist' });
    }
  });

  /**
   * Lookup full channel metadata from the library by stream URL (/api/iptv-org/lookup-stream)
   */
  app.get('/api/iptv-org/lookup-stream', async (req: Request, res: Response) => {
    try {
      const rawUrl = String(req.query.url || '').trim();
      if (!rawUrl) {
        res.status(400).json({ found: false });
        return;
      }

      const normExact = (u: string): string => {
        const t = (u || '').trim();
        if (!t) return '';
        try {
          const parsed = new URL(t);
          return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}${parsed.search}`;
        } catch {
          return t.replace(/\/+$/, '').toLowerCase();
        }
      };

      const normNoQuery = (u: string): string => {
        const t = (u || '').trim();
        if (!t) return '';
        try {
          const parsed = new URL(t);
          return `${parsed.protocol.toLowerCase()}//${parsed.host.toLowerCase()}${parsed.pathname.replace(/\/+$/, '')}`;
        } catch {
          return t.split('?')[0].replace(/\/+$/, '').toLowerCase();
        }
      };

      const targetExact = normExact(rawUrl);
      const targetNoQuery = normNoQuery(rawUrl);

      const catalog = await syncOfficialIptvOrgCatalog(false);

      for (const ch of catalog) {
        for (let i = 0; i < ch.streams.length; i++) {
          if (normExact(ch.streams[i].url) === targetExact) {
            res.json({ found: true, channel: ch, streamIndex: i });
            return;
          }
        }
      }

      if (targetNoQuery && targetNoQuery.split('/').length >= 4) {
        for (const ch of catalog) {
          for (let i = 0; i < ch.streams.length; i++) {
            if (normNoQuery(ch.streams[i].url) === targetNoQuery) {
              res.json({ found: true, channel: ch, streamIndex: i });
              return;
            }
          }
        }
      }

      res.json({ found: false });
    } catch {
      res.json({ found: false });
    }
  });

  /**
   * Real-time proxy network byte counter endpoint (/api/proxy/bytes-status)
   */
  app.get('/api/proxy/bytes-status', (_req: Request, res: Response) => {
    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
    res.json({
      totalProxyBytesServed,
      directElementBytesServed,
    });
  });

  /**
   * Smart Multi-Profile Upstream Connector with VLC for Android (Videolabs) Compatibility
   */
  async function fetchUpstreamWithProfiles(
    rawUrl: string,
    baseHeaders: Record<string, string>,
    customReferrer: string,
    customUa: string,
    perProfileTimeoutMs = 4500
  ) {
    let parsedOrigin = '';
    let parsedHost = '';
    try {
      const u = new URL(rawUrl);
      parsedOrigin = u.origin;
      parsedHost = u.host.toLowerCase();
    } catch {
      // ignore
    }

    const vlcAndroidUa = 'VLC/3.5.4 LibVLC/3.5.4 (Linux; Android 13)';
    const vlcDesktopUa = 'VLC/3.0.20 LibVLC/3.0.20';

    const allProfiles: Array<{
      id: number;
      headers: Record<string, string>;
      propagateReferer: string;
      propagateUa: string;
    }> = [
      // Profile 0: Explicit Custom UA/Referer (if specified in M3U) or VLC for Android (Videolabs)
      {
        id: 0,
        headers: {
          ...baseHeaders,
          'user-agent': customUa || vlcAndroidUa,
          ...(customReferrer ? { referer: customReferrer } : {}),
        },
        propagateReferer: customReferrer,
        propagateUa: customUa || vlcAndroidUa,
      },
      // Profile 1: Clean Browser UA (with explicit Referer if provided)
      {
        id: 1,
        headers: {
          ...baseHeaders,
          'user-agent': customUa || DEFAULT_BROWSER_UA,
          ...(customReferrer ? { referer: customReferrer } : {}),
        },
        propagateReferer: customReferrer,
        propagateUa: customUa || DEFAULT_BROWSER_UA,
      },
      // Profile 2: VLC/3.0.20 LibVLC with Origin Referer
      {
        id: 2,
        headers: {
          ...baseHeaders,
          'user-agent': vlcDesktopUa,
          ...(customReferrer
            ? { referer: customReferrer }
            : parsedOrigin
            ? { referer: `${parsedOrigin}/` }
            : {}),
        },
        propagateReferer: customReferrer || (parsedOrigin ? `${parsedOrigin}/` : ''),
        propagateUa: vlcDesktopUa,
      },
      // Profile 3: Browser UA with Origin Referer (for CDN hotlink-protected streams)
      {
        id: 3,
        headers: {
          ...baseHeaders,
          'user-agent': DEFAULT_BROWSER_UA,
          ...(customReferrer
            ? { referer: customReferrer }
            : parsedOrigin
            ? { referer: `${parsedOrigin}/` }
            : {}),
        },
        propagateReferer: customReferrer || (parsedOrigin ? `${parsedOrigin}/` : ''),
        propagateUa: DEFAULT_BROWSER_UA,
      },
      // Profile 4: Android ExoPlayer / Lavf FFmpeg IPTV User-Agent
      {
        id: 4,
        headers: {
          ...baseHeaders,
          'user-agent': 'Lavf/60.16.100',
        },
        propagateReferer: '',
        propagateUa: 'Lavf/60.16.100',
      },
    ];

    // Reorder profiles to try the known-working profile for this host first
    const cachedWinnerId = parsedHost ? hostWorkingProfileMap.get(parsedHost) : undefined;
    const profiles =
      cachedWinnerId !== undefined
        ? [
            ...allProfiles.filter((p) => p.id === cachedWinnerId),
            ...allProfiles.filter((p) => p.id !== cachedWinnerId),
          ]
        : allProfiles;

    let lastUpstream: Awaited<ReturnType<typeof fetchUpstream>> | null = null;
    let lastErr: any = null;

    for (let i = 0; i < profiles.length; i++) {
      const p = profiles[i];
      try {
        const up = await fetchUpstream(rawUrl, p.headers, 8, perProfileTimeoutMs);
        const cType = String(up.headers['content-type'] || '').toLowerCase();

        // Reject anti-leech HTML block pages masquerading as 200 OK so we fall through to the next UA profile!
        const isHtmlBlockPage = cType.includes('text/html');

        if (up.statusCode < 400 && !isHtmlBlockPage) {
          recordStreamOutcome(rawUrl, true);
          if (parsedHost) {
            hostWorkingProfileMap.set(parsedHost, p.id);
          }
          return {
            upstream: up,
            usedUa: p.propagateUa,
            usedReferer: p.propagateReferer,
            effectiveUaForFfmpeg: p.headers['user-agent'] || vlcAndroidUa,
            effectiveRefererForFfmpeg: p.headers['referer'] || '',
          };
        }

        if (lastUpstream) {
          lastUpstream.stream.resume();
        }
        lastUpstream = up;

        if (!isHtmlBlockPage && ![400, 401, 403, 404, 405, 406, 429, 500, 502, 503].includes(up.statusCode)) {
          break;
        }
      } catch (err: any) {
        lastErr = err;
        const code = String(err?.code || '');
        if (
          code === 'ENOTFOUND' ||
          code === 'ECONNREFUSED' ||
          code === 'ETIMEDOUT' ||
          code === 'EHOSTUNREACH' ||
          code === 'ENETUNREACH'
        ) {
          break;
        }
      }
    }

    recordStreamOutcome(rawUrl, false);

    if (lastUpstream) {
      return {
        upstream: lastUpstream,
        usedUa: customUa,
        usedReferer: customReferrer,
        effectiveUaForFfmpeg: customUa || vlcAndroidUa,
        effectiveRefererForFfmpeg: customReferrer,
      };
    }
    throw lastErr || new Error('Unable to connect to upstream server');
  }

  /**
   * Universal HTTP & HTTPS HLS, MPEG-TS & Media Stream Proxy (/api/proxy/hls & /api/proxy/stream)
   * Properly distinguishes binary media segments from HLS manifests and tracks real network bytes.
   */
  app.get(['/api/proxy/hls', '/api/proxy/stream'], async (req: Request, res: Response) => {
    const rawUrl = String(req.query.url || '').trim();
    const customReferrer = String(req.query.referrer || '').trim();
    const customUa = String(req.query.ua || '').trim();
    const expectManifest = String(req.query.expect || '') === 'manifest';
    const isInternalFfmpeg = String(req.query.internal || '') === '1';
    const isDirectVideoRoute = req.path === '/api/proxy/stream';

    res.setHeader('Access-Control-Allow-Origin', '*');
    res.setHeader(
      'Access-Control-Expose-Headers',
      'Content-Length, Content-Range, Content-Type, X-Final-Url'
    );

    if (!rawUrl) {
      res.status(400).json({ error: 'Missing url query parameter' });
      return;
    }

    const accountBytes = (len: number) => {
      if (len > 0 && !isInternalFfmpeg) {
        totalProxyBytesServed += len;
        if (isDirectVideoRoute) {
          directElementBytesServed += len;
        }
      }
    };

    try {
      const forwardHeaders: Record<string, string> = {};
      const isStaticArchiveMedia = /\.(mp4|m4v|webm|mov|mkv)(\?|$)/i.test(rawUrl);
      if (req.headers.range && isStaticArchiveMedia) {
        forwardHeaders['Range'] = String(req.headers.range);
      }

      const { upstream, usedUa, usedReferer } = await fetchUpstreamWithProfiles(
        rawUrl,
        forwardHeaders,
        customReferrer,
        customUa
      );

      if (upstream.statusCode >= 400) {
        upstream.stream.resume();
        res.status(upstream.statusCode).json({
          error: `Stream server returned HTTP ${upstream.statusCode}`,
        });
        return;
      }

      const contentType = String(upstream.headers['content-type'] || '').toLowerCase();
      const contentEncoding = String(upstream.headers['content-encoding'] || '').toLowerCase();
      const isManifestMimeOrExt =
        contentType.includes('mpegurl') ||
        contentType.includes('m3u') ||
        /\.m3u8?(\?|$)/i.test(upstream.finalUrl) ||
        /\.m3u8?(\?|$)/i.test(rawUrl);

      const isKnownBinarySegment =
        !expectManifest &&
        !isManifestMimeOrExt &&
        (isBinarySegmentUrl(upstream.finalUrl) ||
          contentType.includes('video/mp2t') ||
          contentType.includes('video/mp4') ||
          contentType.includes('video/x-flv') ||
          contentType.includes('video/iso.segment') ||
          (contentType.includes('audio/') && !contentType.includes('mpegurl')));

      res.setHeader('X-Final-Url', upstream.finalUrl);

      // Fast-path: direct piping for known binary segments (.ts, .m4s, .aac, .mp4, .key)
      if (isKnownBinarySegment) {
        res.status(upstream.statusCode);
        res.setHeader('Content-Type', upstream.headers['content-type'] || 'video/mp2t');
        if (upstream.headers['content-length']) {
          res.setHeader('Content-Length', upstream.headers['content-length']);
        }
        if (upstream.headers['content-range']) {
          res.setHeader('Content-Range', upstream.headers['content-range']);
        }
        res.setHeader('Cache-Control', 'no-cache');
        upstream.stream.on('data', (chunk: Buffer) => {
          accountBytes(chunk.length);
        });
        upstream.stream.pipe(res);
        req.on('close', () => {
          upstream.stream.destroy();
        });
        return;
      }

      // Otherwise inspect initial bytes for HLS manifest vs binary media stream
      let mode: 'undecided' | 'manifest' | 'binary' = 'undecided';
      const manifestChunks: Buffer[] = [];
      let totalManifestBytes = 0;
      const MAX_MANIFEST_SIZE = 5 * 1024 * 1024;

      upstream.stream.on('data', (chunk: Buffer) => {
        if (mode === 'undecided') {
          manifestChunks.push(chunk);
          totalManifestBytes += chunk.length;
          const combinedInitial = Buffer.concat(manifestChunks);

          // Wait until we have at least 380 bytes before deciding if it's binary MPEG-TS vs manifest
          if (combinedInitial.length < 380 && !isManifestContent(combinedInitial.toString('utf-8'))) {
            return;
          }

          if (hasMpegTsOrFlvSync(combinedInitial)) {
            if (expectManifest) {
              upstream.stream.destroy();
              if (!res.headersSent) {
                res.status(415).json({
                  error: 'Raw MPEG-TS/FLV stream requires MPEG-TS or Transcode engine',
                });
              }
              return;
            }
            mode = 'binary';
            res.status(upstream.statusCode);
            res.setHeader('Content-Type', upstream.headers['content-type'] || 'video/mp2t');
            res.setHeader('Cache-Control', 'no-cache');
            accountBytes(combinedInitial.length);
            res.write(combinedInitial);
            return;
          }

          const isGzipMagic =
            combinedInitial.length >= 2 &&
            combinedInitial[0] === 0x1f &&
            combinedInitial[1] === 0x8b;

          if (!expectManifest && !contentEncoding && !isGzipMagic && !isManifestMimeOrExt) {
            const preview = combinedInitial
              .slice(0, Math.min(combinedInitial.length, 512))
              .toString('utf-8')
              .trimStart();
            const looksLikeManifest =
              preview.startsWith('#EXTM3U') ||
              preview.includes('#EXT-X-') ||
              preview.includes('#EXTINF');
            if (!looksLikeManifest) {
              mode = 'binary';
              res.status(upstream.statusCode);
              res.setHeader(
                'Content-Type',
                upstream.headers['content-type'] || 'application/octet-stream'
              );
              if (upstream.headers['content-length']) {
                res.setHeader('Content-Length', upstream.headers['content-length']);
              }
              res.setHeader('Cache-Control', 'no-cache');
              accountBytes(combinedInitial.length);
              res.write(combinedInitial);
              return;
            }
          }

          mode = 'manifest';
          return;
        }

        if (mode === 'manifest') {
          totalManifestBytes += chunk.length;
          if (totalManifestBytes <= MAX_MANIFEST_SIZE) {
            manifestChunks.push(chunk);
          } else if (expectManifest) {
            upstream.stream.destroy();
            if (!res.headersSent) {
              res.status(415).json({
                error: 'Continuous stream requires MPEG-TS or Transcode engine',
              });
            }
          }
        } else {
          accountBytes(chunk.length);
          const canContinue = res.write(chunk);
          if (!canContinue) {
            upstream.stream.pause();
            res.once('drain', () => upstream.stream.resume());
          }
        }
      });

      upstream.stream.on('end', () => {
        if ((mode === 'manifest' || mode === 'undecided') && !res.headersSent) {
          const rawBuf = Buffer.concat(manifestChunks);
          const decodedBuf = decodeBufferIfCompressed(rawBuf, contentEncoding);
          const fullText = decodedBuf.toString('utf-8');

          if (isManifestContent(fullText)) {
            let rewritten = rewriteHlsManifest(
              fullText,
              upstream.finalUrl,
              usedReferer,
              usedUa
            );
            if (isInternalFfmpeg) {
              rewritten = rewritten.replace(/\/api\/proxy\/hls\?url=/g, `http://127.0.0.1:${PORT}/api/proxy/hls?internal=1&url=`);
            }
            const outBuf = Buffer.from(rewritten, 'utf-8');
            accountBytes(outBuf.length);
            res.setHeader('Content-Type', 'application/vnd.apple.mpegurl; charset=utf-8');
            res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');
            res.status(200).send(outBuf);
          } else if (expectManifest) {
            recordStreamOutcome(rawUrl, false);
            res.status(415).json({
              error: 'Upstream response is not a valid HLS manifest',
            });
          } else {
            accountBytes(decodedBuf.length);
            res.setHeader('Content-Type', contentType || 'application/octet-stream');
            res.status(upstream.statusCode).send(decodedBuf);
          }
        } else if (!res.headersSent) {
          res.status(502).end();
        } else {
          res.end();
        }
      });

      upstream.stream.on('error', () => {
        if (!res.headersSent) {
          res.status(502).end();
        } else {
          res.end();
        }
      });

      req.on('close', () => {
        upstream.stream.destroy();
      });
    } catch (err: any) {
      if (!res.headersSent) {
        res.status(502).json({ error: err?.message || 'Stream proxy error' });
      }
    }
  });

  /**
   * Real-Time FFmpeg H.264 + AAC Universal Transcoder & Mobile Data-Saver Downscaler (/api/proxy/transcode)
   * Decodes any VLC-compatible stream (HEVC, MPEG-2, AC-3, E-AC-3, RTSP, RTMP, FLV, MPEG-TS, HLS)
   * and downscales to exact 1080p/720p/480p/360p/240p/144p bitrates to genuinely save mobile data!
   */
  app.get('/api/proxy/transcode', async (req: Request, res: Response) => {
    const rawUrl = String(req.query.url || '').trim();
    const quality = String(req.query.quality || '720p').trim();
    const format = String(req.query.format || 'mp4').trim();
    const customReferrer = String(req.query.referrer || '').trim();
    const customUa = String(req.query.ua || '').trim();

    if (!rawUrl || !ffmpegPath) {
      res.status(400).json({ error: 'Missing stream URL or FFmpeg binary' });
      return;
    }

    const preset = QUALITY_FFMPEG_PRESETS[quality] || QUALITY_FFMPEG_PRESETS['720p'];
    const audioBitrate =
      preset.height <= 240 ? '64k' : preset.height <= 480 ? '96k' : '128k';

    // Route HTTP/HTTPS streams through our local proxy so FFmpeg gets automatic VLC User-Agent profiles,
    // self-signed SSL cert bypass, cookie-preserving redirects, and token inheritance!
    const isHttpOrHttps = /^https?:\/\//i.test(rawUrl);
    const extraQuery =
      (customReferrer ? `&referrer=${encodeURIComponent(customReferrer)}` : '') +
      (customUa ? `&ua=${encodeURIComponent(customUa)}` : '');
    const targetInputUrl = isHttpOrHttps
      ? `http://127.0.0.1:${PORT}/api/proxy/hls?internal=1&url=${encodeURIComponent(rawUrl)}${extraQuery}`
      : rawUrl;

    const ffmpegArgs: string[] = [
      '-loglevel',
      'error',
      '-analyzeduration',
      '1200000',
      '-probesize',
      '1200000',
      '-fflags',
      '+genpts+discardcorrupt+igndts+nobuffer',
    ];

    if (/^rtsp:\/\//i.test(rawUrl)) {
      ffmpegArgs.push('-rtsp_transport', 'tcp');
    } else if (isHttpOrHttps) {
      ffmpegArgs.push(
        '-reconnect',
        '1',
        '-reconnect_streamed',
        '1',
        '-reconnect_delay_max',
        '2',
        '-rw_timeout',
        '12000000'
      );
    }

    ffmpegArgs.push(
      '-i',
      targetInputUrl,
      '-map',
      '0:v:0?',
      '-map',
      '0:a:0?',
      '-sn',
      '-dn',
      '-vf',
      `scale=-2:${preset.height}`,
      '-r',
      preset.height <= 240 ? '24' : '30',
      '-c:v',
      'libx264',
      '-preset',
      'ultrafast',
      '-tune',
      'zerolatency',
      '-profile:v',
      'main',
      '-level',
      '4.1',
      '-pix_fmt',
      'yuv420p',
      '-b:v',
      preset.videoBitrate,
      '-maxrate',
      preset.maxrate,
      '-bufsize',
      preset.bufsize,
      '-g',
      '30',
      '-c:a',
      'aac',
      '-b:a',
      audioBitrate,
      '-ar',
      '44100',
      '-ac',
      '2'
    );

    if (format === 'mpegts') {
      res.setHeader('Content-Type', 'video/mp2t');
      ffmpegArgs.push(
        '-f',
        'mpegts',
        '-mpegts_flags',
        '+resend_headers+initial_discontinuity',
        'pipe:1'
      );
    } else {
      res.setHeader('Content-Type', 'video/mp4');
      ffmpegArgs.push(
        '-f',
        'mp4',
        '-movflags',
        'frag_keyframe+empty_moov+default_base_moof',
        'pipe:1'
      );
    }

    res.setHeader('Cache-Control', 'no-store, no-cache, must-revalidate');

    const ffProc = spawn(ffmpegPath as unknown as string, ffmpegArgs, {
      stdio: ['ignore', 'pipe', 'pipe'],
    });

    ffProc.stdout.on('data', (chunk: Buffer) => {
      totalProxyBytesServed += chunk.length;
      if (format !== 'mpegts') {
        directElementBytesServed += chunk.length;
      }
    });

    ffProc.stdout.pipe(res);

    ffProc.on('error', () => {
      if (!res.headersSent) {
        res.status(502).end();
      } else {
        res.end();
      }
    });

    ffProc.on('close', () => {
      res.end();
    });

    req.on('close', () => {
      try {
        ffProc.kill('SIGKILL');
      } catch {
        // ignore
      }
    });
  });

  /**
   * Fast MP4 Recording Remuxer/Converter (POST /api/proxy/remux-mp4):
   * Ensures any browser screen recording (even if recorded by MediaRecorder in WebM on older browsers)
   * is converted into a 100% compliant H.264 + AAC .mp4 file before download!
   */
  app.post(
    '/api/proxy/remux-mp4',
    express.raw({ type: '*/*', limit: '250mb' }),
    async (req: Request, res: Response) => {
      const inputBuffer = req.body as Buffer;
      if (!inputBuffer || !Buffer.isBuffer(inputBuffer) || inputBuffer.length === 0 || !ffmpegPath) {
        res.status(400).json({ error: 'Empty recording payload or missing FFmpeg' });
        return;
      }

      const tmpId = `${Date.now()}-${Math.random().toString(36).slice(2, 8)}`;
      const inPath = path.join(os.tmpdir(), `rec-in-${tmpId}.webm`);
      const outPath = path.join(os.tmpdir(), `rec-out-${tmpId}.mp4`);

      const cleanupTmp = () => {
        fs.promises.unlink(inPath).catch(() => {});
        fs.promises.unlink(outPath).catch(() => {});
      };

      try {
        await fs.promises.writeFile(inPath, inputBuffer);

        await new Promise<void>((resolve, reject) => {
          const ff = spawn(
            ffmpegPath as unknown as string,
            [
              '-y',
              '-loglevel',
              'error',
              '-i',
              inPath,
              '-c:v',
              'libx264',
              '-preset',
              'ultrafast',
              '-profile:v',
              'main',
              '-level',
              '4.1',
              '-pix_fmt',
              'yuv420p',
              '-c:a',
              'aac',
              '-b:a',
              '128k',
              '-movflags',
              '+faststart',
              '-f',
              'mp4',
              outPath,
            ],
            { stdio: ['ignore', 'ignore', 'pipe'] }
          );

          ff.on('error', reject);
          ff.on('close', (code) => {
            if (code === 0) resolve();
            else reject(new Error(`FFmpeg exited with code ${code}`));
          });
        });

        const mp4Buffer = await fs.promises.readFile(outPath);
        cleanupTmp();
        res.setHeader('Content-Type', 'video/mp4');
        res.setHeader('Content-Length', String(mp4Buffer.length));
        res.status(200).send(mp4Buffer);
      } catch (err: any) {
        cleanupTmp();
        res.status(500).json({ error: err?.message || 'MP4 conversion failed' });
      }
    }
  );

  // Serve root logo.png and favicon.png directly from the workspace root directory
  app.get('/logo.png', (_req: Request, res: Response) => {
    const rootLogoPath = path.resolve(process.cwd(), 'logo.png');
    if (fs.existsSync(rootLogoPath)) {
      res.setHeader('Content-Type', 'image/png');
      res.sendFile(rootLogoPath);
      return;
    }
    res.status(404).end();
  });

  app.get(['/favicon.png', '/favicon.ico'], (_req: Request, res: Response) => {
    const rootFaviconPath = path.resolve(process.cwd(), 'favicon.png');
    if (fs.existsSync(rootFaviconPath)) {
      res.setHeader('Content-Type', 'image/png');
      res.sendFile(rootFaviconPath);
      return;
    }
    res.status(404).end();
  });

  if (process.env.NODE_ENV !== 'production') {
    const vite = await createViteServer({
      server: { middlewareMode: true },
      appType: 'spa',
    });
    app.use(vite.middlewares);
  } else {
    const distPath = path.resolve(process.cwd(), 'dist');
    app.use(express.static(distPath));
    app.get('*', (_req, res) => {
      res.sendFile(path.join(distPath, 'index.html'));
    });
  }

  app.listen(PORT, '0.0.0.0', () => {
    console.log(`IPTV LIVE – Online IPTV Player for Live TV Streaming running on http://0.0.0.0:${PORT}`);
    syncOfficialIptvOrgCatalog(true).catch(() => {});
    setInterval(() => {
      syncOfficialIptvOrgCatalog(true).catch(() => {});
    }, SYNC_TTL_MS);
  });
}

startServer();

import { UnifiedChannel, StreamLink } from '../types/iptv';

/**
 * Parses an M3U / M3U8 playlist file and groups multiple stream URLs belonging to the same channel
 * into a single UnifiedChannel entry with a `streams: StreamLink[]` array, sorted strictly A to Z.
 */
export function parseM3uToUnifiedChannels(
  m3uContent: string,
  sourceId: string,
  maxChannels = 4000
): UnifiedChannel[] {
  const lines = m3uContent.split(/\r?\n/);
  const channelMap = new Map<string, UnifiedChannel>();

  let currentName = '';
  let currentId = '';
  let currentLogo = '';
  let currentGroup = 'general';
  let currentCountry = 'INT';
  let currentLanguages: string[] = [];
  let currentReferrer: string | undefined = undefined;
  let currentUserAgent: string | undefined = undefined;
  let currentQuality = 'Live';

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (!line) continue;

    if (line.startsWith('#EXTINF:')) {
      const commaIndex = line.lastIndexOf(',');
      const rawTitle = commaIndex !== -1 ? line.slice(commaIndex + 1).trim() : 'Live Channel';

      const resMatch = rawTitle.match(/\((1080p|720p|576p|480p|360p|240p|144p)\)/i);
      currentQuality = resMatch ? resMatch[1] : 'Live';

      currentName =
        rawTitle
          .replace(/\((1080p|720p|576p|480p|360p|240p|144p)\)/gi, '')
          .replace(/\[.*?\]/g, '')
          .trim() || rawTitle;

      const idMatch = line.match(/tvg-id="([^"]*)"/i);
      currentId = idMatch && idMatch[1].trim() ? idMatch[1].trim() : '';

      const logoMatch = line.match(/tvg-logo="([^"]*)"/i);
      currentLogo = logoMatch ? logoMatch[1].trim() : '';

      const groupMatch = line.match(/group-title="([^"]*)"/i);
      currentGroup = groupMatch && groupMatch[1].trim() ? groupMatch[1].trim() : 'general';

      const countryMatch = line.match(/tvg-country="([^"]*)"/i);
      currentCountry = countryMatch && countryMatch[1].trim() ? countryMatch[1].trim() : 'INT';

      const langMatch = line.match(/tvg-language="([^"]*)"/i);
      currentLanguages =
        langMatch && langMatch[1].trim()
          ? langMatch[1]
              .split(';')
              .map((s) => s.trim())
              .filter(Boolean)
          : [];

      const refAttr = line.match(/http-referrer="([^"]*)"/i);
      if (refAttr && refAttr[1]) currentReferrer = refAttr[1];

      const uaAttr = line.match(/http-user-agent="([^"]*)"/i);
      if (uaAttr && uaAttr[1]) currentUserAgent = uaAttr[1];
    } else if (line.startsWith('#EXTVLCOPT:')) {
      const opt = line.slice('#EXTVLCOPT:'.length).trim();
      if (opt.toLowerCase().startsWith('http-referrer=')) {
        currentReferrer = opt.slice('http-referrer='.length).trim();
      } else if (opt.toLowerCase().startsWith('http-user-agent=')) {
        currentUserAgent = opt.slice('http-user-agent='.length).trim();
      }
    } else if (!line.startsWith('#')) {
      if (line.startsWith('http://') || line.startsWith('https://')) {
        const key = (currentId || currentName || line).toLowerCase();
        const streamItem: StreamLink = {
          url: line,
          quality: currentQuality,
          httpReferrer: currentReferrer,
          userAgent: currentUserAgent,
          title: currentName,
        };

        const existing = channelMap.get(key);
        if (existing) {
          if (!existing.streams.some((s) => s.url === line)) {
            existing.streams.push(streamItem);
          }
          if (currentLogo) {
            if (!existing.logo) existing.logo = currentLogo;
            if (!existing.logos) existing.logos = [];
            if (!existing.logos.includes(currentLogo)) {
              existing.logos.push(currentLogo);
            }
          }
        } else {
          if (channelMap.size < maxChannels) {
            channelMap.set(key, {
              id: currentId || `${sourceId}-${channelMap.size}`,
              name: currentName || `Channel ${channelMap.size + 1}`,
              country: currentCountry,
              categories: currentGroup
                .split(';')
                .map((s) => s.trim())
                .filter(Boolean),
              languages: currentLanguages,
              logo: currentLogo,
              logos: currentLogo ? [currentLogo] : [],
              streams: [streamItem],
            });
          }
        }
      }

      currentName = '';
      currentId = '';
      currentLogo = '';
      currentGroup = 'general';
      currentCountry = 'INT';
      currentLanguages = [];
      currentReferrer = undefined;
      currentUserAgent = undefined;
      currentQuality = 'Live';
    }
  }

  return Array.from(channelMap.values()).sort((a, b) =>
    a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
  );
}

/**
 * Builds the backend proxy URL for HLS, raw MPEG-TS, or FFmpeg transcoding, preserving custom Referer and User-Agent headers.
 */
export function buildProxiedStreamUrl(
  stream: StreamLink,
  mode: 'hls-proxy' | 'raw-ts' | 'ffmpeg-mp4' | 'ffmpeg-mpegts',
  quality: string = 'auto'
): string {
  const extra =
    (stream.httpReferrer ? `&referrer=${encodeURIComponent(stream.httpReferrer)}` : '') +
    (stream.userAgent ? `&ua=${encodeURIComponent(stream.userAgent)}` : '');

  if (mode === 'ffmpeg-mp4') {
    const q = quality === 'auto' ? '720p' : quality;
    return `/api/proxy/transcode?url=${encodeURIComponent(stream.url)}&quality=${encodeURIComponent(q)}&format=mp4${extra}`;
  }
  if (mode === 'ffmpeg-mpegts') {
    const q = quality === 'auto' ? '720p' : quality;
    return `/api/proxy/transcode?url=${encodeURIComponent(stream.url)}&quality=${encodeURIComponent(q)}&format=mpegts${extra}`;
  }
  if (mode === 'raw-ts') {
    return `/api/proxy/hls?url=${encodeURIComponent(stream.url)}${extra}`;
  }
  return `/api/proxy/hls?url=${encodeURIComponent(stream.url)}&expect=manifest${extra}`;
}

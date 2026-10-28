function isManifestContentEdge(text: string): boolean {
  const cleaned = text.replace(/^\uFEFF/, '').trimStart();
  return (
    cleaned.startsWith('#EXTM3U') ||
    cleaned.slice(0, 512).includes('#EXTM3U') ||
    cleaned.slice(0, 512).includes('#EXT-X-TargetDuration') ||
    cleaned.slice(0, 512).includes('#EXT-X-TARGETDURATION') ||
    cleaned.slice(0, 512).includes('#EXT-X-STREAM-INF')
  );
}

function rewriteHlsManifestEdge(
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
    parentQuery = new URL(baseUrl).search;
  } catch {
    // ignore
  }

  const resolveUrl = (rawTarget: string): string => {
    const resolvedObj = new URL(rawTarget, baseUrl);
    if (
      !resolvedObj.search &&
      parentQuery &&
      (parentQuery.includes('token') ||
        parentQuery.includes('hdnea') ||
        parentQuery.includes('wmsAuthSign') ||
        parentQuery.includes('auth') ||
        parentQuery.includes('key') ||
        parentQuery.includes('sig'))
    ) {
      resolvedObj.search = parentQuery;
    }
    return resolvedObj.toString();
  };

  return manifestText
    .replace(/^\uFEFF/, '')
    .split(/\r?\n/)
    .map((line) => {
      const trimmed = line.trim();
      if (!trimmed) return line;

      if (trimmed.startsWith('#')) {
        return line.replace(/URI="([^"]+)"/g, (_match, uriValue) => {
          try {
            const resolved = resolveUrl(uriValue);
            return `URI="/api/proxy/hls?url=${encodeURIComponent(resolved)}${extraParams}"`;
          } catch {
            return _match;
          }
        });
      }

      try {
        const resolved = resolveUrl(trimmed);
        return `/api/proxy/hls?url=${encodeURIComponent(resolved)}${extraParams}`;
      } catch {
        return line;
      }
    })
    .join('\n');
}

export const onRequest = async (context: { request: Request }): Promise<Response> => {
  const reqUrl = new URL(context.request.url);
  if (context.request.method === 'OPTIONS') {
    return new Response(null, {
      status: 204,
      headers: {
        'Access-Control-Allow-Origin': '*',
        'Access-Control-Allow-Methods': 'GET, HEAD, OPTIONS',
        'Access-Control-Allow-Headers': 'Range, Content-Type, Accept, Origin',
      },
    });
  }

  const targetUrl = (reqUrl.searchParams.get('url') || '').trim();
  const customReferrer = (reqUrl.searchParams.get('referrer') || '').trim();
  const customUa = (reqUrl.searchParams.get('ua') || '').trim();
  const expectManifest = reqUrl.searchParams.get('expect') === 'manifest';

  if (!targetUrl) {
    return new Response(JSON.stringify({ error: 'Missing url parameter' }), {
      status: 400,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }

  let parsedOrigin = '';
  try {
    parsedOrigin = new URL(targetUrl).origin;
  } catch {
    // ignore
  }

  const rangeHeader = context.request.headers.get('Range');

  const buildHeaders = (ua: string, ref: string) => {
    const h = new Headers();
    h.set('User-Agent', ua);
    h.set('Accept', '*/*');
    if (ref) h.set('Referer', ref);
    if (rangeHeader) h.set('Range', rangeHeader);
    return h;
  };

  const defaultUa =
    customUa ||
    'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36';

  try {
    // Profile 1: Clean Browser UA (only sends Referer if explicitly specified in index.m3u)
    let propagateUa = customUa;
    let propagateRef = customReferrer;
    let upstream = await fetch(targetUrl, {
      method: 'GET',
      headers: buildHeaders(defaultUa, customReferrer),
      redirect: 'follow',
    });

    // Profile 2: VLC/3.0.20 + Origin Referer
    if ([400, 401, 403, 404, 406].includes(upstream.status)) {
      const fallbackRef = customReferrer || (parsedOrigin ? `${parsedOrigin}/` : '');
      propagateUa = 'VLC/3.0.20 LibVLC/3.0.20';
      propagateRef = fallbackRef;
      upstream = await fetch(targetUrl, {
        method: 'GET',
        headers: buildHeaders(propagateUa, fallbackRef),
        redirect: 'follow',
      });
    }

    // Profile 3: Android ExoPlayer IPTV User-Agent
    if ([400, 401, 403, 404, 406].includes(upstream.status)) {
      propagateUa = 'plaYtv/7.0.5 (Linux;Android 9) ExoPlayerLib/2.10.4';
      propagateRef = '';
      upstream = await fetch(targetUrl, {
        method: 'GET',
        headers: buildHeaders(propagateUa, ''),
        redirect: 'follow',
      });
    }

    if (upstream.status >= 400) {
      return new Response(
        JSON.stringify({ error: `Stream server returned HTTP ${upstream.status}` }),
        {
          status: upstream.status,
          headers: {
            'Content-Type': 'application/json',
            'Access-Control-Allow-Origin': '*',
          },
        }
      );
    }

    const contentType = (upstream.headers.get('content-type') || '').toLowerCase();
    const finalUrl = upstream.url || targetUrl;
    const isLikelyManifest =
      expectManifest ||
      contentType.includes('mpegurl') ||
      contentType.includes('m3u') ||
      finalUrl.toLowerCase().includes('.m3u8') ||
      finalUrl.toLowerCase().includes('m3u8');

    if (isLikelyManifest) {
      const text = await upstream.text();
      if (isManifestContentEdge(text)) {
        const rewritten = rewriteHlsManifestEdge(text, finalUrl, propagateRef, propagateUa);
        return new Response(rewritten, {
          status: 200,
          headers: {
            'Content-Type': 'application/vnd.apple.mpegurl; charset=utf-8',
            'Cache-Control': 'no-store, no-cache, must-revalidate',
            'Access-Control-Allow-Origin': '*',
          },
        });
      }
      if (expectManifest) {
        return new Response(
          JSON.stringify({ error: 'Raw stream requires MPEG-TS or Transcode engine' }),
          {
            status: 415,
            headers: {
              'Content-Type': 'application/json',
              'Access-Control-Allow-Origin': '*',
            },
          }
        );
      }
      return new Response(text, {
        status: upstream.status,
        headers: {
          'Content-Type': contentType || 'video/mp2t',
          'Access-Control-Allow-Origin': '*',
        },
      });
    }

    const resHeaders = new Headers();
    resHeaders.set('Access-Control-Allow-Origin', '*');
    resHeaders.set('Content-Type', upstream.headers.get('content-type') || 'video/mp2t');
    resHeaders.set('Cache-Control', 'no-cache');
    const contentLength = upstream.headers.get('content-length');
    if (contentLength) resHeaders.set('Content-Length', contentLength);
    const contentRange = upstream.headers.get('content-range');
    if (contentRange) resHeaders.set('Content-Range', contentRange);

    return new Response(upstream.body, {
      status: upstream.status,
      headers: resHeaders,
    });
  } catch (err: any) {
    return new Response(JSON.stringify({ error: err?.message || 'Edge proxy error' }), {
      status: 502,
      headers: {
        'Content-Type': 'application/json',
        'Access-Control-Allow-Origin': '*',
      },
    });
  }
};

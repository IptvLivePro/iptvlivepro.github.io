import React, { useState, useEffect, useCallback, useRef } from 'react';
import {
  Search,
  Play,
  Star,
  AlertCircle,
  Tv,
  X,
  ChevronDown,
  Check,
  Loader2,
  Mic,
  Copy,
} from 'lucide-react';
import {
  QualityTierId,
  UnifiedChannel,
} from './types/iptv';
import {
  queryOfficialCatalogWithFallback,
  resetClientCatalogCache,
} from './utils/iptvCatalogClient';
import { BroadcastPlayer, PlayerStageMode } from './components/BroadcastPlayer';

type CategoryFilterId =
  | 'all'
  | 'favorites'
  | 'news'
  | 'sports'
  | 'entertainment'
  | 'movies'
  | 'music'
  | 'kids'
  | 'documentary';

const CATEGORY_TABS: { id: CategoryFilterId; label: string }[] = [
  { id: 'all', label: 'All Channels' },
  { id: 'favorites', label: 'Favorites' },
  { id: 'news', label: 'News' },
  { id: 'sports', label: 'Sports' },
  { id: 'entertainment', label: 'Entertainment' },
  { id: 'movies', label: 'Movies' },
  { id: 'music', label: 'Music' },
  { id: 'kids', label: 'Kids' },
  { id: 'documentary', label: 'Documentary' },
];

/**
 * Clean Channel Logo Box (Zero Shadow Effect!):
 * - Tries all official candidate logo URLs (`ch.logos` and `ch.logo`) synced from https://iptv-org.github.io/iptv/index.m3u
 * - Uses a soft neutral surface (`bg-slate-200/70`) with NO drop-shadow or box-shadow
 */
const ChannelLogoBox: React.FC<{ channel: UnifiedChannel }> = ({ channel }) => {
  const candidates = React.useMemo(() => {
    const list: string[] = [];
    if (channel.logo) list.push(channel.logo);
    if (Array.isArray(channel.logos)) {
      channel.logos.forEach((u) => {
        if (u && !list.includes(u)) list.push(u);
      });
    }
    return list;
  }, [channel.logo, channel.logos]);

  const [idx, setIdx] = useState<number>(0);

  useEffect(() => {
    setIdx(0);
  }, [channel.id, channel.logo]);

  const activeLogoUrl = candidates[idx] || '';

  return (
    <div className="w-14 h-14 sm:w-15 sm:h-15 rounded-xl bg-slate-200/70 border border-slate-200 p-1.5 flex items-center justify-center overflow-hidden shrink-0">
      {activeLogoUrl ? (
        <img
          src={activeLogoUrl}
          alt={channel.name}
          referrerPolicy="no-referrer"
          onError={() => setIdx((prev) => prev + 1)}
          className="w-full h-full object-contain"
        />
      ) : (
        <div className="w-full h-full rounded-lg bg-white border border-slate-200 flex flex-col items-center justify-center p-1 text-center">
          <span className="font-display text-sm sm:text-base font-extrabold text-red-600 leading-none">
            {channel.name.slice(0, 2).toUpperCase()}
          </span>
        </div>
      )}
    </div>
  );
};

function readCookieFavIds(): string[] {
  try {
    const match = document.cookie
      .split('; ')
      .find((row) => row.startsWith('streampulse_fav_ids='));
    if (!match) return [];
    const val = decodeURIComponent(match.split('=')[1] || '');
    const parsed = JSON.parse(val);
    return Array.isArray(parsed) ? parsed.map(String) : [];
  } catch {
    return [];
  }
}

function writeCookieFavIds(ids: string[]) {
  try {
    const encoded = encodeURIComponent(JSON.stringify(ids.slice(0, 200)));
    document.cookie = `streampulse_fav_ids=${encoded}; path=/; max-age=31536000; SameSite=Lax`;
    document.cookie = `streampulse_fav_ids=${encoded}; path=/; max-age=31536000; SameSite=None; Secure`;
  } catch {
    // ignore cookie errors
  }
}

export default function App() {
  // Purge any legacy local caches on startup
  useEffect(() => {
    try {
      localStorage.removeItem('streampulse_custom_m3u_v2');
      localStorage.removeItem('streampulse_catalog_cache');
      localStorage.removeItem('streampulse_channels_cache');
    } catch {
      // ignore
    }
    resetClientCatalogCache();
  }, []);

  // Channels state: 100% synced from official https://iptv-org.github.io/iptv/index.m3u & https://iptv-org.github.io/
  const [channels, setChannels] = useState<UnifiedChannel[]>([]);
  const [totalMatches, setTotalMatches] = useState<number>(0);
  const [loadingChannels, setLoadingChannels] = useState<boolean>(true);
  const [isSearching, setIsSearching] = useState<boolean>(false);
  const [loadError, setLoadError] = useState<string | null>(null);

  const [searchQuery, setSearchQuery] = useState<string>('');
  const [catalogFilter, setCatalogFilter] = useState<CategoryFilterId>('all');
  const [pageOffset, setPageOffset] = useState<number>(0);

  const latestRequestIdRef = useRef<number>(0);
  const searchInputRef = useRef<HTMLInputElement>(null);
  const initialResetDoneRef = useRef<boolean>(false);

  const [cardSelectedServer, setCardSelectedServer] = useState<Record<string, number>>({});
  const [openServerMenuChannelId, setOpenServerMenuChannelId] = useState<string | null>(null);

  // Favorites state: persisted across refreshes via localStorage + cookie + /api/favorites
  const [favoriteIds, setFavoriteIds] = useState<string[]>(() => {
    try {
      const saved =
        localStorage.getItem('streampulse_favs_v3') ||
        localStorage.getItem('streampulse_favorites');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed) && parsed.length > 0) {
          return parsed.map(String);
        }
      }
    } catch {
      // ignore
    }
    return readCookieFavIds();
  });

  const [favoriteChannels, setFavoriteChannels] = useState<UnifiedChannel[]>(() => {
    try {
      const saved = localStorage.getItem('streampulse_fav_channels_v3');
      if (saved) {
        const parsed = JSON.parse(saved);
        if (Array.isArray(parsed)) return parsed;
      }
    } catch {
      // ignore
    }
    return [];
  });

  const persistFavoritesEverywhere = useCallback(
    (ids: string[], favChs: UnifiedChannel[], syncServer = true) => {
      try {
        localStorage.setItem('streampulse_favs_v3', JSON.stringify(ids));
        localStorage.setItem('streampulse_fav_channels_v3', JSON.stringify(favChs));
      } catch {
        // ignore storage errors
      }
      writeCookieFavIds(ids);
      if (syncServer) {
        fetch('/api/favorites', {
          method: 'POST',
          headers: { 'Content-Type': 'application/json' },
          body: JSON.stringify({ ids, channels: favChs }),
        }).catch(() => {});
      }
    },
    []
  );

  // Restore / sync Favorites with backend persistent store on startup so page refresh never loses Favorites
  useEffect(() => {
    let cancelled = false;
    (async () => {
      try {
        const res = await fetch('/api/favorites');
        if (!res.ok) return;
        const data = await res.json();
        if (cancelled) return;
        const serverIds: string[] = Array.isArray(data?.ids) ? data.ids.map(String) : [];
        const serverChannels: UnifiedChannel[] = Array.isArray(data?.channels)
          ? data.channels
          : [];

        setFavoriteIds((prevLocalIds) => {
          const mergedIds = Array.from(new Set([...prevLocalIds, ...serverIds]));
          setFavoriteChannels((prevLocalChs) => {
            const byId = new Map<string, UnifiedChannel>();
            for (const c of [...prevLocalChs, ...serverChannels]) {
              if (c && c.id) byId.set(c.id, c);
            }
            const mergedChs = Array.from(byId.values()).filter((c) =>
              mergedIds.some((id) => id.toLowerCase() === c.id.toLowerCase())
            );
            persistFavoritesEverywhere(
              mergedIds,
              mergedChs,
              mergedIds.length !== serverIds.length
            );
            return mergedChs;
          });
          return mergedIds;
        });
      } catch {
        // ignore
      }
    })();
    return () => {
      cancelled = true;
    };
  }, [persistFavoritesEverywhere]);

  const [activeChannel, setActiveChannel] = useState<UnifiedChannel | null>(null);
  const [activeStreamIndex, setActiveStreamIndex] = useState<number>(0);
  const [playerStageMode, setPlayerStageMode] = useState<PlayerStageMode>('theater');
  const [unavailableNoticeChannel, setUnavailableNoticeChannel] = useState<string | null>(null);

  const [selectedQuality, setSelectedQuality] = useState<QualityTierId>('auto');
  const [sessionBytes, setSessionBytes] = useState<number>(0);

  useEffect(() => {
    const handleOutsideClick = () => setOpenServerMenuChannelId(null);
    window.addEventListener('click', handleOutsideClick);
    return () => window.removeEventListener('click', handleOutsideClick);
  }, []);

  useEffect(() => {
    if (!unavailableNoticeChannel) return;
    const t = window.setTimeout(() => setUnavailableNoticeChannel(null), 4000);
    return () => clearTimeout(t);
  }, [unavailableNoticeChannel]);

  const isDirectStreamUrlInput = useCallback((raw: string): boolean => {
    const trimmed = raw.trim();
    if (!trimmed || /\s/.test(trimmed)) return false;
    return /^(https?|rtmp|rtsp):\/\/.+\..+/i.test(trimmed) || /^https?:\/\/localhost[:/]/i.test(trimmed);
  }, []);

  const playDirectStreamUrl = useCallback(
    (rawUrl: string) => {
      const cleanUrl = rawUrl.trim();
      if (!cleanUrl) return;
      let hostLabel = 'Direct Stream';
      try {
        const u = new URL(cleanUrl);
        const lastSeg = u.pathname.split('/').filter(Boolean).pop() || '';
        hostLabel =
          lastSeg && !lastSeg.endsWith('.m3u8') && !lastSeg.endsWith('.ts')
            ? `${u.hostname} (${lastSeg})`
            : u.hostname || 'Direct Stream';
      } catch {
        // ignore
      }
      const directChannel: UnifiedChannel = {
        id: `direct-url-${cleanUrl}`,
        name: hostLabel,
        country: 'LIVE',
        countryName: 'Direct Stream',
        categories: ['Live Stream'],
        languages: ['All'],
        logo: '',
        logos: [],
        streams: [{ url: cleanUrl, quality: 'Live' }],
      };
      setUnavailableNoticeChannel(null);
      setActiveChannel(directChannel);
      setActiveStreamIndex(0);
      setIsSearching(false);
      if (playerStageMode !== 'fullscreen') {
        setPlayerStageMode('theater');
        window.scrollTo({ top: 0, behavior: 'smooth' });
      }
    },
    [playerStageMode]
  );

  /**
   * Universal Catalog Loader:
   * Fetches channels & logos from https://iptv-org.github.io/iptv/index.m3u
   * and all stream URLs from https://iptv-org.github.io/
   */
  const loadChannels = useCallback(
    async (
      query: string,
      filter: CategoryFilterId,
      offset: number,
      append = false,
      forceRefresh = false
    ) => {
      const reqId = ++latestRequestIdRef.current;

      const rawTrimmed = query.trim();
      // Search ONLY applies to 'all' ("All Channels"). Other categories (favorites, news, sports, etc.) are never filtered by searchQuery.
      const effectiveQuery =
        filter !== 'all' || isDirectStreamUrlInput(rawTrimmed) ? '' : rawTrimmed;
      const qLower = effectiveQuery.toLowerCase();

      setLoadingChannels(true);
      setLoadError(null);

      if (filter === 'favorites' && favoriteIds.length === 0) {
        setChannels([]);
        setTotalMatches(0);
        setLoadingChannels(false);
        setIsSearching(false);
        return;
      }

      try {
        const apiFilter = filter === 'favorites' ? 'favorites' : qLower ? 'all' : filter;
        const fetchLimit = filter === 'favorites' ? 5000 : 100;
        const data = await queryOfficialCatalogWithFallback(
          effectiveQuery,
          apiFilter,
          offset,
          fetchLimit,
          forceRefresh,
          filter === 'favorites' ? favoriteIds : []
        );
        if (reqId !== latestRequestIdRef.current) return;

        const apiItems: UnifiedChannel[] = Array.isArray(data.items) ? data.items : [];
        const streamFiltered = apiItems.filter((c) => c.streams.length > 0);

        let favFiltered = streamFiltered;
        if (filter === 'favorites') {
          const favSetLower = new Set(favoriteIds.map((id) => id.toLowerCase()));
          const combinedFavMap = new Map<string, UnifiedChannel>();

          for (const savedCh of favoriteChannels) {
            if (savedCh && savedCh.id && favSetLower.has(savedCh.id.toLowerCase())) {
              combinedFavMap.set(savedCh.id.toLowerCase(), savedCh);
            }
          }
          for (const apiCh of streamFiltered) {
            if (apiCh && apiCh.id && favSetLower.has(apiCh.id.toLowerCase())) {
              combinedFavMap.set(apiCh.id.toLowerCase(), apiCh);
            }
          }

          // Favorites tab always displays all user-added favorite channels (never filtered by search box)
          favFiltered = Array.from(combinedFavMap.values());
        }

        setChannels((prev) => {
          const nextList = append ? [...prev, ...favFiltered] : favFiltered;
          const seen = new Set<string>();
          const deduped = nextList.filter((item) => {
            const key = item.id.toLowerCase();
            if (seen.has(key)) return false;
            seen.add(key);
            return true;
          });
          return deduped.sort((a, b) =>
            a.name.localeCompare(b.name, undefined, { numeric: true, sensitivity: 'base' })
          );
        });
        setTotalMatches(
          filter === 'favorites' ? favFiltered.length : data.total || favFiltered.length
        );
      } catch (err: any) {
        if (reqId === latestRequestIdRef.current) {
          setLoadError(err?.message || 'Unable to load channels');
        }
      } finally {
        if (reqId === latestRequestIdRef.current) {
          setLoadingChannels(false);
          setIsSearching(false);
        }
      }
    },
    [favoriteIds, favoriteChannels, isDirectStreamUrlInput]
  );

  useEffect(() => {
    const trimmed = searchQuery.trim();
    if (isDirectStreamUrlInput(trimmed)) {
      playDirectStreamUrl(trimmed);
      return;
    }

    const timer = window.setTimeout(() => {
      setPageOffset(0);
      const shouldForceReset = !initialResetDoneRef.current;
      initialResetDoneRef.current = true;
      loadChannels(searchQuery, catalogFilter, 0, false, shouldForceReset);
    }, 80);
    return () => clearTimeout(timer);
  }, [searchQuery, catalogFilter, loadChannels, isDirectStreamUrlInput, playDirectStreamUrl]);

  useEffect(() => {
    const syncTimer = window.setInterval(() => {
      if (pageOffset === 0 && !isDirectStreamUrlInput(searchQuery)) {
        loadChannels(searchQuery, catalogFilter, 0, false, false);
      }
    }, 5 * 60 * 1000);
    return () => clearInterval(syncTimer);
  }, [searchQuery, catalogFilter, pageOffset, loadChannels, isDirectStreamUrlInput]);

  const handleLoadMore = () => {
    const nextOffset = pageOffset + 100;
    setPageOffset(nextOffset);
    loadChannels(searchQuery, catalogFilter, nextOffset, true, false);
  };

  const handleBytesReceived = useCallback((bytesDelta: number) => {
    setSessionBytes((prev) => prev + bytesDelta);
  }, []);

  const activeChannelId = activeChannel?.id || '';

  const handleSelectStreamIndex = useCallback(
    (idx: number) => {
      setActiveStreamIndex(idx);
      if (activeChannelId) {
        setCardSelectedServer((prev) => ({
          ...prev,
          [activeChannelId]: idx,
        }));
      }
    },
    [activeChannelId]
  );

  const handleClosePlayer = useCallback(() => {
    setActiveChannel(null);
  }, []);

  const handleSelectChannel = (ch: UnifiedChannel, streamIdx = 0) => {
    if (ch.streams.length === 0) {
      setUnavailableNoticeChannel(ch.name);
      return;
    }

    setUnavailableNoticeChannel(null);
    setCardSelectedServer((prev) => ({ ...prev, [ch.id]: streamIdx }));
    setActiveChannel(ch);
    setActiveStreamIndex(streamIdx);
    if (playerStageMode !== 'fullscreen') {
      setPlayerStageMode('theater');
      window.scrollTo({ top: 0, behavior: 'smooth' });
    }
  };

  const toggleFavorite = (ch: UnifiedChannel, e: React.MouseEvent) => {
    e.stopPropagation();
    const targetLower = ch.id.toLowerCase();
    const exists = favoriteIds.some((item) => item.toLowerCase() === targetLower);
    const nextIds = exists
      ? favoriteIds.filter((item) => item.toLowerCase() !== targetLower)
      : [...favoriteIds, ch.id];
    const nextChannels = exists
      ? favoriteChannels.filter((item) => item.id.toLowerCase() !== targetLower)
      : [
          ...favoriteChannels.filter((item) => item.id.toLowerCase() !== targetLower),
          ch,
        ];

    setFavoriteIds(nextIds);
    setFavoriteChannels(nextChannels);
    persistFavoritesEverywhere(nextIds, nextChannels, true);

    if (catalogFilter === 'favorites' && exists) {
      setChannels((prev) => prev.filter((item) => item.id.toLowerCase() !== targetLower));
      setTotalMatches((prev) => Math.max(0, prev - 1));
    }
  };

  const [copiedStreamKey, setCopiedStreamKey] = useState<string | null>(null);

  const handleCopyStreamUrl = async (
    url: string,
    streamKey: string,
    e: React.MouseEvent
  ) => {
    e.preventDefault();
    e.stopPropagation();
    try {
      if (navigator.clipboard && navigator.clipboard.writeText) {
        await navigator.clipboard.writeText(url);
      } else {
        const textArea = document.createElement('textarea');
        textArea.value = url;
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      }
    } catch {
      try {
        const textArea = document.createElement('textarea');
        textArea.value = url;
        textArea.style.position = 'fixed';
        textArea.style.opacity = '0';
        document.body.appendChild(textArea);
        textArea.focus();
        textArea.select();
        document.execCommand('copy');
        document.body.removeChild(textArea);
      } catch {
        // ignore fallback error
      }
    }
    setCopiedStreamKey(streamKey);
    window.setTimeout(() => {
      setCopiedStreamKey((prev) => (prev === streamKey ? null : prev));
    }, 2000);
  };

  const [isListeningVoice, setIsListeningVoice] = useState<boolean>(false);
  const [voiceStatusText, setVoiceStatusText] = useState<string>('Speak now');
  const [voiceInterimText, setVoiceInterimText] = useState<string>('');
  const [voiceVolumeLevel, setVoiceVolumeLevel] = useState<number>(0);

  const recognitionRef = useRef<any>(null);
  const micStreamRef = useRef<MediaStream | null>(null);
  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const audioContextRef = useRef<AudioContext | null>(null);
  const rafVolumeRef = useRef<number | null>(null);
  const silenceTimeoutRef = useRef<number | null>(null);
  const hasRecognitionTranscriptRef = useRef<boolean>(false);
  const isStoppingVoiceRef = useRef<boolean>(false);
  const isTranscribingVoiceRef = useRef<boolean>(false);
  const voiceCancelledRef = useRef<boolean>(false);

  const playVoiceChime = (type: 'start' | 'end' | 'error') => {
    try {
      const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
      if (!AudioCtx) return;
      const ctx = new AudioCtx();
      const osc = ctx.createOscillator();
      const gain = ctx.createGain();
      osc.connect(gain);
      gain.connect(ctx.destination);

      const now = ctx.currentTime;
      if (type === 'start') {
        osc.frequency.setValueAtTime(523.25, now); // C5
        osc.frequency.setValueAtTime(659.25, now + 0.08); // E5
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
        osc.start(now);
        osc.stop(now + 0.22);
      } else if (type === 'end') {
        osc.frequency.setValueAtTime(659.25, now); // E5
        osc.frequency.setValueAtTime(783.99, now + 0.07); // G5
        gain.gain.setValueAtTime(0.08, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.2);
        osc.start(now);
        osc.stop(now + 0.2);
      } else {
        osc.frequency.setValueAtTime(349.23, now); // F4
        osc.frequency.setValueAtTime(293.66, now + 0.09); // D4
        gain.gain.setValueAtTime(0.07, now);
        gain.gain.exponentialRampToValueAtTime(0.001, now + 0.22);
        osc.start(now);
        osc.stop(now + 0.22);
      }
      setTimeout(() => {
        ctx.close().catch(() => {});
      }, 300);
    } catch {
      // ignore audio context restrictions
    }
  };

  const stopAudioMeterAndStreams = () => {
    if (rafVolumeRef.current) {
      cancelAnimationFrame(rafVolumeRef.current);
      rafVolumeRef.current = null;
    }
    if (silenceTimeoutRef.current) {
      window.clearTimeout(silenceTimeoutRef.current);
      silenceTimeoutRef.current = null;
    }
    if (micStreamRef.current) {
      micStreamRef.current.getTracks().forEach((track) => {
        try {
          track.stop();
        } catch {
          // ignore
        }
      });
      micStreamRef.current = null;
    }
    if (audioContextRef.current) {
      try {
        audioContextRef.current.close();
      } catch {
        // ignore
      }
      audioContextRef.current = null;
    }
    setVoiceVolumeLevel(0);
  };

  const cleanupVoiceResources = () => {
    stopAudioMeterAndStreams();
    if (recognitionRef.current) {
      try {
        recognitionRef.current.onresult = null;
        recognitionRef.current.onerror = null;
        recognitionRef.current.onend = null;
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
      recognitionRef.current = null;
    }
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      try {
        mediaRecorderRef.current.onstop = null;
        mediaRecorderRef.current.stop();
      } catch {
        // ignore
      }
    }
    mediaRecorderRef.current = null;
    isTranscribingVoiceRef.current = false;
  };

  useEffect(() => {
    return () => {
      cleanupVoiceResources();
    };
  }, []);

  const applyRecognizedVoiceQuery = (rawText: string) => {
    const cleaned = rawText
      .replace(/^["'`]+|["'`.,!?]+$/g, '')
      .replace(/\s+/g, ' ')
      .trim();
    if (!cleaned) return false;
    hasRecognitionTranscriptRef.current = true;
    setVoiceInterimText(cleaned);
    setVoiceStatusText(cleaned);
    setSearchQuery(cleaned);
    if (isDirectStreamUrlInput(cleaned)) {
      playDirectStreamUrl(cleaned);
      return true;
    }
    if (catalogFilter !== 'all') {
      setCatalogFilter('all');
    }
    setIsSearching(true);
    loadChannels(cleaned, 'all', 0, false, false);
    return true;
  };

  const stopVoiceSearchSession = (cancelOnly = false) => {
    if (cancelOnly) {
      voiceCancelledRef.current = true;
      cleanupVoiceResources();
      setIsListeningVoice(false);
      setVoiceInterimText('');
      setVoiceStatusText('Speak now');
      isStoppingVoiceRef.current = false;
      return;
    }

    if (isStoppingVoiceRef.current || isTranscribingVoiceRef.current) return;
    isStoppingVoiceRef.current = true;

    // Stop volume animation loop immediately so it cannot re-trigger stopVoiceSearchSession
    if (rafVolumeRef.current) {
      cancelAnimationFrame(rafVolumeRef.current);
      rafVolumeRef.current = null;
    }
    if (silenceTimeoutRef.current) {
      window.clearTimeout(silenceTimeoutRef.current);
      silenceTimeoutRef.current = null;
    }
    setVoiceVolumeLevel(0);

    // If SpeechRecognition already produced a final/interim query, finalize immediately
    if (hasRecognitionTranscriptRef.current) {
      playVoiceChime('end');
      cleanupVoiceResources();
      setIsListeningVoice(false);
      isStoppingVoiceRef.current = false;
      return;
    }

    // If MediaRecorder is recording phone microphone audio, stop it so recorder.onstop
    // sends the recorded voice to /api/voice-search and populates the search box
    if (
      mediaRecorderRef.current &&
      mediaRecorderRef.current.state === 'recording'
    ) {
      isTranscribingVoiceRef.current = true;
      setVoiceStatusText('Recognizing...');
      if (recognitionRef.current) {
        try {
          recognitionRef.current.stop();
        } catch {
          // ignore
        }
      }
      try {
        mediaRecorderRef.current.stop();
        isStoppingVoiceRef.current = false;
        return;
      } catch {
        isTranscribingVoiceRef.current = false;
      }
    }

    // If only SpeechRecognition was active without MediaRecorder, let it finalize
    if (recognitionRef.current) {
      setVoiceStatusText('Recognizing...');
      try {
        recognitionRef.current.stop();
      } catch {
        // ignore
      }
      window.setTimeout(() => {
        cleanupVoiceResources();
        setIsListeningVoice(false);
        isStoppingVoiceRef.current = false;
      }, 600);
      return;
    }

    cleanupVoiceResources();
    setIsListeningVoice(false);
    isStoppingVoiceRef.current = false;
  };

  const startFallbackSpeechRecognition = () => {
    const SpeechRecognitionApi =
      (window as any).SpeechRecognition || (window as any).webkitSpeechRecognition;
    if (!SpeechRecognitionApi) return false;

    try {
      const recognition = new SpeechRecognitionApi();
      recognitionRef.current = recognition;
      recognition.continuous = false;
      recognition.interimResults = true;
      recognition.lang = navigator.language || 'en-US';

      recognition.onstart = () => {
        setVoiceStatusText('Listening...');
      };

      recognition.onresult = (event: any) => {
        let transcript = '';
        let isFinal = false;
        for (let i = 0; i < event.results.length; i++) {
          transcript += event.results[i][0].transcript;
          if (event.results[i].isFinal) {
            isFinal = true;
          }
        }
        const cleaned = transcript.replace(/[.,!?]+$/g, '').trim();
        if (cleaned) {
          applyRecognizedVoiceQuery(cleaned);
        }
        if (isFinal && cleaned) {
          playVoiceChime('end');
          window.setTimeout(() => {
            cleanupVoiceResources();
            setIsListeningVoice(false);
          }, 350);
        }
      };

      recognition.onerror = () => {
        if (!mediaRecorderRef.current && !isTranscribingVoiceRef.current) {
          cleanupVoiceResources();
          setIsListeningVoice(false);
        }
      };

      recognition.onend = () => {
        if (hasRecognitionTranscriptRef.current) {
          playVoiceChime('end');
          window.setTimeout(() => {
            cleanupVoiceResources();
            setIsListeningVoice(false);
          }, 250);
        } else if (!mediaRecorderRef.current && !isTranscribingVoiceRef.current) {
          cleanupVoiceResources();
          setIsListeningVoice(false);
        }
      };

      recognition.start();
      return true;
    } catch {
      return false;
    }
  };

  const handleToggleVoiceSearch = async (e: React.MouseEvent) => {
    e.preventDefault();
    e.stopPropagation();

    // If already listening, tapping the Mic button finishes & transcribes the spoken query
    if (isListeningVoice) {
      stopVoiceSearchSession(false);
      return;
    }

    hasRecognitionTranscriptRef.current = false;
    isStoppingVoiceRef.current = false;
    isTranscribingVoiceRef.current = false;
    voiceCancelledRef.current = false;
    setVoiceInterimText('');
    setVoiceStatusText('Listening...');
    setIsListeningVoice(true);
    playVoiceChime('start');

    // Primary: Activate the user's phone/device hardware microphone via getUserMedia
    // without running SpeechRecognition simultaneously (which locks out the mic on Android)
    if (navigator.mediaDevices && navigator.mediaDevices.getUserMedia) {
      try {
        const stream = await navigator.mediaDevices.getUserMedia({
          audio: {
            echoCancellation: true,
            noiseSuppression: true,
            autoGainControl: true,
          },
        });

        if (voiceCancelledRef.current) {
          stream.getTracks().forEach((t) => t.stop());
          return;
        }

        micStreamRef.current = stream;
        setVoiceStatusText('Listening...');

        // Setup Web Audio Time-Domain RMS Analyser for accurate voice detection on phone mics
        const AudioCtx = window.AudioContext || (window as any).webkitAudioContext;
        if (AudioCtx) {
          const audioCtx = new AudioCtx();
          audioContextRef.current = audioCtx;
          if (audioCtx.state === 'suspended') {
            audioCtx.resume().catch(() => {});
          }
          const source = audioCtx.createMediaStreamSource(stream);
          const analyser = audioCtx.createAnalyser();
          analyser.fftSize = 512;
          source.connect(analyser);

          const timeData = new Uint8Array(analyser.fftSize);
          let spokeAtLeastOnce = false;
          let silenceStart = 0;
          let speechStart = 0;
          const startedAt = performance.now();

          const updateVolume = () => {
            if (
              !micStreamRef.current ||
              voiceCancelledRef.current ||
              isTranscribingVoiceRef.current
            ) {
              return;
            }

            analyser.getByteTimeDomainData(timeData);
            let sumSquares = 0;
            for (let i = 0; i < timeData.length; i++) {
              const centered = (timeData[i] - 128) / 128;
              sumSquares += centered * centered;
            }
            const rms = Math.sqrt(sumSquares / timeData.length);
            const normalized = Math.min(1, rms * 6.5);
            setVoiceVolumeLevel(normalized);

            const now = performance.now();
            // RMS > 0.022 reliably detects human voice on phone & desktop microphones
            if (rms > 0.022) {
              if (!spokeAtLeastOnce) {
                spokeAtLeastOnce = true;
                speechStart = now;
              }
              silenceStart = 0;
              // Auto-transcribe if user speaks continuously for more than 5.5 seconds
              if (speechStart && now - speechStart > 5500) {
                stopVoiceSearchSession(false);
                return;
              }
            } else if (spokeAtLeastOnce) {
              if (!silenceStart) {
                silenceStart = now;
              } else if (now - silenceStart > 900) {
                // User finished speaking (0.9s pause) — immediately transcribe & put in search box
                stopVoiceSearchSession(false);
                return;
              }
            } else if (now - startedAt > 6500) {
              // Auto-stop after 6.5s even if RMS was subtle so quiet mics still get transcribed
              stopVoiceSearchSession(false);
              return;
            }

            rafVolumeRef.current = requestAnimationFrame(updateVolume);
          };

          rafVolumeRef.current = requestAnimationFrame(updateVolume);
        }

        // Record from the phone microphone and transcribe via /api/voice-search
        if (typeof MediaRecorder !== 'undefined') {
          const preferredTypes = [
            'audio/webm;codecs=opus',
            'audio/webm',
            'audio/mp4',
            'audio/ogg;codecs=opus',
          ];
          let selectedMime = '';
          for (const t of preferredTypes) {
            if (MediaRecorder.isTypeSupported(t)) {
              selectedMime = t;
              break;
            }
          }

          const recorder = selectedMime
            ? new MediaRecorder(stream, { mimeType: selectedMime })
            : new MediaRecorder(stream);
          mediaRecorderRef.current = recorder;
          const chunks: BlobPart[] = [];

          recorder.ondataavailable = (ev) => {
            if (ev.data && ev.data.size > 0) {
              chunks.push(ev.data);
            }
          };

          recorder.onstop = async () => {
            // Stop hardware mic tracks immediately now that audio chunks are captured
            stopAudioMeterAndStreams();

            if (voiceCancelledRef.current || hasRecognitionTranscriptRef.current) {
              cleanupVoiceResources();
              setIsListeningVoice(false);
              return;
            }

            const blob = new Blob(chunks, {
              type: recorder.mimeType || selectedMime || 'audio/webm',
            });

            if (blob.size < 200) {
              cleanupVoiceResources();
              setIsListeningVoice(false);
              return;
            }

            setVoiceStatusText('Recognizing...');
            try {
              const base64Audio = await new Promise<string>((resolve, reject) => {
                const reader = new FileReader();
                reader.onloadend = () => {
                  const res = String(reader.result || '');
                  const commaIdx = res.indexOf(',');
                  resolve(commaIdx >= 0 ? res.slice(commaIdx + 1) : res);
                };
                reader.onerror = reject;
                reader.readAsDataURL(blob);
              });

              const resp = await fetch('/api/voice-search', {
                method: 'POST',
                headers: { 'Content-Type': 'application/json' },
                body: JSON.stringify({
                  audioBase64: base64Audio,
                  mimeType: blob.type || 'audio/webm',
                }),
              });

              if (resp.ok) {
                const data = await resp.json();
                if (data?.transcript && applyRecognizedVoiceQuery(data.transcript)) {
                  playVoiceChime('end');
                  window.setTimeout(() => {
                    cleanupVoiceResources();
                    setIsListeningVoice(false);
                  }, 350);
                  return;
                }
              }

              setVoiceStatusText("Didn't catch that. Try again.");
              playVoiceChime('error');
              window.setTimeout(() => {
                cleanupVoiceResources();
                setIsListeningVoice(false);
              }, 900);
            } catch {
              playVoiceChime('error');
              cleanupVoiceResources();
              setIsListeningVoice(false);
            }
          };

          recorder.start(150);
          return;
        }
      } catch {
        // If getUserMedia fails or isn't permitted, fall back to browser SpeechRecognition
      }
    }

    if (!startFallbackSpeechRecognition()) {
      playVoiceChime('error');
      cleanupVoiceResources();
      setIsListeningVoice(false);
    }
  };

  const showSearchLoading =
    (isSearching || (loadingChannels && searchQuery.trim().length > 0)) &&
    !isDirectStreamUrlInput(searchQuery);

  return (
    <div className="min-h-screen flex flex-col bg-[#F4F6F9] text-slate-900">
      {/* TOP HEADER WITH FIXED-WIDTH RED SEARCH BOX (z-50 ensures player top bar never overlays header on scroll) */}
      <header className="sticky top-0 z-50 h-14 flex items-center justify-between gap-2 sm:gap-6 px-3 sm:px-6 bg-white border-b border-slate-200">
        <a
          href="#top"
          onClick={(e) => {
            e.preventDefault();
            setCatalogFilter('all');
            setSearchQuery('');
            setIsSearching(false);
            window.scrollTo({ top: 0, behavior: 'smooth' });
          }}
          className="font-display text-lg sm:text-xl font-bold tracking-tight text-red-600 whitespace-nowrap shrink-0"
        >
          StreamPulse
        </a>

        {/* HEADER SEARCH BOX (CONSTANT FIXED WIDTH, LEFT TV ICON & RIGHT SEARCH ICON, SWITCHES TO ALL CHANNELS ON CLICK) */}
        <form
          onClick={() => {
            if (catalogFilter !== 'all') {
              setCatalogFilter('all');
            }
          }}
          onSubmit={(e) => {
            e.preventDefault();
            const q = searchQuery.trim();
            if (isDirectStreamUrlInput(q)) {
              playDirectStreamUrl(q);
              return;
            }
            if (catalogFilter !== 'all') {
              setCatalogFilter('all');
            }
            setIsSearching(true);
            loadChannels(searchQuery, 'all', 0, false, false);
          }}
          className="inline-flex items-center w-[150px] sm:w-[168px] bg-red-600 border border-red-700 focus-within:border-red-800 focus-within:ring-2 focus-within:ring-red-500/30 rounded-full pl-2.5 pr-1 py-1 transition-colors shrink-0 overflow-hidden"
        >
          <Tv className="w-3.5 h-3.5 text-white/95 shrink-0 mr-1.5 pointer-events-none" />
          <input
            ref={searchInputRef}
            type="text"
            value={searchQuery}
            onFocus={() => {
              if (catalogFilter !== 'all') {
                setCatalogFilter('all');
              }
            }}
            onClick={() => {
              if (catalogFilter !== 'all') {
                setCatalogFilter('all');
              }
            }}
            onChange={(e) => {
              const nextVal = e.target.value;
              setSearchQuery(nextVal);
              const trimmed = nextVal.trim();
              if (isDirectStreamUrlInput(trimmed)) {
                setIsSearching(false);
                return;
              }
              if (catalogFilter !== 'all') {
                setCatalogFilter('all');
              }
              setIsSearching(true);
            }}
            placeholder="Search channels..."
            aria-label="Search Channels or Paste Stream URL"
            className="flex-1 min-w-0 w-full p-0 m-0 bg-transparent border-none text-xs sm:text-sm font-medium text-white placeholder-white/95 focus:outline-none leading-tight"
          />

          {/* Right-side icons immediately next to 'Search channels...' with zero gap */}
          <div className="flex items-center shrink-0 ml-0">
            {showSearchLoading ? (
              <div className="p-0.5 flex items-center justify-center pointer-events-none">
                <Loader2 className="w-3.5 h-3.5 text-white animate-spin" />
              </div>
            ) : (
              searchQuery.length > 0 && (
                <button
                  type="button"
                  onClick={() => {
                    const wasDirectUrl = isDirectStreamUrlInput(searchQuery);
                    setSearchQuery('');
                    if (catalogFilter !== 'all') {
                      setCatalogFilter('all');
                    }
                    if (!wasDirectUrl) {
                      setIsSearching(true);
                    }
                    searchInputRef.current?.focus();
                  }}
                  title="Clear search"
                  aria-label="Clear search"
                  className="p-0.5 rounded-full text-white/90 hover:text-white hover:bg-red-700 transition-colors"
                >
                  <X className="w-3.5 h-3.5" />
                </button>
              )
            )}

            <button
              type="submit"
              title="Search channels"
              aria-label="Search channels"
              className="p-1 rounded-full text-white hover:bg-red-700 transition-all flex items-center justify-center"
            >
              <Search className="w-3.5 h-3.5 sm:w-4 sm:h-4" />
            </button>
          </div>
        </form>

        <nav className="hidden lg:flex items-center gap-5 text-sm font-medium text-slate-600 shrink-0">
          <a
            href="#all-channels"
            onClick={(e) => {
              e.preventDefault();
              setCatalogFilter('all');
            }}
            className={`hover:text-red-600 transition-colors whitespace-nowrap shrink-0 ${
              catalogFilter === 'all'
                ? 'text-red-600 font-semibold underline underline-offset-8 decoration-2 decoration-red-600'
                : ''
            }`}
          >
            All Channels
          </a>
          <a
            href="#favorites"
            onClick={(e) => {
              e.preventDefault();
              setCatalogFilter('favorites');
            }}
            className={`hover:text-red-600 transition-colors whitespace-nowrap shrink-0 ${
              catalogFilter === 'favorites'
                ? 'text-red-600 font-semibold underline underline-offset-8 decoration-2 decoration-red-600'
                : ''
            }`}
          >
            Favorites
          </a>
          <a
            href="#news"
            onClick={(e) => {
              e.preventDefault();
              setCatalogFilter('news');
            }}
            className={`hover:text-red-600 transition-colors whitespace-nowrap shrink-0 ${
              catalogFilter === 'news'
                ? 'text-red-600 font-semibold underline underline-offset-8 decoration-2 decoration-red-600'
                : ''
            }`}
          >
            News
          </a>
          <a
            href="#sports"
            onClick={(e) => {
              e.preventDefault();
              setCatalogFilter('sports');
            }}
            className={`hover:text-red-600 transition-colors whitespace-nowrap shrink-0 ${
              catalogFilter === 'sports'
                ? 'text-red-600 font-semibold underline underline-offset-8 decoration-2 decoration-red-600'
                : ''
            }`}
          >
            Sports
          </a>
        </nav>
      </header>

      {/* SEPARATE CATEGORY BAR */}
      <div className="bg-white border-b border-slate-200">
        <div className="max-w-6xl mx-auto px-3 sm:px-6 py-2.5 flex items-center gap-2 overflow-x-auto no-scrollbar">
          {CATEGORY_TABS.map((tab) => (
            <button
              key={tab.id}
              type="button"
              onClick={() => setCatalogFilter(tab.id)}
              className={`px-4 py-1.5 rounded-full text-xs sm:text-sm font-bold transition-all whitespace-nowrap shrink-0 ${
                catalogFilter === tab.id
                  ? 'bg-red-600 text-white'
                  : 'bg-slate-100 text-slate-700 hover:bg-slate-200 hover:text-slate-950'
              }`}
            >
              {tab.label}
            </button>
          ))}
        </div>
      </div>

      {/* Main Container */}
      <div className="flex-1 w-full max-w-6xl mx-auto px-3 sm:px-6 py-3 pb-12 flex flex-col gap-3 min-w-0">
        {/* ON-SCREEN VIDEO PLAYER (Scrolls naturally with page) */}
        {activeChannel && (
          <div className="w-full">
            <BroadcastPlayer
              channel={activeChannel}
              activeStreamIndex={activeStreamIndex}
              onSelectStreamIndex={handleSelectStreamIndex}
              selectedQuality={selectedQuality}
              onSelectQuality={setSelectedQuality}
              sessionBytes={sessionBytes}
              onBytesReceived={handleBytesReceived}
              stageMode={playerStageMode}
              onChangeStageMode={setPlayerStageMode}
              onClosePlayer={handleClosePlayer}
            />
          </div>
        )}

        {unavailableNoticeChannel && (
          <div className="px-4 py-3 rounded-xl bg-amber-50 border border-amber-200 text-xs sm:text-sm text-amber-900 flex items-center gap-2">
            <AlertCircle className="w-4 h-4 text-amber-600 shrink-0" />
            <span className="truncate">
              <strong>{unavailableNoticeChannel}</strong>: Stream URL not available
            </span>
          </div>
        )}

        {/* COMPACT HORIZONTAL CHANNEL CARDS */}
        <section className="space-y-1.5 sm:space-y-2">
          {loadingChannels && channels.length === 0 ? (
            <div className="space-y-1.5 sm:space-y-2">
              {Array.from({ length: 6 }).map((_, idx) => (
                <div
                  key={idx}
                  className="bg-white border border-slate-200 rounded-2xl px-2.5 sm:px-3 py-1.5 sm:py-2 flex items-center justify-between gap-2.5 animate-pulse"
                >
                  <div className="flex items-center gap-2.5 min-w-0 flex-1">
                    <div className="w-14 h-14 sm:w-15 sm:h-15 rounded-xl bg-slate-100 shrink-0" />
                    <div className="space-y-1.5 flex-1">
                      <div className="h-3.5 w-40 bg-slate-100 rounded" />
                      <div className="h-3 w-28 bg-slate-100 rounded" />
                    </div>
                  </div>
                  <div className="flex flex-col items-end justify-center gap-1 shrink-0">
                    <div className="w-7 h-7 rounded-lg bg-slate-100" />
                    <div className="h-7 w-28 rounded-xl bg-slate-100" />
                  </div>
                </div>
              ))}
            </div>
          ) : loadError ? (
            <div className="bg-white border border-slate-200 rounded-2xl p-8 text-center space-y-3">
              <p className="text-sm text-red-600 font-medium">{loadError}</p>
              <button
                onClick={() => loadChannels(searchQuery, catalogFilter, 0, false, true)}
                className="px-5 py-2.5 text-xs font-bold bg-red-600 hover:bg-red-700 text-white rounded-xl"
              >
                Retry Loading Channels
              </button>
            </div>
          ) : channels.length === 0 ? (
            <div className="bg-white border border-slate-200 rounded-2xl p-10 text-center space-y-2">
              <Tv className="w-8 h-8 text-slate-400 mx-auto" />
              <p className="text-base font-bold text-slate-800">
                {catalogFilter === 'favorites' ? 'No Favorite Channels Yet' : 'No Channels Found'}
              </p>
              <p className="text-xs sm:text-sm text-slate-500">
                {catalogFilter === 'favorites'
                  ? 'Tap the star icon on the top right of any channel card to save it to your Favorites.'
                  : 'Try searching by another channel name, category (e.g. News, Sports), or language (e.g. Bengali, Hindi).'}
              </p>
            </div>
          ) : (
            <div className="space-y-1.5 sm:space-y-2">
              {channels.map((ch) => {
                const hasStreams = ch.streams.length > 0;
                const isSelected = activeChannel?.id === ch.id;
                const isFav = favoriteIds.some(
                  (favId) => favId.toLowerCase() === ch.id.toLowerCase()
                );

                const fullCountryName =
                  ch.countryName && ch.countryName.toUpperCase() !== 'INT'
                    ? ch.countryName
                    : ch.country?.toUpperCase() === 'INT'
                    ? 'International'
                    : ch.countryName || ch.country || 'International';

                const rawCats =
                  Array.isArray(ch.categories) && ch.categories.length > 0
                    ? ch.categories.filter(Boolean)
                    : ['General'];
                const cleanedCats =
                  rawCats.length > 1
                    ? rawCats.filter((c) => c.toLowerCase() !== 'general')
                    : rawCats;
                const primaryCategoryRaw = cleanedCats[0] || rawCats[0] || 'General';
                const categoryLabel =
                  primaryCategoryRaw.charAt(0).toUpperCase() + primaryCategoryRaw.slice(1);

                const rawLangs =
                  Array.isArray(ch.languages) && ch.languages.length > 0
                    ? ch.languages.filter(Boolean)
                    : ['English'];
                const languageLabel = rawLangs[0] || 'English';

                const chosenServerIdx = isSelected
                  ? activeStreamIndex
                  : cardSelectedServer[ch.id] || 0;
                const safeServerIdx =
                  chosenServerIdx < ch.streams.length ? chosenServerIdx : 0;
                const isServerMenuOpen = openServerMenuChannelId === ch.id;

                return (
                  <div
                    key={ch.id}
                    onClick={() => handleSelectChannel(ch, safeServerIdx)}
                    className={`relative bg-white border rounded-2xl px-2.5 sm:px-3 py-1.5 sm:py-2 cursor-pointer transition-all duration-300 ease-in-out flex flex-col ${
                      isSelected
                        ? 'border-red-600 ring-2 ring-red-600/15 bg-red-50/30'
                        : 'border-slate-200 hover:border-red-600/50'
                    }`}
                  >
                    {/* Main Horizontal Channel Row */}
                    <div className="flex items-center gap-2.5 sm:gap-3 w-full">
                      <ChannelLogoBox channel={ch} />

                      {/* Right of Logo: Stacked Top Row (Name + Category·Country·Language + Star) & Bottom Row (Watch Live) */}
                      <div className="flex-1 min-w-0 flex flex-col justify-between gap-1">
                        {/* Top Row: Channel Name & Category · Country · Language take full width up to the Star button */}
                        <div className="flex items-start justify-between gap-1.5 min-w-0">
                          <div className="flex flex-col justify-start min-w-0 flex-1 -mt-0.5 gap-0.5">
                            {/* Unbreakable Single-Line Full Channel Name */}
                            <h3 className="font-display text-xs sm:text-sm font-bold text-slate-900 leading-tight whitespace-nowrap overflow-x-auto no-scrollbar">
                              {ch.name}
                            </h3>

                            {/* Side-by-Side Left-to-Right: Category · Country · Language */}
                            <div className="flex items-center flex-nowrap gap-1 text-[11px] sm:text-xs font-medium leading-tight whitespace-nowrap overflow-x-auto no-scrollbar">
                              <span className="text-red-600 font-semibold shrink-0">
                                {categoryLabel}
                              </span>
                              <span aria-hidden="true" className="text-slate-400 shrink-0">
                                •
                              </span>
                              <span className="font-semibold text-slate-800 shrink-0">
                                {fullCountryName}
                              </span>
                              <span aria-hidden="true" className="text-slate-400 shrink-0">
                                •
                              </span>
                              <span className="text-slate-600 font-medium shrink-0">
                                {languageLabel}
                              </span>
                            </div>
                          </div>

                          <button
                            type="button"
                            onClick={(e) => toggleFavorite(ch, e)}
                            title={isFav ? 'Remove from Favorites' : 'Add to Favorites'}
                            aria-label={isFav ? 'Remove from Favorites' : 'Add to Favorites'}
                            className={`p-1 rounded-lg border transition-colors shrink-0 ${
                              isFav
                                ? 'bg-amber-50 border-amber-200 text-amber-500'
                                : 'bg-slate-50 border-slate-200 text-slate-400 hover:text-amber-500 hover:border-amber-200'
                            }`}
                          >
                            <Star
                              className={`w-3.5 h-3.5 ${
                                isFav ? 'fill-amber-400 text-amber-400' : ''
                              }`}
                            />
                          </button>
                        </div>

                        {/* Bottom Row: Watch Live / Server Selector sits strictly below the text row */}
                        <div
                          onClick={(e) => e.stopPropagation()}
                          className="flex items-center justify-end"
                        >
                          {!hasStreams ? (
                            <span className="inline-flex items-center text-[11px] text-amber-800 bg-amber-50 border border-amber-200 px-2.5 py-0.5 rounded-xl font-semibold whitespace-nowrap">
                              Unavailable
                            </span>
                          ) : (
                            <div className="relative inline-flex items-stretch rounded-xl bg-red-600 text-white shadow-xs">
                              <button
                                type="button"
                                onClick={() => handleSelectChannel(ch, safeServerIdx)}
                                className="flex items-center gap-1 pl-2.5 sm:pl-3 pr-2 py-1 text-[11px] sm:text-xs font-bold hover:bg-red-700 rounded-l-xl transition-colors whitespace-nowrap shrink-0"
                              >
                                <Play className="w-3 h-3 fill-current shrink-0" />
                                <span>{isSelected ? 'Playing' : 'Watch Live'}</span>
                              </button>

                              <button
                                type="button"
                                onClick={(e) => {
                                  e.stopPropagation();
                                  setOpenServerMenuChannelId((prev) =>
                                    prev === ch.id ? null : ch.id
                                  );
                                }}
                                title="Select Stream URL"
                                aria-label="Select Stream URL"
                                className="flex items-center justify-center px-1.5 sm:px-2 py-1 border-l border-red-500/60 hover:bg-red-700 rounded-r-xl transition-colors shrink-0"
                              >
                                <ChevronDown
                                  className={`w-3.5 h-3.5 transition-transform duration-300 ${
                                    isServerMenuOpen ? 'rotate-180' : ''
                                  }`}
                                />
                              </button>
                            </div>
                          )}
                        </div>
                      </div>
                    </div>

                    {/* Smooth Push-Down Accordion for Stream URL Selection (pushes lower channel cards down instead of overlaying) */}
                    {hasStreams && (
                      <div
                        onClick={(e) => e.stopPropagation()}
                        className={`grid transition-all duration-300 ease-in-out ${
                          isServerMenuOpen
                            ? 'grid-rows-[1fr] opacity-100 mt-2 pt-2 border-t border-slate-200/80'
                            : 'grid-rows-[0fr] opacity-0 mt-0 pt-0 border-t-0 border-transparent pointer-events-none'
                        }`}
                      >
                        <div className="overflow-hidden">
                          <div className="space-y-1.5 pb-0.5">
                            <div className="px-1.5 py-0.5 flex items-center justify-between gap-2">
                              <span className="text-xs font-bold text-slate-900">
                                Stream URLs
                              </span>
                              <span className="text-[10px] font-mono font-semibold text-emerald-600">
                                {ch.streams.length}{' '}
                                {ch.streams.length === 1 ? 'Stream' : 'Streams'}
                              </span>
                            </div>
                            <div className="max-h-72 overflow-y-auto space-y-1.5 pr-0.5">
                              {ch.streams.map((st, sIdx) => {
                                const isCurrent = safeServerIdx === sIdx;
                                const streamKey = `${ch.id}-${sIdx}`;
                                const isCopied = copiedStreamKey === streamKey;
                                return (
                                  <div
                                    key={`${ch.id}-menu-srv-${sIdx}`}
                                    className={`w-full flex items-center justify-between gap-2 p-2 rounded-xl border transition-all ${
                                      isCurrent
                                        ? 'bg-red-600 border-red-600 text-white shadow-xs'
                                        : 'bg-slate-50/90 border-slate-200/90 text-slate-800 hover:bg-slate-100 hover:border-slate-300'
                                    }`}
                                  >
                                    <button
                                      type="button"
                                      onClick={() => {
                                        setOpenServerMenuChannelId(null);
                                        handleSelectChannel(ch, sIdx);
                                      }}
                                      className="flex-1 min-w-0 flex items-start gap-1.5 text-left"
                                    >
                                      {isCurrent ? (
                                        <Check className="w-3.5 h-3.5 shrink-0 mt-0.5 text-white" />
                                      ) : (
                                        <Play className="w-3 h-3 shrink-0 mt-0.5 text-red-600 fill-current" />
                                      )}
                                      <span
                                        className={`font-mono text-[11px] leading-snug break-all select-all ${
                                          isCurrent
                                            ? 'text-white font-semibold'
                                            : 'text-slate-800 font-medium'
                                        }`}
                                      >
                                        {st.url}
                                      </span>
                                    </button>

                                    <button
                                      type="button"
                                      onClick={(e) =>
                                        handleCopyStreamUrl(st.url, streamKey, e)
                                      }
                                      title="Copy stream URL"
                                      aria-label="Copy stream URL"
                                      className={`w-[68px] h-7 justify-center shrink-0 inline-flex items-center gap-1 rounded-lg text-[11px] font-bold transition-colors ${
                                        isCurrent
                                          ? 'bg-white text-red-600 hover:bg-red-50'
                                          : 'bg-white border border-slate-200 text-slate-700 hover:border-red-600 hover:text-red-600'
                                      }`}
                                    >
                                      {isCopied ? (
                                        <>
                                          <Check className="w-3 h-3 shrink-0" />
                                          <span>Copied</span>
                                        </>
                                      ) : (
                                        <>
                                          <Copy className="w-3 h-3 shrink-0" />
                                          <span>Copy</span>
                                        </>
                                      )}
                                    </button>
                                  </div>
                                );
                              })}
                            </div>
                          </div>
                        </div>
                      </div>
                    )}
                  </div>
                );
              })}

              {catalogFilter !== 'favorites' && channels.length < totalMatches && (
                <div className="pt-2 text-center">
                  <button
                    onClick={handleLoadMore}
                    disabled={loadingChannels}
                    className="w-full sm:w-auto px-8 py-3 text-xs sm:text-sm font-bold text-white bg-red-600 hover:bg-red-700 rounded-2xl transition-colors"
                  >
                    {loadingChannels ? 'Loading more channels...' : 'Load More Channels'}
                  </button>
                </div>
              )}
            </div>
          )}
        </section>
      </div>
    </div>
  );
}

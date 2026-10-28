import React, { useEffect, useRef, useState, useCallback } from 'react';
import Hls from 'hls.js';
import mpegts from 'mpegts.js';
import {
  Play,
  Pause,
  Volume2,
  VolumeX,
  Maximize,
  Minimize,
  Settings,
  Disc,
  Square,
  Loader2,
  AlertCircle,
  Check,
  Download,
  ChevronDown,
  X,
  Server,
  FastForward,
  Rewind,
  Trash2,
  Copy,
} from 'lucide-react';
import {
  UnifiedChannel,
  StreamLink,
  QUALITY_TIERS,
  QualityTierId,
} from '../types/iptv';
import { buildProxiedStreamUrl } from '../utils/m3uParser';

export type PlayerStageMode = 'theater' | 'fullscreen';

type PlaybackEngineMode =
  | 'proxy-hls'
  | 'direct-hls'
  | 'native-video'
  | 'mpegts'
  | 'transcode-mpegts'
  | 'transcode-mp4';

interface BroadcastPlayerProps {
  channel: UnifiedChannel;
  activeStreamIndex: number;
  onSelectStreamIndex: (idx: number) => void;
  selectedQuality: QualityTierId;
  onSelectQuality: (quality: QualityTierId) => void;
  sessionBytes: number;
  onBytesReceived: (bytes: number) => void;
  stageMode: PlayerStageMode;
  onChangeStageMode: (mode: PlayerStageMode) => void;
  onClosePlayer: () => void;
}

interface NativeHlsLevel {
  index: number;
  height: number;
  bitrate: number;
}

interface PendingRecording {
  url: string;
  filename: string;
  durationSec: number;
  sizeBytes: number;
  quality: QualityTierId;
}

const QUALITY_DIMENSIONS: Record<string, { width: number; height: number; bps: number; fps: number }> = {
  '1080p': { width: 1920, height: 1080, bps: 3500000, fps: 30 },
  '720p':  { width: 1280, height: 720,  bps: 1800000, fps: 30 },
  '480p':  { width: 854,  height: 480,  bps: 900000,  fps: 25 },
  '360p':  { width: 640,  height: 360,  bps: 500000,  fps: 24 },
  '240p':  { width: 426,  height: 240,  bps: 240000,  fps: 20 },
  '144p':  { width: 256,  height: 144,  bps: 115000,  fps: 15 },
};

/**
 * Distinct Screen Orientation Rotate SVG Icon (Never looks like a loading spinner!)
 */
const ScreenRotateIcon: React.FC<{ className?: string }> = ({ className = 'w-3.5 h-3.5' }) => (
  <svg
    viewBox="0 0 24 24"
    fill="none"
    stroke="currentColor"
    strokeWidth="2.2"
    strokeLinecap="round"
    strokeLinejoin="round"
    className={className}
    aria-hidden="true"
  >
    <rect x="5" y="2" width="14" height="20" rx="2" ry="2" />
    <path d="M12 18h.01" />
  </svg>
);

function computeInitialEngine(url: string, quality: QualityTierId = 'auto', hasTranscoder = false): PlaybackEngineMode {
  const lower = (url || '').trim().toLowerCase();
  if (
    /^(rtmp|rtsp|mmsh|mms|udp|rtp):\/\//i.test(lower) ||
    /\.(flv|mkv|avi)(\?|$)/i.test(lower)
  ) {
    if (hasTranscoder) {
      return mpegts.isSupported() ? 'transcode-mpegts' : 'transcode-mp4';
    }
    return 'mpegts';
  }
  if (
    (lower.endsWith('.ts') && !lower.includes('.m3u8')) ||
    /\/play\/[a-z0-9_-]+$/i.test(lower) ||
    /\/udp\/[0-9.:]+$/i.test(lower)
  ) {
    if (quality !== 'auto' && hasTranscoder) {
      return mpegts.isSupported() ? 'transcode-mpegts' : 'transcode-mp4';
    }
    return 'mpegts';
  }
  if (
    lower.endsWith('.mp4') ||
    lower.endsWith('.m4v') ||
    lower.endsWith('.webm') ||
    lower.endsWith('.mov') ||
    lower.includes('.mp4?') ||
    lower.includes('.webm?')
  ) {
    if (quality !== 'auto' && hasTranscoder) {
      return mpegts.isSupported() ? 'transcode-mpegts' : 'transcode-mp4';
    }
    return 'native-video';
  }
  return 'proxy-hls';
}

export const BroadcastPlayer: React.FC<BroadcastPlayerProps> = ({
  channel,
  activeStreamIndex,
  onSelectStreamIndex,
  selectedQuality,
  onSelectQuality,
  sessionBytes,
  onBytesReceived,
  stageMode,
  onChangeStageMode,
  onClosePlayer,
}) => {
  const containerRef = useRef<HTMLDivElement>(null);
  const videoRef = useRef<HTMLVideoElement>(null);
  const hlsRef = useRef<Hls | null>(null);
  const mpegtsRef = useRef<mpegts.Player | null>(null);

  // Refs to isolate the video player lifecycle from parent re-renders (e.g. sessionBytes ticking every 500ms!)
  const channelRef = useRef<UnifiedChannel>(channel);
  const activeStreamIndexRef = useRef<number>(activeStreamIndex);
  const onSelectStreamIndexRef = useRef(onSelectStreamIndex);
  const selectedQualityRef = useRef<QualityTierId>(selectedQuality);
  const onBytesReceivedRef = useRef(onBytesReceived);
  const waitingDebounceTimerRef = useRef<number | null>(null);
  const autoTriedServersRef = useRef<Set<number>>(new Set([activeStreamIndex]));
  const hasNodeTranscoderRef = useRef<boolean>(true);

  useEffect(() => {
    channelRef.current = channel;
  }, [channel]);

  useEffect(() => {
    activeStreamIndexRef.current = activeStreamIndex;
  }, [activeStreamIndex]);

  useEffect(() => {
    onSelectStreamIndexRef.current = onSelectStreamIndex;
  }, [onSelectStreamIndex]);

  useEffect(() => {
    selectedQualityRef.current = selectedQuality;
  }, [selectedQuality]);

  useEffect(() => {
    onBytesReceivedRef.current = onBytesReceived;
  }, [onBytesReceived]);

  // Detect once if full-stack Node server with FFmpeg transcoder is present
  useEffect(() => {
    let cancelled = false;
    fetch('/api/iptv-org/catalog?limit=1')
      .then((res) => {
        const cType = res.headers.get('content-type') || '';
        if (!cancelled) {
          hasNodeTranscoderRef.current = Boolean(res.ok && cType.includes('application/json'));
        }
      })
      .catch(() => {
        if (!cancelled) {
          hasNodeTranscoderRef.current = false;
        }
      });
    return () => {
      cancelled = true;
    };
  }, []);

  const [resolvedOverrideStream, setResolvedOverrideStream] = useState<StreamLink | null>(null);
  const hasTriedResolveRef = useRef<boolean>(false);

  const activeStream: StreamLink | undefined =
    resolvedOverrideStream || channel.streams[activeStreamIndex] || channel.streams[0];
  const activeStreamUrl: string = activeStream?.url || '';

  const [playbackEngine, setPlaybackEngine] = useState<PlaybackEngineMode>(() =>
    computeInitialEngine(activeStreamUrl)
  );
  const [isPlaying, setIsPlaying] = useState<boolean>(true);
  const [isMuted, setIsMuted] = useState<boolean>(() => {
    try {
      return localStorage.getItem('iptv_player_muted') === 'true';
    } catch {
      return false;
    }
  });
  const [volume, setVolume] = useState<number>(() => {
    try {
      const saved = localStorage.getItem('iptv_player_volume');
      if (saved !== null) {
        const parsed = parseFloat(saved);
        if (!isNaN(parsed) && parsed >= 0 && parsed <= 1) {
          return parsed;
        }
      }
    } catch {
      // ignore
    }
    return 0.9;
  });
  const volumeRef = useRef<number>(volume);
  const isMutedRef = useRef<boolean>(isMuted);

  const syncMediaVolume = useCallback(() => {
    const clampedVol = Math.max(0, Math.min(1, volumeRef.current));
    const muted = isMutedRef.current;
    if (videoRef.current) {
      if (Math.abs(videoRef.current.volume - clampedVol) > 0.005) {
        videoRef.current.volume = clampedVol;
      }
      if (videoRef.current.muted !== muted) {
        videoRef.current.muted = muted;
      }
    }
    if (mpegtsRef.current) {
      try {
        mpegtsRef.current.volume = muted ? 0 : clampedVol;
        mpegtsRef.current.muted = muted;
      } catch {
        // ignore
      }
    }
  }, []);

  const [isBuffering, setIsBuffering] = useState<boolean>(false);
  const [errorMsg, setErrorMsg] = useState<string | null>(null);
  const [logoCandidateIdx, setLogoCandidateIdx] = useState<number>(0);

  // Active video pixel height for the "p" resolution indicator next to Data Meter
  const [detectedHeight, setDetectedHeight] = useState<number>(720);

  // Viewport geometry for 100% centered Horizontal Fullscreen stage
  const [viewportSize, setViewportSize] = useState<{ width: number; height: number }>(() => ({
    width: typeof window !== 'undefined' ? window.innerWidth : 1280,
    height: typeof window !== 'undefined' ? window.innerHeight : 720,
  }));

  useEffect(() => {
    const updateViewport = () => {
      setViewportSize({
        width: window.innerWidth,
        height: window.innerHeight,
      });
    };
    window.addEventListener('resize', updateViewport);
    window.addEventListener('orientationchange', updateViewport);
    return () => {
      window.removeEventListener('resize', updateViewport);
      window.removeEventListener('orientationchange', updateViewport);
    };
  }, []);

  // YouTube-Style Two-Finger Pinch-to-Zoom State (`1.0` = Normal Fit, up to `2.5` = Zoomed)
  const [videoZoom, setVideoZoom] = useState<number>(1);
  const [zoomNotice, setZoomNotice] = useState<string | null>(null);
  const pinchStartDistRef = useRef<number | null>(null);
  const pinchStartZoomRef = useRef<number>(1);
  const isPinchingRef = useRef<boolean>(false);
  const zoomNoticeTimerRef = useRef<number | null>(null);

  // YouTube DVR & Timeline Scrubber state
  const [currentTime, setCurrentTime] = useState<number>(0);
  const [seekableStart, setSeekableStart] = useState<number>(0);
  const [seekableEnd, setSeekableEnd] = useState<number>(0);
  const [seekFeedback, setSeekFeedback] = useState<{ side: 'left' | 'right'; seconds: number } | null>(
    null
  );
  const seekFeedbackTimerRef = useRef<number | null>(null);
  const singleTapTimerRef = useRef<number | null>(null);
  const lastTapRef = useRef<{ time: number; side: 'left' | 'center' | 'right' }>({
    time: 0,
    side: 'center',
  });

  // Orientation & Auto-Hide Controls state
  const [isRotatedHorizontal, setIsRotatedHorizontal] = useState<boolean>(false);
  const [showControls, setShowControls] = useState<boolean>(true);
  const hideControlsTimerRef = useRef<number | null>(null);

  // Quality, Server Menu & Real Network Bitrate state
  const [nativeLevels, setNativeLevels] = useState<NativeHlsLevel[]>([]);
  const nativeLevelsRef = useRef<NativeHlsLevel[]>([]);
  const measuredStreamBpsRef = useRef<number>(1800000);
  const [showQualityMenu, setShowQualityMenu] = useState<boolean>(false);
  const [showServerMenu, setShowServerMenu] = useState<boolean>(false);
  const [showRecordMenu, setShowRecordMenu] = useState<boolean>(false);
  const [showRecordConfirmMenu, setShowRecordConfirmMenu] = useState<boolean>(false);

  const bottomTrayRef = useRef<HTMLDivElement>(null);
  const recordBtnGroupRef = useRef<HTMLDivElement>(null);
  const [recordPopoverRightPx, setRecordPopoverRightPx] = useState<number>(136);

  const updateRecordPopoverPosition = useCallback(() => {
    const trayEl = bottomTrayRef.current;
    const recEl = recordBtnGroupRef.current;
    if (!trayEl || !recEl) return;
    const trayRect = trayEl.getBoundingClientRect();
    const recRect = recEl.getBoundingClientRect();
    if (trayRect.width <= 0 || recRect.width <= 0) return;

    const popoverWidth = 176; // w-44 = 176px
    const recCenterFromRight = trayRect.right - (recRect.left + recRect.width / 2);
    const idealRight = Math.round(recCenterFromRight - popoverWidth / 2);
    const minRight = 8;
    const maxRight = Math.max(8, Math.floor(trayRect.width - popoverWidth - 8));
    setRecordPopoverRightPx(Math.max(minRight, Math.min(maxRight, idealRight)));
  }, []);

  // Close player menus (Server Selection, Quality Selection, Recording Quality & Start/Cancel Selection) when clicking anywhere outside
  useEffect(() => {
    const handleDocumentPointerDown = (e: PointerEvent) => {
      const target = e.target as HTMLElement | null;
      if (!target) return;
      if (!target.closest('[data-player-menu="server"]')) {
        setShowServerMenu(false);
      }
      if (!target.closest('[data-player-menu="quality"]')) {
        setShowQualityMenu(false);
      }
      if (!target.closest('[data-player-menu="record"]')) {
        setShowRecordMenu(false);
      }
      if (!target.closest('[data-player-menu="record-confirm"]')) {
        setShowRecordConfirmMenu(false);
      }
    };
    document.addEventListener('pointerdown', handleDocumentPointerDown, true);
    return () =>
      document.removeEventListener('pointerdown', handleDocumentPointerDown, true);
  }, []);

  // Live Recording state with User Confirmation (Download or Cancel — NO auto-download!)
  const [isRecording, setIsRecording] = useState<boolean>(false);
  const [recordQuality, setRecordQuality] = useState<QualityTierId>('720p');
  const [recordSeconds, setRecordSeconds] = useState<number>(0);
  const [pendingRecording, setPendingRecording] = useState<PendingRecording | null>(null);

  const mediaRecorderRef = useRef<MediaRecorder | null>(null);
  const recordedChunksRef = useRef<Blob[]>([]);
  const recordDrawTimerRef = useRef<number | null>(null);
  const recordClockRef = useRef<number | null>(null);
  const recordDurationRef = useRef<number>(0);
  const [reloadNonce, setReloadNonce] = useState<number>(0);

  // Strict 20-second per-server playback window state (NEVER auto-switches server!)
  const serverAttemptStartRef = useRef<number>(Date.now());
  const serverHasPlayedRef = useRef<boolean>(false);
  const server15sTimerRef = useRef<number | null>(null);
  const retryDelayTimerRef = useRef<number | null>(null);
  const [isConnectingWindow, setIsConnectingWindow] = useState<boolean>(true);

  const isFullscreen = stageMode === 'fullscreen';

  const clearServer15sTimer = useCallback(() => {
    if (server15sTimerRef.current) {
      clearTimeout(server15sTimerRef.current);
      server15sTimerRef.current = null;
    }
    if (retryDelayTimerRef.current) {
      clearTimeout(retryDelayTimerRef.current);
      retryDelayTimerRef.current = null;
    }
  }, []);

  const markServerPlaybackSucceeded = useCallback(() => {
    serverHasPlayedRef.current = true;
    clearServer15sTimer();
    setIsConnectingWindow(false);
    setIsBuffering(false);
  }, [clearServer15sTimer]);

  const startNew15sServerWindow = useCallback(() => {
    clearServer15sTimer();
    serverAttemptStartRef.current = Date.now();
    serverHasPlayedRef.current = false;
    setErrorMsg(null);
    setIsConnectingWindow(true);
    setIsBuffering(true);
  }, [clearServer15sTimer]);

  // Reset tried servers when switching channel (depends ONLY on primitive channel.id)
  useEffect(() => {
    autoTriedServersRef.current = new Set([activeStreamIndexRef.current]);
    hasTriedResolveRef.current = false;
    setResolvedOverrideStream(null);
  }, [channel.id]);

  // Reset 20-second window, engine & zoom ONLY when primitive channel.id, activeStreamIndex, or activeStreamUrl changes
  useEffect(() => {
    autoTriedServersRef.current.add(activeStreamIndex);
    startNew15sServerWindow();
    setPlaybackEngine(
      computeInitialEngine(activeStreamUrl, selectedQualityRef.current, hasNodeTranscoderRef.current)
    );
    setVideoZoom(1);
    return () => {
      clearServer15sTimer();
    };
  }, [channel.id, activeStreamIndex, activeStreamUrl, startNew15sServerWindow, clearServer15sTimer]);

  // Build candidate logo list for resilient fallback
  const candidateLogos = React.useMemo(() => {
    const list: string[] = [];
    if (channel.logo) list.push(channel.logo);
    if (Array.isArray(channel.logos)) {
      channel.logos.forEach((u) => {
        if (u && !list.includes(u)) list.push(u);
      });
    }
    return list;
  }, [channel.logo, channel.logos]);

  useEffect(() => {
    setLogoCandidateIdx(0);
  }, [channel.id, channel.logo]);

  // Clean up any pending recording blob URL on unmount
  useEffect(() => {
    return () => {
      if (pendingRecording?.url) {
        URL.revokeObjectURL(pendingRecording.url);
      }
    };
  }, [pendingRecording]);

  // Sync recording quality default when user selects a playback quality
  useEffect(() => {
    if (!isRecording && selectedQuality !== 'auto') {
      setRecordQuality(selectedQuality);
    }
  }, [selectedQuality, isRecording]);

  const showTransientZoomNotice = useCallback((label: string) => {
    setZoomNotice(label);
    if (zoomNoticeTimerRef.current) {
      clearTimeout(zoomNoticeTimerRef.current);
    }
    zoomNoticeTimerRef.current = window.setTimeout(() => {
      setZoomNotice(null);
    }, 900);
  }, []);

  useEffect(() => {
    if (showRecordConfirmMenu || showRecordMenu || pendingRecording) {
      updateRecordPopoverPosition();
    }
  }, [
    showRecordConfirmMenu,
    showRecordMenu,
    pendingRecording,
    viewportSize,
    isFullscreen,
    isRotatedHorizontal,
    updateRecordPopoverPosition,
  ]);

  // 3-second auto-hide timer when zoomed into Fullscreen
  const resetFullscreenAutoHideTimer = useCallback(() => {
    if (hideControlsTimerRef.current) {
      clearTimeout(hideControlsTimerRef.current);
      hideControlsTimerRef.current = null;
    }
    if (
      isFullscreen &&
      !showQualityMenu &&
      !showRecordMenu &&
      !showRecordConfirmMenu &&
      !showServerMenu &&
      !pendingRecording
    ) {
      hideControlsTimerRef.current = window.setTimeout(() => {
        setShowControls(false);
      }, 3000);
    }
  }, [
    isFullscreen,
    showQualityMenu,
    showRecordMenu,
    showRecordConfirmMenu,
    showServerMenu,
    pendingRecording,
  ]);

  useEffect(() => {
    if (isFullscreen) {
      if (showControls) {
        resetFullscreenAutoHideTimer();
      }
    } else {
      setShowControls(true);
      setIsRotatedHorizontal(false);
      setVideoZoom(1);
      if (hideControlsTimerRef.current) {
        clearTimeout(hideControlsTimerRef.current);
        hideControlsTimerRef.current = null;
      }
    }
    return () => {
      if (hideControlsTimerRef.current) {
        clearTimeout(hideControlsTimerRef.current);
      }
    };
  }, [isFullscreen, showControls, resetFullscreenAutoHideTimer]);

  // Listen to native browser fullscreen exit
  useEffect(() => {
    const handleFsChange = () => {
      if (!document.fullscreenElement && stageMode === 'fullscreen') {
        onChangeStageMode('theater');
        setIsRotatedHorizontal(false);
        setVideoZoom(1);
        setShowControls(true);
      }
    };
    document.addEventListener('fullscreenchange', handleFsChange);
    return () => document.removeEventListener('fullscreenchange', handleFsChange);
  }, [stageMode, onChangeStageMode]);

  /**
   * Perform +/- 10s YouTube-style seek within the seekable DVR/video buffer
   */
  const performRelativeSeek = useCallback(
    (deltaSeconds: number, side: 'left' | 'right') => {
      const video = videoRef.current;
      if (!video) return;

      let start = 0;
      let end = video.duration && isFinite(video.duration) ? video.duration : video.currentTime;
      if (video.seekable && video.seekable.length > 0) {
        start = video.seekable.start(0);
        end = video.seekable.end(video.seekable.length - 1);
      }

      const targetTime = Math.max(start, Math.min(end, video.currentTime + deltaSeconds));
      try {
        video.currentTime = targetTime;
        setCurrentTime(targetTime);
      } catch {
        // ignore if stream does not permit seeking yet
      }

      setSeekFeedback((prev) => ({
        side,
        seconds:
          prev && prev.side === side ? prev.seconds + Math.abs(deltaSeconds) : Math.abs(deltaSeconds),
      }));

      if (seekFeedbackTimerRef.current) {
        clearTimeout(seekFeedbackTimerRef.current);
      }
      seekFeedbackTimerRef.current = window.setTimeout(() => {
        setSeekFeedback(null);
      }, 650);

      resetFullscreenAutoHideTimer();
    },
    [resetFullscreenAutoHideTimer]
  );

  /**
   * Jump directly back to the live broadcast edge ("Go Live" button)
   */
  const handleGoLive = (e: React.MouseEvent) => {
    e.stopPropagation();
    const video = videoRef.current;
    if (!video) return;

    if (
      hlsRef.current &&
      typeof hlsRef.current.liveSyncPosition === 'number' &&
      hlsRef.current.liveSyncPosition > 0
    ) {
      video.currentTime = hlsRef.current.liveSyncPosition;
      setCurrentTime(hlsRef.current.liveSyncPosition);
    } else if (video.seekable && video.seekable.length > 0) {
      const end = video.seekable.end(video.seekable.length - 1);
      const target = Math.max(0, end - 0.3);
      video.currentTime = target;
      setCurrentTime(target);
    }
    video.play().catch(() => {});
    setIsPlaying(true);
    resetFullscreenAutoHideTimer();
  };

  /**
   * Two-Finger Pinch-to-Zoom Touch Handlers (YouTube-style zoom in & pinch back to normal size!)
   */
  const handleTouchStart = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2) {
      isPinchingRef.current = true;
      if (singleTapTimerRef.current) {
        clearTimeout(singleTapTimerRef.current);
        singleTapTimerRef.current = null;
      }
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      pinchStartDistRef.current = Math.max(10, Math.hypot(dx, dy));
      pinchStartZoomRef.current = videoZoom;
    }
  };

  const handleTouchMove = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length === 2 && pinchStartDistRef.current !== null) {
      const dx = e.touches[0].clientX - e.touches[1].clientX;
      const dy = e.touches[0].clientY - e.touches[1].clientY;
      const dist = Math.hypot(dx, dy);
      const ratio = dist / pinchStartDistRef.current;
      let nextZoom = pinchStartZoomRef.current * ratio;

      if (nextZoom <= 1.04) {
        nextZoom = 1;
      } else if (nextZoom > 2.5) {
        nextZoom = 2.5;
      }

      const rounded = Math.round(nextZoom * 100) / 100;
      setVideoZoom(rounded);
      showTransientZoomNotice(
        rounded === 1 ? 'Original (1.0x)' : `Zoomed to fill (${rounded.toFixed(1)}x)`
      );
    }
  };

  const handleTouchEnd = (e: React.TouchEvent<HTMLDivElement>) => {
    if (e.touches.length < 2) {
      pinchStartDistRef.current = null;
      if (isPinchingRef.current) {
        window.setTimeout(() => {
          isPinchingRef.current = false;
        }, 260);
      }
    }
  };

  const handleVideoWheel = (e: React.WheelEvent<HTMLDivElement>) => {
    if (e.ctrlKey) {
      e.preventDefault();
      const delta = -e.deltaY * 0.01;
      setVideoZoom((prev) => {
        let next = prev + delta;
        if (next <= 1.04) next = 1;
        if (next > 2.5) next = 2.5;
        const rounded = Math.round(next * 100) / 100;
        showTransientZoomNotice(
          rounded === 1 ? 'Original (1.0x)' : `Zoomed to fill (${rounded.toFixed(1)}x)`
        );
        return rounded;
      });
    }
  };

  /**
   * Unified Single-Tap (Toggle Controls) & Double-Tap (Left -10s / Right +10s Seek) Handler
   * Never pauses or plays the video when clicking the screen!
   */
  const handleVideoSurfacePointerUp = (e: React.MouseEvent<HTMLDivElement>) => {
    if (isPinchingRef.current) return;

    const rect = e.currentTarget.getBoundingClientRect();
    const relX = (e.clientX - rect.left) / Math.max(1, rect.width);
    const side: 'left' | 'center' | 'right' =
      relX < 0.36 ? 'left' : relX > 0.64 ? 'right' : 'center';

    const now = Date.now();
    const timeSinceLast = now - lastTapRef.current.time;

    if (timeSinceLast < 280 && lastTapRef.current.side === side && side !== 'center') {
      if (singleTapTimerRef.current) {
        clearTimeout(singleTapTimerRef.current);
        singleTapTimerRef.current = null;
      }
      lastTapRef.current = { time: now, side };
      performRelativeSeek(side === 'left' ? -10 : 10, side);
      return;
    }

    lastTapRef.current = { time: now, side };
    if (singleTapTimerRef.current) {
      clearTimeout(singleTapTimerRef.current);
    }
    singleTapTimerRef.current = window.setTimeout(() => {
      setShowQualityMenu(false);
      setShowRecordMenu(false);
      setShowServerMenu(false);
      setShowControls((prev) => !prev);
      singleTapTimerRef.current = null;
    }, 230);
  };

  const destroyPlayers = useCallback(() => {
    if (waitingDebounceTimerRef.current) {
      clearTimeout(waitingDebounceTimerRef.current);
      waitingDebounceTimerRef.current = null;
    }
    if (retryDelayTimerRef.current) {
      clearTimeout(retryDelayTimerRef.current);
      retryDelayTimerRef.current = null;
    }
    if (hlsRef.current) {
      try {
        hlsRef.current.destroy();
      } catch {
        // ignore
      }
      hlsRef.current = null;
    }
    if (mpegtsRef.current) {
      try {
        mpegtsRef.current.pause();
        mpegtsRef.current.unload();
        mpegtsRef.current.detachMediaElement();
        mpegtsRef.current.destroy();
      } catch {
        // ignore
      }
      mpegtsRef.current = null;
    }
  }, []);

  /**
   * Helper to apply user-selected quality tier to Hls.js:
   * - Returns true if the HLS manifest natively has a matching quality variant.
   * - Returns false if the stream is single-bitrate (or lacks a matching low-bitrate variant)
   *   so the caller can switch to real-time FFmpeg downscaling (`transcode-mpegts`) to save mobile data.
   */
  const applyQualityToHls = useCallback(
    (hls: Hls, quality: QualityTierId, levels: NativeHlsLevel[], immediateFlush: boolean): boolean => {
      if (quality === 'auto') {
        hls.autoLevelCapping = -1;
        hls.currentLevel = -1;
        hls.nextLevel = -1;
        hls.loadLevel = -1;
        return true;
      }
      const tierSpec = QUALITY_TIERS.find((t) => t.id === quality);
      if (!tierSpec) return true;

      const validLevels = levels.filter((l) => l.height > 0);
      if (validLevels.length > 1) {
        let bestIdx = validLevels[0].index;
        let minDiff = Infinity;
        validLevels.forEach((lvl) => {
          const diff = Math.abs(lvl.height - tierSpec.height);
          if (diff < minDiff) {
            minDiff = diff;
            bestIdx = lvl.index;
          }
        });

        // If the closest native HLS level is within 180p of the requested quality (or at/below the target height), use it natively
        const chosenHeight = levels[bestIdx]?.height || 0;
        if (minDiff <= 180 || (chosenHeight > 0 && chosenHeight <= tierSpec.height)) {
          hls.autoLevelCapping = bestIdx;
          if (immediateFlush) {
            hls.currentLevel = bestIdx;
          } else {
            hls.loadLevel = bestIdx;
            hls.nextLevel = bestIdx;
          }
          if (chosenHeight > 0) {
            setDetectedHeight(chosenHeight);
          }
          return true;
        }
      } else if (validLevels.length === 1) {
        const singleHeight = validLevels[0].height;
        if (Math.abs(singleHeight - tierSpec.height) <= 120) {
          setDetectedHeight(singleHeight);
          return true;
        }
      }

      // Stream does not have a matching native HLS variant for the requested quality
      return false;
    },
    []
  );

  /**
   * 1. Render-Isolated Multi-Engine Video Loader with Strict 20-Second Per-Server Attempt Window
   * and VLC-for-Android Universal Stream Compatibility:
   * - Never automatically switches `activeStreamIndex` to another server.
   * - Escalates swiftly through Proxy HLS -> Direct HLS / Raw MPEG-TS -> Server-Side FFmpeg (VLC/LibVLC grade decoder)
   *   well within the 20-second window so streams with HEVC, MPEG-2, AC-3, RTSP/RTMP, or raw TS play smoothly.
   */
  useEffect(() => {
    const video = videoRef.current;
    const currentChannel = channelRef.current;
    const currentStream: StreamLink | undefined =
      resolvedOverrideStream ||
      currentChannel.streams[activeStreamIndex] ||
      currentChannel.streams[0];

    destroyPlayers();
    syncMediaVolume();

    if (!video || !currentStream?.url) {
      setIsConnectingWindow(false);
      setIsBuffering(false);
      setErrorMsg(null);
      if (video) {
        video.removeAttribute('src');
        video.load();
      }
      return;
    }

    let effectDisposed = false;

    setIsBuffering(true);
    setErrorMsg(null);
    setNativeLevels([]);
    nativeLevelsRef.current = [];
    setCurrentTime(0);
    setSeekableStart(0);
    setSeekableEnd(0);

    const SERVER_ATTEMPT_WINDOW_MS = 20000;

    const showUserServerChoicePrompt = () => {
      if (effectDisposed || serverHasPlayedRef.current) return;
      clearServer15sTimer();
      destroyPlayers();
      setIsConnectingWindow(false);
      setIsBuffering(false);
      const totalServers = channelRef.current.streams.length;
      const currentSrvNum = activeStreamIndex + 1;
      setErrorMsg(
        totalServers > 1
          ? `Unable to connect to Server ${currentSrvNum}. Reconnect or switch to the next server.`
          : `Unable to connect to Server ${currentSrvNum}. Click Reconnect to try again.`
      );
    };

    // Ensure the master 20-second timer is running while this server hasn't played yet
    if (!serverHasPlayedRef.current) {
      setIsConnectingWindow(true);
      const elapsed = Date.now() - serverAttemptStartRef.current;
      const remainingMs = SERVER_ATTEMPT_WINDOW_MS - elapsed;
      if (remainingMs <= 0) {
        showUserServerChoicePrompt();
        return;
      }
      if (server15sTimerRef.current) {
        clearTimeout(server15sTimerRef.current);
      }
      server15sTimerRef.current = window.setTimeout(() => {
        showUserServerChoicePrompt();
      }, remainingMs);
    }

    const retryOrPromptWithin15sWindow = () => {
      if (effectDisposed) return;
      if (serverHasPlayedRef.current) {
        serverAttemptStartRef.current = Date.now();
        serverHasPlayedRef.current = false;
      }
      setIsConnectingWindow(true);
      setIsBuffering(true);
      const elapsed = Date.now() - serverAttemptStartRef.current;
      const remainingMs = SERVER_ATTEMPT_WINDOW_MS - elapsed;
      if (remainingMs <= 600) {
        showUserServerChoicePrompt();
        return;
      }
      retryDelayTimerRef.current = window.setTimeout(() => {
        if (effectDisposed || serverHasPlayedRef.current) return;
        if (Date.now() - serverAttemptStartRef.current >= SERVER_ATTEMPT_WINDOW_MS) {
          showUserServerChoicePrompt();
          return;
        }
        const initialEng = computeInitialEngine(
          currentStream.url,
          selectedQualityRef.current,
          hasNodeTranscoderRef.current
        );
        if (playbackEngine !== initialEng) {
          setPlaybackEngine(initialEng);
        } else {
          setReloadNonce((n) => n + 1);
        }
      }, Math.min(900, remainingMs - 200));
    };

    const advanceToNextEngineOrServer = (manifestConnected = false) => {
      if (effectDisposed) return;
      destroyPlayers();

      const elapsed = Date.now() - serverAttemptStartRef.current;
      if (!serverHasPlayedRef.current && elapsed >= SERVER_ATTEMPT_WINDOW_MS) {
        showUserServerChoicePrompt();
        return;
      }

      const lowerUrl = currentStream.url.toLowerCase();
      const isHttpStream = lowerUrl.startsWith('http://');
      const isHttpsPage =
        typeof window !== 'undefined' && window.location.protocol === 'https:';

      if (playbackEngine === 'native-video') {
        if (hasNodeTranscoderRef.current) {
          setPlaybackEngine(mpegts.isSupported() ? 'transcode-mpegts' : 'transcode-mp4');
        } else {
          setPlaybackEngine('proxy-hls');
        }
      } else if (playbackEngine === 'proxy-hls') {
        // If manifest already connected through proxy-hls, the issue is codec/container (e.g. MPEG-2, HEVC, AC-3, TS timing)
        // Jump straight to FFmpeg VLC transcoder so we don't waste time on direct-hls!
        if (manifestConnected && hasNodeTranscoderRef.current) {
          setPlaybackEngine(mpegts.isSupported() ? 'transcode-mpegts' : 'transcode-mp4');
        } else if (!isHttpStream || !isHttpsPage) {
          setPlaybackEngine('direct-hls');
        } else if (mpegts.isSupported()) {
          setPlaybackEngine('mpegts');
        } else if (hasNodeTranscoderRef.current) {
          setPlaybackEngine('transcode-mp4');
        } else {
          retryOrPromptWithin15sWindow();
        }
      } else if (playbackEngine === 'direct-hls') {
        if (hasNodeTranscoderRef.current) {
          setPlaybackEngine(mpegts.isSupported() ? 'transcode-mpegts' : 'transcode-mp4');
        } else if (mpegts.isSupported()) {
          setPlaybackEngine('mpegts');
        } else {
          retryOrPromptWithin15sWindow();
        }
      } else if (playbackEngine === 'mpegts') {
        if (hasNodeTranscoderRef.current) {
          setPlaybackEngine(mpegts.isSupported() ? 'transcode-mpegts' : 'transcode-mp4');
        } else {
          retryOrPromptWithin15sWindow();
        }
      } else if (playbackEngine === 'transcode-mpegts') {
        if (hasNodeTranscoderRef.current) {
          setPlaybackEngine('transcode-mp4');
        } else {
          retryOrPromptWithin15sWindow();
        }
      } else {
        retryOrPromptWithin15sWindow();
      }
    };

    // STAGE 0: Direct Native Video Player (MP4, WebM, direct video URLs — supports both HTTP & HTTPS)
    if (playbackEngine === 'native-video') {
      const videoSrc = `/api/proxy/stream?url=${encodeURIComponent(currentStream.url)}`;

      video.src = videoSrc;
      video.crossOrigin = 'anonymous';
      video.load();
      syncMediaVolume();
      const playPromise = video.play();
      if (playPromise) {
        playPromise
          .then(() => {
            if (!effectDisposed && video.readyState >= 2) {
              markServerPlaybackSucceeded();
              setIsPlaying(true);
            }
          })
          .catch(() => {
            // Keep connecting animation active while retrying within the 20s window
          });
      }

      const onNativeVideoError = () => {
        if (!effectDisposed) {
          advanceToNextEngineOrServer();
        }
      };
      video.addEventListener('error', onNativeVideoError);
      return () => {
        effectDisposed = true;
        video.removeEventListener('error', onNativeVideoError);
      };
    }

    // STAGE 3 & 4: MPEG-TS Live Player (`mpegts` raw stream OR `transcode-mpegts` FFmpeg live H.264+AAC stream)
    if (playbackEngine === 'mpegts' || playbackEngine === 'transcode-mpegts') {
      if (!mpegts.isSupported()) {
        advanceToNextEngineOrServer();
        return;
      }
      if (playbackEngine === 'transcode-mpegts' && !hasNodeTranscoderRef.current) {
        advanceToNextEngineOrServer();
        return;
      }

      const targetQ = selectedQualityRef.current === 'auto' ? '720p' : selectedQualityRef.current;
      const targetSpec = QUALITY_DIMENSIONS[targetQ];
      if (playbackEngine === 'transcode-mpegts' && targetSpec) {
        setDetectedHeight(targetSpec.height);
      }

      const tsUrl =
        playbackEngine === 'transcode-mpegts'
          ? buildProxiedStreamUrl(currentStream, 'ffmpeg-mpegts', targetQ)
          : buildProxiedStreamUrl(currentStream, 'raw-ts');

      let frameReceived = false;
      const watchdogMs = playbackEngine === 'transcode-mpegts' ? 6200 : 4200;
      const startupGuard = window.setTimeout(() => {
        if (!effectDisposed && !frameReceived && (!video || video.readyState < 2)) {
          advanceToNextEngineOrServer();
        }
      }, watchdogMs);

      let lastStatTimestamp = performance.now();

      try {
        const player = mpegts.createPlayer(
          {
            type: 'mpegts',
            isLive: true,
            url: tsUrl,
          },
          {
            enableWorker: true,
            enableStashBuffer: false,
            liveBufferLatencyChasing: false,
            statisticsInfoReportInterval: 500,
          }
        );
        mpegtsRef.current = player;
        player.attachMediaElement(video);
        player.load();
        syncMediaVolume();
        const playPromise = player.play();
        if (playPromise && typeof playPromise.then === 'function') {
          playPromise
            .then(() => {
              if (!effectDisposed && video.readyState >= 2) {
                frameReceived = true;
                markServerPlaybackSucceeded();
                setIsPlaying(true);
              }
            })
            .catch(() => {
              // Keep connecting animation active while retrying within the 20s window
            });
        }

        // 100% Real Network Bytes accounting from mpegts.js stream reader
        player.on(mpegts.Events.STATISTICS_INFO, (info: any) => {
          if (effectDisposed) return;
          const now = performance.now();
          const dtSec = Math.min(2.0, Math.max(0.1, (now - lastStatTimestamp) / 1000));
          lastStatTimestamp = now;
          const speedKBps = typeof info?.speed === 'number' ? info.speed : 0;
          if (speedKBps > 0) {
            const realBytes = Math.round(speedKBps * 1024 * dtSec);
            if (realBytes > 0) {
              onBytesReceivedRef.current(realBytes);
              measuredStreamBpsRef.current = Math.round(speedKBps * 1024 * 8);
            }
          }
        });

        player.on(mpegts.Events.ERROR, () => {
          clearTimeout(startupGuard);
          advanceToNextEngineOrServer();
        });
      } catch {
        clearTimeout(startupGuard);
        advanceToNextEngineOrServer();
      }

      return () => {
        effectDisposed = true;
        clearTimeout(startupGuard);
        destroyPlayers();
      };
    }

    // STAGE 5: Real-Time FFmpeg H.264 + AAC MP4 Transcoder (`transcode-mp4`)
    if (playbackEngine === 'transcode-mp4') {
      if (!hasNodeTranscoderRef.current) {
        retryOrPromptWithin15sWindow();
        return;
      }
      const targetQ = selectedQualityRef.current === 'auto' ? '720p' : selectedQualityRef.current;
      const targetSpec = QUALITY_DIMENSIONS[targetQ];
      if (targetSpec) {
        setDetectedHeight(targetSpec.height);
      }

      const transcodeUrl = buildProxiedStreamUrl(currentStream, 'ffmpeg-mp4', targetQ);
      const mp4StartupGuard = window.setTimeout(() => {
        if (!effectDisposed && (!video || video.readyState < 2)) {
          retryOrPromptWithin15sWindow();
        }
      }, 6200);

      video.src = transcodeUrl;
      video.load();
      syncMediaVolume();
      video
        .play()
        .then(() => {
          if (!effectDisposed && video.readyState >= 2) {
            clearTimeout(mp4StartupGuard);
            markServerPlaybackSucceeded();
            setIsPlaying(true);
          }
        })
        .catch(() => {
          // Keep connecting animation active while retrying within the 20s window
        });

      const onVideoError = () => {
        clearTimeout(mp4StartupGuard);
        if (!effectDisposed) {
          retryOrPromptWithin15sWindow();
        }
      };

      video.addEventListener('error', onVideoError);
      return () => {
        effectDisposed = true;
        clearTimeout(mp4StartupGuard);
        video.removeEventListener('error', onVideoError);
      };
    }

    // STAGE 1 ('proxy-hls') or STAGE 2 ('direct-hls')
    const targetHlsUrl =
      playbackEngine === 'direct-hls'
        ? currentStream.url
        : buildProxiedStreamUrl(currentStream, 'hls-proxy');

    if (Hls.isSupported()) {
      let networkRetryCount = 0;
      let mediaRecoveryCount = 0;
      let consecutiveFragErrors = 0;
      let hasBufferedAnyFrag = false;
      let manifestConnected = false;

      // Stabilized Live Broadcast HLS Configuration with 100% HTTP & HTTPS support
      const hls = new Hls({
        enableWorker: true,
        lowLatencyMode: false,
        backBufferLength: 60,
        maxBufferLength: 30,
        maxMaxBufferLength: 60,
        liveSyncDurationCount: 3,
        liveMaxLatencyDurationCount: 10,
        maxBufferHole: 0.5,
        highBufferWatchdogPeriod: 2,
        nudgeOffset: 0.2,
        nudgeMaxRetry: 10,
        manifestLoadingTimeOut: 4500,
        manifestLoadingMaxRetry: 1,
        levelLoadingTimeOut: 4500,
        levelLoadingMaxRetry: 1,
        fragLoadingTimeOut: 6000,
        fragLoadingMaxRetry: 1,
        xhrSetup: (xhr, url) => {
          // Automatically route any http:// segment or playlist on an https: page through the server proxy
          if (
            typeof window !== 'undefined' &&
            window.location.protocol === 'https:' &&
            url.toLowerCase().startsWith('http://')
          ) {
            const extra =
              (currentStream.httpReferrer
                ? `&referrer=${encodeURIComponent(currentStream.httpReferrer)}`
                : '') +
              (currentStream.userAgent
                ? `&ua=${encodeURIComponent(currentStream.userAgent)}`
                : '');
            xhr.open('GET', `/api/proxy/hls?url=${encodeURIComponent(url)}${extra}`, true);
          }
        },
      });

      hlsRef.current = hls;
      hls.loadSource(targetHlsUrl);
      hls.attachMedia(video);
      syncMediaVolume();

      // Fast startup watchdog (4.5s for proxy-hls, 3.8s for direct-hls) so FFmpeg/VLC engine is always reached within 20s!
      const hlsWatchdogMs = playbackEngine === 'proxy-hls' ? 4500 : 3800;
      const hlsStartupWatchdog = window.setTimeout(() => {
        if (!effectDisposed && !hasBufferedAnyFrag && (!video || video.readyState < 2)) {
          advanceToNextEngineOrServer(manifestConnected);
        }
      }, hlsWatchdogMs);

      hls.on(Hls.Events.MANIFEST_LOADED, (_event, data) => {
        if (effectDisposed) return;
        const manifestBytes = (data as any)?.stats?.total || 0;
        if (manifestBytes > 0) {
          onBytesReceivedRef.current(manifestBytes);
        }
      });

      hls.on(Hls.Events.LEVEL_LOADED, (_event, data) => {
        if (effectDisposed) return;
        const levelBytes = data.stats?.total || 0;
        if (levelBytes > 0) {
          onBytesReceivedRef.current(levelBytes);
        }
      });

      hls.on(Hls.Events.KEY_LOADED, (_event, data) => {
        if (effectDisposed) return;
        const keyBytes = (data as any)?.frag?.stats?.total || (data as any)?.stats?.total || 0;
        if (keyBytes > 0) {
          onBytesReceivedRef.current(keyBytes);
        }
      });

      hls.on(Hls.Events.MANIFEST_PARSED, (_event, data) => {
        if (effectDisposed) return;
        manifestConnected = true;
        networkRetryCount = 0;

        // Check if levels use codecs unsupported by browser MSE (e.g. HEVC, MPEG-2, AC-3, E-AC-3) that VLC plays via FFmpeg
        const hasUnsupportedCodec =
          data.levels.length > 0 &&
          data.levels.every((lvl: any) => {
            const vc = String(lvl.videoCodec || lvl.attrs?.CODECS || '').toLowerCase();
            const ac = String(lvl.audioCodec || lvl.attrs?.CODECS || '').toLowerCase();
            const isHevc =
              (vc.includes('hvc1') || vc.includes('hev1') || vc.includes('hevc')) &&
              typeof MediaSource !== 'undefined' &&
              !MediaSource.isTypeSupported('video/mp4; codecs="hev1.1.6.L93.B0"') &&
              !MediaSource.isTypeSupported('video/mp4; codecs="hvc1.1.6.L93.B0"');
            const isMpeg2OrAc3 =
              vc.includes('mp2v') ||
              ac.includes('ac-3') ||
              ac.includes('ec-3') ||
              ac.includes('mp4a.69') ||
              ac.includes('mp4a.6b');
            return isHevc || isMpeg2OrAc3;
          });

        if (hasUnsupportedCodec && hasNodeTranscoderRef.current) {
          clearTimeout(hlsStartupWatchdog);
          destroyPlayers();
          setPlaybackEngine(mpegts.isSupported() ? 'transcode-mpegts' : 'transcode-mp4');
          return;
        }

        const extracted: NativeHlsLevel[] = data.levels.map((lvl, idx) => ({
          index: idx,
          height: lvl.height || 0,
          bitrate: lvl.bitrate || 0,
        }));
        nativeLevelsRef.current = extracted;
        setNativeLevels(extracted);

        const firstValidHeight = extracted.find((l) => l.height > 0)?.height;
        if (firstValidHeight) {
          setDetectedHeight(firstValidHeight);
        }

        // Apply user-selected quality tier: if stream is single-bitrate and user requested a specific quality
        // (e.g. 144p/240p/360p/480p to save mobile data), switch to real-time FFmpeg downscaler!
        const matchedNatively = applyQualityToHls(
          hls,
          selectedQualityRef.current,
          extracted,
          false
        );
        if (!matchedNatively && selectedQualityRef.current !== 'auto' && hasNodeTranscoderRef.current) {
          clearTimeout(hlsStartupWatchdog);
          destroyPlayers();
          setPlaybackEngine(mpegts.isSupported() ? 'transcode-mpegts' : 'transcode-mp4');
          return;
        }

        video
          .play()
          .then(() => {
            if (!effectDisposed) {
              setIsPlaying(true);
            }
          })
          .catch(() => {
            // Keep connecting animation active until FRAG_BUFFERED / playing
          });
      });

      hls.on(Hls.Events.LEVEL_SWITCHED, (_event, data) => {
        if (effectDisposed) return;
        const lvl = hls.levels?.[data.level];
        if (lvl && lvl.height && lvl.height > 0) {
          setDetectedHeight(lvl.height);
        }
      });

      hls.on(Hls.Events.FRAG_BUFFERED, () => {
        if (effectDisposed) return;
        hasBufferedAnyFrag = true;
        consecutiveFragErrors = 0;
        markServerPlaybackSucceeded();
        clearTimeout(hlsStartupWatchdog);
        if (waitingDebounceTimerRef.current) {
          clearTimeout(waitingDebounceTimerRef.current);
          waitingDebounceTimerRef.current = null;
        }
        setIsBuffering(false);
      });

      hls.on(Hls.Events.FRAG_LOADED, (_event, data) => {
        if (effectDisposed) return;
        hasBufferedAnyFrag = true;
        consecutiveFragErrors = 0;
        const stats = data.frag.stats;
        const rawBytes = stats.total || 0;
        if (rawBytes > 0) {
          // 100% Real Network Bytes from actual downloaded media fragment!
          onBytesReceivedRef.current(rawBytes);
        }
        const durationSec = Math.max(1, data.frag.duration || 4);
        const fragBps = Math.round((rawBytes * 8) / durationSec);
        if (fragBps > 30000) {
          measuredStreamBpsRef.current = fragBps;
        }
      });

      hls.on(Hls.Events.ERROR, (_event, data) => {
        if (effectDisposed) return;

        // If /api/proxy/hls returned 415 (raw MPEG-TS/FLV stream instead of #EXTM3U manifest), jump directly to mpegts/FFmpeg!
        const responseCode = (data as any)?.response?.code;
        if (responseCode === 415) {
          clearTimeout(hlsStartupWatchdog);
          destroyPlayers();
          if (selectedQualityRef.current !== 'auto' && hasNodeTranscoderRef.current) {
            setPlaybackEngine(mpegts.isSupported() ? 'transcode-mpegts' : 'transcode-mp4');
          } else if (mpegts.isSupported()) {
            setPlaybackEngine('mpegts');
          } else if (hasNodeTranscoderRef.current) {
            setPlaybackEngine('transcode-mp4');
          } else {
            advanceToNextEngineOrServer(true);
          }
          return;
        }

        // If fragment parsing or codec buffer error occurs (common on MPEG-2 / AC-3 / raw DVB TS streams that work in VLC),
        // escalate immediately to our FFmpeg VLC transcoder!
        if (
          hasNodeTranscoderRef.current &&
          (data.details === Hls.ErrorDetails.MANIFEST_INCOMPATIBLE_CODECS_ERROR ||
            data.details === Hls.ErrorDetails.FRAG_PARSING_ERROR ||
            data.details === Hls.ErrorDetails.BUFFER_ADD_CODEC_ERROR ||
            (data.details === Hls.ErrorDetails.BUFFER_APPEND_ERROR && mediaRecoveryCount >= 1))
        ) {
          clearTimeout(hlsStartupWatchdog);
          destroyPlayers();
          setPlaybackEngine(mpegts.isSupported() ? 'transcode-mpegts' : 'transcode-mp4');
          return;
        }

        const isFragOrLevelError =
          data.details === Hls.ErrorDetails.FRAG_LOAD_ERROR ||
          data.details === Hls.ErrorDetails.FRAG_LOAD_TIMEOUT ||
          data.details === Hls.ErrorDetails.LEVEL_LOAD_ERROR ||
          data.details === Hls.ErrorDetails.LEVEL_LOAD_TIMEOUT ||
          data.details === Hls.ErrorDetails.KEY_LOAD_ERROR;

        if (isFragOrLevelError) {
          consecutiveFragErrors += 1;
          const levelCount = hls.levels?.length || 1;
          const maxAllowedNonFatal = levelCount > 1 ? 3 : 2;
          if (!hasBufferedAnyFrag && consecutiveFragErrors >= maxAllowedNonFatal) {
            clearTimeout(hlsStartupWatchdog);
            advanceToNextEngineOrServer(manifestConnected);
            return;
          }
        }

        if (!data.fatal) {
          if (data.details === Hls.ErrorDetails.BUFFER_STALLED_ERROR) {
            if (video && video.paused) {
              video.play().catch(() => {});
            }
          }
          return;
        }

        if (data.type === Hls.ErrorTypes.MEDIA_ERROR && mediaRecoveryCount < 1) {
          mediaRecoveryCount += 1;
          hls.recoverMediaError();
        } else if (
          data.type === Hls.ErrorTypes.NETWORK_ERROR &&
          networkRetryCount < 1 &&
          hasBufferedAnyFrag &&
          data.details !== Hls.ErrorDetails.MANIFEST_LOAD_ERROR &&
          data.details !== Hls.ErrorDetails.MANIFEST_PARSING_ERROR
        ) {
          networkRetryCount += 1;
          hls.startLoad();
        } else {
          clearTimeout(hlsStartupWatchdog);
          advanceToNextEngineOrServer(manifestConnected);
        }
      });

      // Upgrade to FFmpeg transcoder for audio-only HEVC/MPEG-2 streams if the Node transcoder is available
      const audioOnlyWatchdog = window.setTimeout(() => {
        if (
          !effectDisposed &&
          hasNodeTranscoderRef.current &&
          video &&
          !video.paused &&
          video.currentTime > 1.2 &&
          video.videoWidth === 0
        ) {
          clearTimeout(hlsStartupWatchdog);
          destroyPlayers();
          setPlaybackEngine(mpegts.isSupported() ? 'transcode-mpegts' : 'transcode-mp4');
        }
      }, 3200);

      return () => {
        effectDisposed = true;
        clearTimeout(hlsStartupWatchdog);
        clearTimeout(audioOnlyWatchdog);
        destroyPlayers();
      };
    } else if (video.canPlayType('application/vnd.apple.mpegurl')) {
      video.src = targetHlsUrl;
      syncMediaVolume();
      video
        .play()
        .then(() => {
          if (!effectDisposed && video.readyState >= 2) {
            markServerPlaybackSucceeded();
            setIsPlaying(true);
          }
        })
        .catch(() => {
          // Keep connecting animation active while retrying within the 20s window
        });

      const onNativeError = () => {
        if (!effectDisposed) {
          advanceToNextEngineOrServer(false);
        }
      };
      video.addEventListener('error', onNativeError);
      return () => {
        effectDisposed = true;
        video.removeEventListener('error', onNativeError);
      };
    } else {
      advanceToNextEngineOrServer(false);
    }

    return () => {
      effectDisposed = true;
      destroyPlayers();
    };
  }, [
    channel.id,
    activeStreamIndex,
    activeStreamUrl,
    playbackEngine,
    reloadNonce,
    destroyPlayers,
    applyQualityToHls,
    clearServer15sTimer,
    markServerPlaybackSucceeded,
    syncMediaVolume,
  ]);

  /**
   * 2. Real-Time Direct Video Element Byte Accounting (`native-video` & `transcode-mp4`)
   * Plus live resolution tracking from the decoded video frame (`video.videoHeight`)
   */
  const lastDirectElementBytesRef = useRef<number | null>(null);

  useEffect(() => {
    const interval = window.setInterval(async () => {
      const video = videoRef.current;
      if (video && !video.paused && video.videoHeight > 0) {
        setDetectedHeight(video.videoHeight);
      }

      if (playbackEngine === 'native-video' || playbackEngine === 'transcode-mp4') {
        try {
          const res = await fetch('/api/proxy/bytes-status');
          if (res.ok) {
            const data = await res.json();
            const currentBytes =
              typeof data?.directElementBytesServed === 'number'
                ? data.directElementBytesServed
                : 0;
            if (lastDirectElementBytesRef.current !== null) {
              const delta = currentBytes - lastDirectElementBytesRef.current;
              if (delta > 0) {
                onBytesReceivedRef.current(delta);
              }
            }
            lastDirectElementBytesRef.current = currentBytes;
          }
        } catch {
          // ignore
        }
      }
    }, 1000);

    return () => clearInterval(interval);
  }, [playbackEngine]);

  /**
   * 3. User-Initiated Quality Switching (`Auto, 1080p, 720p, 480p, 360p, 240p, 144p`)
   * - Genuinely switches resolution & bitrate: uses native HLS variant when available,
   *   or switches to real-time FFmpeg server-side downscaling (`transcode-mpegts`) so mobile data is truly saved!
   */
  const handleSelectQualityOption = (tierId: QualityTierId) => {
    onSelectQuality(tierId);
    selectedQualityRef.current = tierId;
    setShowQualityMenu(false);
    resetFullscreenAutoHideTimer();

    if (tierId !== 'auto') {
      const spec = QUALITY_DIMENSIONS[tierId];
      if (spec) {
        setDetectedHeight(spec.height);
      }
    }

    // If user selected 'auto' while in transcode mode on a standard HLS/TS stream, return to initial engine
    if (
      tierId === 'auto' &&
      (playbackEngine === 'transcode-mpegts' || playbackEngine === 'transcode-mp4')
    ) {
      const initialEng = computeInitialEngine(activeStreamUrl, 'auto', hasNodeTranscoderRef.current);
      if (initialEng !== playbackEngine) {
        startNew15sServerWindow();
        setPlaybackEngine(initialEng);
        return;
      }
    }

    if (
      (playbackEngine === 'transcode-mp4' || playbackEngine === 'transcode-mpegts') &&
      hasNodeTranscoderRef.current
    ) {
      startNew15sServerWindow();
      setReloadNonce((n) => n + 1);
      return;
    }

    if (playbackEngine === 'mpegts' || playbackEngine === 'native-video') {
      if (tierId !== 'auto' && hasNodeTranscoderRef.current) {
        startNew15sServerWindow();
        setPlaybackEngine(mpegts.isSupported() ? 'transcode-mpegts' : 'transcode-mp4');
      }
      return;
    }

    const hls = hlsRef.current;
    if (!hls) return;

    const matchedNatively = applyQualityToHls(hls, tierId, nativeLevelsRef.current, true);
    if (!matchedNatively && tierId !== 'auto' && hasNodeTranscoderRef.current) {
      // Single-bitrate HLS stream or missing low-bitrate variant: switch to FFmpeg downscaler to truly save mobile data!
      startNew15sServerWindow();
      setPlaybackEngine(mpegts.isSupported() ? 'transcode-mpegts' : 'transcode-mp4');
    }
  };

  // Track video playback & DVR seekable window with debounced buffering state
  useEffect(() => {
    const video = videoRef.current;
    if (!video) return;

    const clearBufferingNow = () => {
      if (waitingDebounceTimerRef.current) {
        clearTimeout(waitingDebounceTimerRef.current);
        waitingDebounceTimerRef.current = null;
      }
      setIsBuffering(false);
    };

    const onPlaying = () => {
      syncMediaVolume();
      if (video.readyState >= 2) {
        markServerPlaybackSucceeded();
        clearBufferingNow();
        setErrorMsg(null);
      }
      setIsPlaying(true);
      if (video.videoHeight > 0) {
        setDetectedHeight(video.videoHeight);
      }
    };

    const onCanPlay = () => {
      syncMediaVolume();
      if (video.readyState >= 2) {
        markServerPlaybackSucceeded();
        clearBufferingNow();
      }
      if (video.videoHeight > 0) {
        setDetectedHeight(video.videoHeight);
      }
    };

    const onLoadedMetadataOrStart = () => {
      syncMediaVolume();
    };

    const onVolumeChange = () => {
      // Prevent any underlying playback engine (e.g. mpegts.js or new MSE attachment) from resetting volume
      syncMediaVolume();
    };

    const onWaiting = () => {
      if (waitingDebounceTimerRef.current) {
        clearTimeout(waitingDebounceTimerRef.current);
      }
      // Debounce by 550ms so micro-stalls between segments never flash the loading overlay
      waitingDebounceTimerRef.current = window.setTimeout(() => {
        if (video && video.readyState < 3 && !video.paused) {
          setIsBuffering(true);
        }
      }, 550);
    };

    const onTimeUpdate = () => {
      if (!video.paused && video.readyState >= 2) {
        markServerPlaybackSucceeded();
        clearBufferingNow();
      }
      setCurrentTime(video.currentTime);
      if (video.seekable && video.seekable.length > 0) {
        setSeekableStart(video.seekable.start(0));
        setSeekableEnd(video.seekable.end(video.seekable.length - 1));
      } else if (video.duration && isFinite(video.duration)) {
        setSeekableStart(0);
        setSeekableEnd(video.duration);
      }
    };

    video.addEventListener('loadstart', onLoadedMetadataOrStart);
    video.addEventListener('loadedmetadata', onLoadedMetadataOrStart);
    video.addEventListener('volumechange', onVolumeChange);
    video.addEventListener('playing', onPlaying);
    video.addEventListener('canplay', onCanPlay);
    video.addEventListener('canplaythrough', onCanPlay);
    video.addEventListener('waiting', onWaiting);
    video.addEventListener('timeupdate', onTimeUpdate);

    return () => {
      if (waitingDebounceTimerRef.current) {
        clearTimeout(waitingDebounceTimerRef.current);
      }
      video.removeEventListener('loadstart', onLoadedMetadataOrStart);
      video.removeEventListener('loadedmetadata', onLoadedMetadataOrStart);
      video.removeEventListener('volumechange', onVolumeChange);
      video.removeEventListener('playing', onPlaying);
      video.removeEventListener('canplay', onCanPlay);
      video.removeEventListener('canplaythrough', onCanPlay);
      video.removeEventListener('waiting', onWaiting);
      video.removeEventListener('timeupdate', onTimeUpdate);
    };
  }, [markServerPlaybackSucceeded, syncMediaVolume]);

  useEffect(() => {
    volumeRef.current = volume;
    isMutedRef.current = isMuted;
    syncMediaVolume();
    try {
      localStorage.setItem('iptv_player_volume', String(volume));
      localStorage.setItem('iptv_player_muted', String(isMuted));
    } catch {
      // ignore
    }
  }, [volume, isMuted, syncMediaVolume]);

  const togglePlay = (e: React.MouseEvent) => {
    e.stopPropagation();
    const video = videoRef.current;
    if (!video || !activeStream) return;
    if (video.paused) {
      video.play().catch(() => {});
      setIsPlaying(true);
    } else {
      video.pause();
      setIsPlaying(false);
    }
    resetFullscreenAutoHideTimer();
  };

  const handleToggleFullscreen = async (e: React.MouseEvent) => {
    e.stopPropagation();
    if (stageMode === 'fullscreen') {
      onChangeStageMode('theater');
      setIsRotatedHorizontal(false);
      setVideoZoom(1);
      setShowControls(true);
      try {
        if (screen.orientation && (screen.orientation as any).unlock) {
          (screen.orientation as any).unlock();
        }
      } catch {
        // ignore
      }
      if (document.fullscreenElement) {
        try {
          await document.exitFullscreen();
        } catch {
          // ignore
        }
      }
    } else {
      onChangeStageMode('fullscreen');
      setShowControls(true);
      if (containerRef.current?.requestFullscreen) {
        try {
          await containerRef.current.requestFullscreen();
        } catch {
          // CSS fixed fullscreen handles restricted environments automatically
        }
      }
    }
  };

  const toggleOrientationRotate = async (e: React.MouseEvent) => {
    e.stopPropagation();
    const nextHorizontal = !isRotatedHorizontal;
    if (stageMode !== 'fullscreen') {
      onChangeStageMode('fullscreen');
      if (containerRef.current?.requestFullscreen) {
        try {
          await containerRef.current.requestFullscreen();
        } catch {
          // ignore
        }
      }
    }
    setIsRotatedHorizontal(nextHorizontal);
    setVideoZoom(1);
    setShowControls(true);
    resetFullscreenAutoHideTimer();
    try {
      if (screen.orientation && (screen.orientation as any).lock) {
        if (nextHorizontal) {
          await (screen.orientation as any).lock('landscape');
        } else {
          (screen.orientation as any).unlock?.();
        }
      }
    } catch {
      // CSS 90deg rotation handles devices where orientation.lock is not permitted
    }
  };

  const startRecording = (e: React.MouseEvent) => {
    e.stopPropagation();
    const video = videoRef.current;
    if (!video || isRecording || !activeStream) return;

    if (pendingRecording?.url) {
      URL.revokeObjectURL(pendingRecording.url);
      setPendingRecording(null);
    }

    const targetSpec = QUALITY_DIMENSIONS[recordQuality] || QUALITY_DIMENSIONS['720p'];
    const canvas = document.createElement('canvas');
    canvas.width = targetSpec.width;
    canvas.height = targetSpec.height;
    const ctx = canvas.getContext('2d');
    if (!ctx) return;

    const drawPureVideoFrame = () => {
      if (video && !video.paused && !video.ended && video.videoWidth > 0 && video.videoHeight > 0) {
        try {
          ctx.drawImage(video, 0, 0, canvas.width, canvas.height);
        } catch {
          // ignore if cross-origin taint occurs on direct unproxied stream
        }
      }
    };

    drawPureVideoFrame();
    recordDrawTimerRef.current = window.setInterval(drawPureVideoFrame, 33);

    let captureMediaStream: MediaStream;
    try {
      const vidAny = video as any;
      const directVideoStream: MediaStream | undefined = vidAny.captureStream
        ? vidAny.captureStream()
        : vidAny.mozCaptureStream
        ? vidAny.mozCaptureStream()
        : undefined;

      captureMediaStream = canvas.captureStream(30);
      if (directVideoStream) {
        directVideoStream.getAudioTracks().forEach((track) => {
          captureMediaStream.addTrack(track);
        });
      }
    } catch {
      captureMediaStream = canvas.captureStream(30);
    }

    // Strictly prioritize MP4 / H.264 MIME types first so the recording is natively MP4 whenever supported
    const mimeTypes = [
      'video/mp4;codecs=avc1.42E01E,mp4a.40.2',
      'video/mp4;codecs=avc1.424028,mp4a.40.2',
      'video/mp4;codecs=avc1,mp4a.40.2',
      'video/mp4;codecs=h264,aac',
      'video/mp4;codecs=avc1',
      'video/mp4',
      'video/webm;codecs=h264,opus',
      'video/webm;codecs=vp9,opus',
      'video/webm;codecs=vp8,opus',
      'video/webm',
    ];
    const supportedMime = mimeTypes.find((m) => MediaRecorder.isTypeSupported(m)) || '';

    try {
      const recorder = new MediaRecorder(captureMediaStream, {
        ...(supportedMime ? { mimeType: supportedMime } : {}),
        videoBitsPerSecond: targetSpec.bps,
      });

      recordedChunksRef.current = [];
      setRecordSeconds(0);
      recordDurationRef.current = 0;

      recorder.ondataavailable = (ev: BlobEvent) => {
        if (ev.data && ev.data.size > 0) {
          recordedChunksRef.current.push(ev.data);
        }
      };

      recorder.onstop = async () => {
        if (recordDrawTimerRef.current) {
          clearInterval(recordDrawTimerRef.current);
          recordDrawTimerRef.current = null;
        }
        if (recordClockRef.current) {
          clearInterval(recordClockRef.current);
          recordClockRef.current = null;
        }

        const rawBlob = new Blob(recordedChunksRef.current, {
          type: supportedMime || 'video/mp4',
        });

        let finalMp4Blob: Blob = new Blob([rawBlob], { type: 'video/mp4' });

        // If browser recorded WebM internally and Node FFmpeg backend is active, remux/transcode to standard H.264+AAC MP4
        if (!supportedMime.includes('mp4') && hasNodeTranscoderRef.current && rawBlob.size > 0) {
          try {
            const resp = await fetch('/api/proxy/remux-mp4', {
              method: 'POST',
              headers: {
                'Content-Type': 'application/octet-stream',
              },
              body: rawBlob,
            });
            if (resp.ok) {
              const convertedBuffer = await resp.arrayBuffer();
              if (convertedBuffer.byteLength > 0) {
                finalMp4Blob = new Blob([convertedBuffer], { type: 'video/mp4' });
              }
            }
          } catch {
            // Fallback to MP4-typed blob if offline
          }
        }

        const safeName = channel.name.replace(/[^a-zA-Z0-9_-]/g, '_').slice(0, 30);
        const timestamp = new Date().toISOString().slice(11, 19).replace(/:/g, '-');
        const filename = `${safeName}_${recordQuality}_${timestamp}.mp4`;
        const downloadUrl = URL.createObjectURL(finalMp4Blob);

        setPendingRecording({
          url: downloadUrl,
          filename,
          durationSec: Math.max(1, recordDurationRef.current),
          sizeBytes: finalMp4Blob.size,
          quality: recordQuality,
        });
        setIsRecording(false);
        setShowControls(true);
      };

      recorder.start(1000);
      mediaRecorderRef.current = recorder;
      setIsRecording(true);

      recordClockRef.current = window.setInterval(() => {
        recordDurationRef.current += 1;
        setRecordSeconds(recordDurationRef.current);
      }, 1000);
    } catch (err: any) {
      setErrorMsg(`Recording error: ${err?.message || 'Unsupported browser codec'}`);
    }
    resetFullscreenAutoHideTimer();
  };

  const stopRecording = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (mediaRecorderRef.current && mediaRecorderRef.current.state !== 'inactive') {
      mediaRecorderRef.current.stop();
    }
    resetFullscreenAutoHideTimer();
  };

  const handleConfirmDownloadRecording = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (!pendingRecording) return;
    const a = document.createElement('a');
    a.href = pendingRecording.url;
    a.download = pendingRecording.filename;
    document.body.appendChild(a);
    a.click();
    document.body.removeChild(a);

    const urlToRevoke = pendingRecording.url;
    setPendingRecording(null);
    setTimeout(() => URL.revokeObjectURL(urlToRevoke), 5000);
    resetFullscreenAutoHideTimer();
  };

  const handleCancelRecording = (e: React.MouseEvent) => {
    e.stopPropagation();
    if (pendingRecording?.url) {
      URL.revokeObjectURL(pendingRecording.url);
    }
    setPendingRecording(null);
    resetFullscreenAutoHideTimer();
  };

  const formatTime = (sec: number) => {
    const clean = Math.max(0, Math.floor(sec));
    const mins = Math.floor(clean / 60);
    const rem = clean % 60;
    return `${String(mins).padStart(2, '0')}:${String(rem).padStart(2, '0')}`;
  };

  const activeTierObj = QUALITY_TIERS.find((t) => t.id === selectedQuality) || QUALITY_TIERS[0];
  const sessionMb = sessionBytes / (1024 * 1024);

  const activePixelLabel =
    selectedQuality === 'auto' ? `${detectedHeight || 720}p` : selectedQuality;

  const timelineWindow = Math.max(1, seekableEnd - seekableStart);
  const clampedCurrent = Math.max(seekableStart, Math.min(seekableEnd, currentTime));
  const behindLiveSeconds = Math.max(0, seekableEnd - clampedCurrent);
  const isBehindLive = seekableEnd > 3 && behindLiveSeconds > 3.5;
  const progressPercent =
    seekableEnd > seekableStart
      ? Math.max(0, Math.min(100, ((clampedCurrent - seekableStart) / timelineWindow) * 100))
      : 100;

  const currentLogoUrl = candidateLogos[logoCandidateIdx] || '';

  const needsCssLandscapeRotation =
    isFullscreen && isRotatedHorizontal && viewportSize.width < viewportSize.height;

  const outerContainerClasses = isFullscreen
    ? 'fixed inset-0 z-[100] bg-black text-white overflow-hidden select-none'
    : 'relative z-10 w-full bg-white text-slate-900 rounded-2xl shadow-sm select-none border border-slate-200';

  const innerStageStyle: React.CSSProperties | undefined = needsCssLandscapeRotation
    ? {
        position: 'fixed',
        top: '50%',
        left: '50%',
        width: `${viewportSize.height}px`,
        height: `${viewportSize.width}px`,
        transform: 'translate(-50%, -50%) rotate(90deg)',
      }
    : undefined;

  const innerStageClasses = isFullscreen
    ? needsCssLandscapeRotation
      ? 'bg-black text-white overflow-hidden'
      : 'fixed inset-0 w-full h-full bg-black text-white overflow-hidden'
    : 'relative w-full flex flex-col bg-white text-slate-900 rounded-2xl';

  const buttonSurfaceClass = isFullscreen
    ? 'bg-white/15 hover:bg-white/25 text-white border border-white/15'
    : 'bg-slate-100 hover:bg-slate-200 text-slate-800 border border-slate-200';

  const menuSurfaceClass = isFullscreen
    ? 'bg-neutral-900/95 border border-white/15 text-white backdrop-blur-md'
    : 'bg-white border border-slate-200 text-slate-900';

  const [copiedPlayerStreamIdx, setCopiedPlayerStreamIdx] = useState<number | null>(null);

  const handleCopyPlayerStreamUrl = async (
    url: string,
    sIdx: number,
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
    setCopiedPlayerStreamIdx(sIdx);
    window.setTimeout(() => {
      setCopiedPlayerStreamIdx((prev) => (prev === sIdx ? null : prev));
    }, 2000);
  };

  return (
    <div ref={containerRef} className={outerContainerClasses}>
      <div className={innerStageClasses} style={innerStageStyle}>
        {/* SLEEK TOP BAR (Permanently attached to player in normal view; z-index elevates only when server menu is open so quality menu from bottom bar is never hidden behind top bar) */}
        <div
          onClick={(e) => {
            e.stopPropagation();
            resetFullscreenAutoHideTimer();
          }}
          className={`w-full flex items-center justify-between gap-2 px-2.5 sm:px-4 py-1.5 transition-opacity duration-200 ${
            isFullscreen
              ? `absolute top-0 inset-x-0 ${
                  showServerMenu ? 'z-[60]' : 'z-30'
                } bg-gradient-to-b from-black/90 via-black/60 to-transparent text-white pb-3 ${
                  showControls
                    ? 'opacity-100 pointer-events-auto'
                    : 'opacity-0 pointer-events-none'
                }`
              : `relative ${
                  showServerMenu ? 'z-50' : 'z-20'
                } bg-white border-b border-slate-200 text-slate-900 rounded-t-2xl opacity-100 pointer-events-auto`
          }`}
        >
          <div className="flex items-center gap-2 min-w-0 flex-1">
            <div className="w-7 h-7 sm:w-8 sm:h-8 rounded-lg bg-slate-200/80 border border-slate-300/80 p-1 flex items-center justify-center overflow-hidden shrink-0">
              {currentLogoUrl ? (
                <img
                  src={currentLogoUrl}
                  alt={channel.name}
                  referrerPolicy="no-referrer"
                  onError={() => setLogoCandidateIdx((i) => i + 1)}
                  className="w-full h-full object-contain"
                />
              ) : (
                <span className="font-display text-[10px] font-extrabold text-red-600">
                  {channel.name.slice(0, 2).toUpperCase()}
                </span>
              )}
            </div>

            <div className="min-w-0 flex-1">
              <div className="flex items-center gap-1.5 flex-wrap">
                <span
                  className={`font-display text-xs sm:text-sm font-bold truncate ${
                    isFullscreen ? 'text-white' : 'text-slate-900'
                  }`}
                >
                  {channel.name}
                </span>
                <span
                  className={`text-[11px] font-mono font-semibold shrink-0 ${
                    isFullscreen ? 'text-slate-300' : 'text-slate-500'
                  }`}
                >
                  ({channel.countryName || channel.country})
                </span>
              </div>
            </div>
          </div>

          <div className="flex items-center gap-1.5 sm:gap-2 shrink-0">
            {videoZoom > 1.01 && (
              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setVideoZoom(1);
                  showTransientZoomNotice('Original (1.0x)');
                }}
                className="px-2 py-0.5 rounded-lg bg-red-600 text-white font-mono text-[11px] font-bold whitespace-nowrap shrink-0"
              >
                {videoZoom.toFixed(1)}x (Reset)
              </button>
            )}

            {/* COMPACT UP-TO-DOWN RED-THEMED MOBILE DATA METER + PIXEL METER + PLAYING SERVER SELECTOR */}
            <div className="relative flex flex-col items-stretch rounded-lg bg-red-600 text-white border border-red-700 shadow-xs shrink-0">
              <div className="flex items-center justify-center gap-1 px-2 py-0.5 font-mono tabular-nums text-[9px] sm:text-[10px] font-bold leading-tight whitespace-nowrap">
                <span>{sessionMb.toFixed(2)} MB</span>
                <span className="text-red-200">•</span>
                <span>{activePixelLabel}</span>
              </div>

              {channel.streams.length > 0 && (
                <button
                  type="button"
                  data-player-menu="server"
                  onClick={(e) => {
                    e.stopPropagation();
                    setShowServerMenu((prev) => !prev);
                    setShowQualityMenu(false);
                    setShowRecordMenu(false);
                    setShowRecordConfirmMenu(false);
                  }}
                  title="Select Playing Stream Server"
                  className="flex items-center justify-center gap-1 px-2 py-0.5 border-t border-red-400/50 hover:bg-red-700 active:bg-red-800 rounded-b-lg text-[9px] sm:text-[10px] font-bold leading-tight transition-colors whitespace-nowrap cursor-pointer"
                >
                  <Server className="w-2.5 h-2.5 text-white shrink-0" />
                  <span>
                    Server {activeStreamIndex + 1}/{channel.streams.length}
                  </span>
                  <ChevronDown
                    className={`w-2.5 h-2.5 text-red-100 transition-transform duration-150 ${
                      showServerMenu ? 'rotate-180' : ''
                    }`}
                  />
                </button>
              )}

              {showServerMenu && channel.streams.length > 0 && (
                <div
                  data-player-menu="server"
                  onClick={(e) => e.stopPropagation()}
                  className={`absolute top-full right-0 mt-1.5 w-44 max-h-[180px] overflow-y-auto rounded-2xl shadow-xl p-1.5 z-50 ${menuSurfaceClass}`}
                >
                  {channel.streams.map((st, sIdx) => {
                    const isCurrent = activeStreamIndex === sIdx;
                    const isCopied = copiedPlayerStreamIdx === sIdx;
                    return (
                      <div
                        key={`player-srv-${sIdx}`}
                        className={`w-full h-7 flex items-center justify-between gap-1 px-2 rounded-xl text-xs transition-colors ${
                          isCurrent
                            ? 'bg-red-600 text-white font-bold'
                            : isFullscreen
                            ? 'text-slate-200 hover:bg-white/10'
                            : 'text-slate-700 hover:bg-slate-100'
                        }`}
                      >
                        <button
                          type="button"
                          onClick={(e) => {
                            e.stopPropagation();
                            if (isCurrent) return;
                            onSelectStreamIndex(sIdx);
                            setShowServerMenu(false);
                            resetFullscreenAutoHideTimer();
                          }}
                          className="flex-1 min-w-0 h-full flex items-center text-left select-none"
                        >
                          <span className="font-mono text-[10px] whitespace-nowrap overflow-x-auto no-scrollbar select-none">
                            {st.url}
                          </span>
                        </button>

                        <button
                          type="button"
                          onClick={(e) =>
                            handleCopyPlayerStreamUrl(st.url, sIdx, e)
                          }
                          title="Copy stream URL"
                          aria-label="Copy stream URL"
                          className={`w-[46px] h-5 justify-center shrink-0 inline-flex items-center gap-0.5 rounded-lg text-[9px] font-bold transition-colors ${
                            isCurrent
                              ? 'bg-white text-red-600 hover:bg-red-50'
                              : isFullscreen
                              ? 'bg-white/15 text-white hover:bg-white/25'
                              : 'bg-slate-100 border border-slate-200 text-slate-700 hover:border-red-600 hover:text-red-600'
                          }`}
                        >
                          {isCopied ? (
                            <>
                              <Check className="w-2.5 h-2.5 shrink-0" />
                              <span>Copied</span>
                            </>
                          ) : (
                            <>
                              <Copy className="w-2.5 h-2.5 shrink-0" />
                              <span>Copy</span>
                            </>
                          )}
                        </button>
                      </div>
                    );
                  })}
                </div>
              )}
            </div>

            <button
              type="button"
              onClick={(e) => {
                e.stopPropagation();
                if (document.fullscreenElement) {
                  document.exitFullscreen().catch(() => {});
                }
                onClosePlayer();
              }}
              title="Close Player"
              className={`p-1 rounded-lg transition-colors ${
                isFullscreen
                  ? 'bg-white/15 hover:bg-red-600 text-white border border-white/15'
                  : 'bg-slate-100 hover:bg-red-600 text-slate-700 hover:text-white border border-slate-200'
              }`}
            >
              <X className="w-3.5 h-3.5" />
            </button>
          </div>
        </div>

        {/* 16:9 VIDEO SURFACE */}
        <div
          onClick={handleVideoSurfacePointerUp}
          onTouchStart={handleTouchStart}
          onTouchMove={handleTouchMove}
          onTouchEnd={handleTouchEnd}
          onWheel={handleVideoWheel}
          style={{ touchAction: isFullscreen ? 'none' : 'pan-y' }}
          className={`w-full flex items-center justify-center overflow-hidden cursor-pointer ${
            isFullscreen
              ? 'absolute inset-0 z-10 h-full bg-black'
              : 'relative z-10 aspect-video max-h-[62vh] bg-[#F4F6F9]'
          }`}
        >
          {!activeStream ? (
            <div
              className={`flex flex-col items-center justify-center p-6 text-center rounded-2xl border ${
                isFullscreen
                  ? 'bg-neutral-900 border-white/15 text-white'
                  : 'bg-white border-slate-200 text-slate-900'
              }`}
            >
              <AlertCircle className="w-8 h-8 text-amber-500 mb-2" />
              <p className="text-sm font-bold">Stream URL Not Available</p>
            </div>
          ) : (
            <video
              ref={videoRef}
              style={{
                transform: videoZoom !== 1 ? `scale(${videoZoom})` : undefined,
                transformOrigin: 'center center',
              }}
              className={`w-full h-full object-contain pointer-events-none transition-transform duration-75 ${
                isFullscreen ? 'bg-black' : 'bg-[#F4F6F9]'
              }`}
              playsInline
            />
          )}

          {zoomNotice && (
            <div className="absolute top-14 left-1/2 -translate-x-1/2 px-3.5 py-1.5 rounded-full bg-black/80 text-white font-display text-xs font-bold border border-white/20 pointer-events-none z-30 shadow-lg">
              {zoomNotice}
            </div>
          )}

          {seekFeedback && (
            <div
              className={`absolute inset-y-0 ${
                seekFeedback.side === 'left'
                  ? 'left-0 w-2/5 rounded-r-full'
                  : 'right-0 w-2/5 rounded-l-full'
              } bg-black/35 backdrop-blur-xs flex flex-col items-center justify-center pointer-events-none animate-pulse z-20`}
            >
              <div className="w-11 h-11 rounded-full bg-red-600 flex items-center justify-center text-white mb-1">
                {seekFeedback.side === 'left' ? (
                  <Rewind className="w-5 h-5 fill-current" />
                ) : (
                  <FastForward className="w-5 h-5 fill-current" />
                )}
              </div>
              <span className="font-display text-xs font-bold text-white bg-black/75 px-2.5 py-0.5 rounded-full">
                {seekFeedback.side === 'left'
                  ? `-${seekFeedback.seconds} seconds`
                  : `+${seekFeedback.seconds} seconds`}
              </span>
            </div>
          )}

          {(isBuffering || isConnectingWindow) && !errorMsg && activeStream && (
            <div
              className={`absolute inset-0 flex flex-col items-center justify-center pointer-events-none z-10 ${
                isFullscreen ? 'bg-black/45' : 'bg-white/55 backdrop-blur-[2px]'
              }`}
            >
              <div
                className={`px-4 py-2.5 rounded-2xl border flex flex-col items-center ${
                  isFullscreen
                    ? 'bg-neutral-900/90 border-white/15 text-white'
                    : 'bg-white border-slate-200 text-slate-800 shadow-lg'
                }`}
              >
                <Loader2 className="w-7 h-7 text-red-600 animate-spin mb-1" />
                <span className="text-xs font-bold">
                  Connecting to Server {activeStreamIndex + 1}...
                </span>
              </div>
            </div>
          )}

          {errorMsg && (
            <div
              onClick={(e) => e.stopPropagation()}
              className={`absolute inset-0 flex flex-col items-center justify-center p-4 sm:p-6 text-center z-20 ${
                isFullscreen ? 'bg-black/95 text-white' : 'bg-white/95 text-slate-900'
              }`}
            >
              <AlertCircle className="w-7 h-7 text-red-600 mb-1.5" />
              <h4 className="font-display text-sm sm:text-base font-bold mb-1">
                Stream Temporarily Offline
              </h4>
              <p
                className={`text-xs max-w-xs mb-3 line-clamp-2 ${
                  isFullscreen ? 'text-slate-300' : 'text-slate-600'
                }`}
              >
                {errorMsg}
              </p>
              <div className="flex flex-row items-center justify-center gap-2">
                <button
                  onClick={() => {
                    hasTriedResolveRef.current = false;
                    setResolvedOverrideStream(null);
                    startNew15sServerWindow();
                    setPlaybackEngine(computeInitialEngine(activeStreamUrl));
                    setReloadNonce((n) => n + 1);
                  }}
                  className="flex items-center gap-1.5 px-3.5 py-1.5 text-xs font-bold bg-red-600 hover:bg-red-700 text-white rounded-xl transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                >
                  <Loader2 className="w-3.5 h-3.5" />
                  <span>Reconnect</span>
                </button>
                {channel.streams.length > 1 && (
                  <button
                    onClick={() => {
                      hasTriedResolveRef.current = false;
                      setResolvedOverrideStream(null);
                      onSelectStreamIndex((activeStreamIndex + 1) % channel.streams.length);
                    }}
                    className={`px-3.5 py-1.5 text-xs font-bold rounded-xl transition-colors whitespace-nowrap shrink-0 cursor-pointer ${buttonSurfaceClass}`}
                  >
                    Switch to Server {((activeStreamIndex + 1) % channel.streams.length) + 1}
                  </button>
                )}
              </div>
            </div>
          )}

        </div>

        {/* ULTRA-SLEEK COMPACT BOTTOM CONTROL TRAY (z-50 when quality/record menu is open so it always renders above the top bar and never gets clipped) */}
        <div
          ref={bottomTrayRef}
          onClick={(e) => {
            e.stopPropagation();
            resetFullscreenAutoHideTimer();
          }}
          className={`w-full flex flex-col px-2.5 sm:px-4 pt-1 pb-1.5 transition-opacity duration-200 ${
            isFullscreen
              ? `absolute bottom-0 inset-x-0 ${
                  showQualityMenu ||
                  showRecordMenu ||
                  showRecordConfirmMenu ||
                  pendingRecording
                    ? 'z-[60]'
                    : 'z-40'
                } bg-gradient-to-t from-black/95 via-black/80 to-transparent text-white pt-4 ${
                  showControls
                    ? 'opacity-100 pointer-events-auto'
                    : 'opacity-0 pointer-events-none'
                }`
              : `relative ${
                  showQualityMenu ||
                  showRecordMenu ||
                  showRecordConfirmMenu ||
                  pendingRecording
                    ? 'z-50'
                    : 'z-30'
                } bg-white border-t border-slate-200 text-slate-900 rounded-b-2xl opacity-100 pointer-events-auto`
          }`}
        >
          {/* SCREEN RECORDING START / CANCEL POPOVER (Directly above Screen Recording option, matching Server Selection box layout) */}
          {showRecordConfirmMenu && !isRecording && (
            <div
              data-player-menu="record-confirm"
              onClick={(e) => e.stopPropagation()}
              style={{ right: `${recordPopoverRightPx}px` }}
              className={`absolute bottom-full mb-1.5 w-44 rounded-2xl shadow-xl p-1.5 z-50 flex flex-col gap-1 ${menuSurfaceClass}`}
            >
              <button
                type="button"
                onClick={(e) => {
                  setShowRecordConfirmMenu(false);
                  startRecording(e);
                }}
                className="w-full h-7 flex items-center justify-between gap-1 px-2.5 rounded-xl text-xs font-bold bg-red-600 hover:bg-red-700 text-white transition-colors cursor-pointer"
              >
                <span className="flex items-center gap-1.5">
                  <Disc className="w-3.5 h-3.5 shrink-0" />
                  <span>Start</span>
                </span>
                <span className="font-mono tabular-nums text-[10px] opacity-90">
                  {recordQuality}
                </span>
              </button>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowRecordConfirmMenu(false);
                  resetFullscreenAutoHideTimer();
                }}
                className={`w-full h-7 flex items-center justify-between gap-1 px-2.5 rounded-xl text-xs font-bold transition-colors cursor-pointer ${
                  isFullscreen
                    ? 'text-slate-200 hover:bg-white/10'
                    : 'text-slate-700 hover:bg-slate-100'
                }`}
              >
                <span className="flex items-center gap-1.5">
                  <X className="w-3.5 h-3.5 shrink-0" />
                  <span>Cancel</span>
                </span>
                <span className="font-mono text-[10px] opacity-75">Close</span>
              </button>
            </div>
          )}

          {/* RECORDING FINISHED DOWNLOAD / CANCEL POPOVER (Directly above Screen Recording option, matching Server Selection box layout) */}
          {pendingRecording &&
            !isRecording &&
            !showRecordConfirmMenu &&
            !showRecordMenu && (
              <div
                onClick={(e) => e.stopPropagation()}
                style={{ right: `${recordPopoverRightPx}px` }}
                className={`absolute bottom-full mb-1.5 w-44 rounded-2xl shadow-xl p-1.5 z-50 flex flex-col gap-1 ${menuSurfaceClass}`}
              >
                <button
                  type="button"
                  onClick={handleConfirmDownloadRecording}
                  className="w-full h-7 flex items-center justify-between gap-1 px-2.5 rounded-xl text-xs font-bold bg-red-600 hover:bg-red-700 text-white transition-colors cursor-pointer"
                >
                  <span className="flex items-center gap-1.5">
                    <Download className="w-3.5 h-3.5 shrink-0" />
                    <span>Download</span>
                  </span>
                  <span className="font-mono tabular-nums text-[10px] opacity-90">
                    {(pendingRecording.sizeBytes / (1024 * 1024)).toFixed(2)} MB
                  </span>
                </button>

                <button
                  type="button"
                  onClick={handleCancelRecording}
                  className={`w-full h-7 flex items-center justify-between gap-1 px-2.5 rounded-xl text-xs font-bold transition-colors cursor-pointer ${
                    isFullscreen
                      ? 'text-slate-200 hover:bg-white/10'
                      : 'text-slate-700 hover:bg-slate-100'
                  }`}
                >
                  <span className="flex items-center gap-1.5">
                    <Trash2 className="w-3.5 h-3.5 shrink-0" />
                    <span>Cancel</span>
                  </span>
                  <span className="font-mono tabular-nums text-[10px] opacity-75">
                    {formatTime(pendingRecording.durationSec)}
                  </span>
                </button>
              </div>
            )}

          {/* RECORDING QUALITY MENU (Directly above Screen Recording option) */}
          {showRecordMenu && !isRecording && (
            <div
              data-player-menu="record"
              onClick={(e) => e.stopPropagation()}
              style={{ right: `${recordPopoverRightPx}px` }}
              className={`absolute bottom-full mb-1.5 w-44 rounded-2xl shadow-xl p-1.5 z-50 ${menuSurfaceClass}`}
            >
              {(['1080p', '720p', '480p', '360p', '240p', '144p'] as QualityTierId[]).map(
                (qId) => {
                  const spec = QUALITY_TIERS.find((t) => t.id === qId)!;
                  const active = recordQuality === qId;
                  return (
                    <button
                      key={qId}
                      type="button"
                      onClick={(e) => {
                        e.stopPropagation();
                        setRecordQuality(qId);
                        setShowRecordMenu(false);
                        resetFullscreenAutoHideTimer();
                      }}
                      className={`w-full h-7 flex items-center justify-between px-2.5 rounded-xl text-xs transition-colors ${
                        active
                          ? 'bg-red-600 text-white font-bold'
                          : isFullscreen
                          ? 'text-slate-200 hover:bg-white/10'
                          : 'text-slate-700 hover:bg-slate-100'
                      }`}
                    >
                      <span>{spec.shortLabel}</span>
                      <span className="font-mono tabular-nums text-[10px] opacity-80">
                        ~{spec.estMbPerHour} MB/h
                      </span>
                    </button>
                  );
                }
              )}
            </div>
          )}

          {/* VIDEO QUALITY SELECTION MENU (Exact same w-44 and 180px overall box height & layout as Screen Recording quality menu) */}
          {showQualityMenu && (
            <div
              data-player-menu="quality"
              onClick={(e) => e.stopPropagation()}
              className={`absolute bottom-full right-2.5 sm:right-4 mb-1.5 w-44 rounded-2xl shadow-xl p-1.5 z-50 ${menuSurfaceClass}`}
            >
              {QUALITY_TIERS.map((tier) => {
                const isSelected = selectedQuality === tier.id;
                return (
                  <button
                    key={tier.id}
                    type="button"
                    onClick={(e) => {
                      e.stopPropagation();
                      handleSelectQualityOption(tier.id);
                    }}
                    className={`w-full h-6 flex items-center justify-between px-2.5 rounded-xl text-xs transition-colors ${
                      isSelected
                        ? 'bg-red-600 text-white font-bold'
                        : isFullscreen
                        ? 'text-slate-200 hover:bg-white/10'
                        : 'text-slate-700 hover:bg-slate-100'
                    }`}
                  >
                    <span>{tier.shortLabel}</span>
                    <span className="font-mono tabular-nums text-[10px] opacity-80">
                      ~{tier.estMbPerHour} MB/h
                    </span>
                  </button>
                );
              })}
            </div>
          )}

          {/* SLIM YOUTUBE RED SCRUBBABLE TIMELINE BAR */}
          <div className="group relative w-full flex items-center py-1 cursor-pointer mb-1">
            <div
              className={`w-full h-1 group-hover:h-1.5 rounded-full overflow-hidden transition-all ${
                isFullscreen ? 'bg-white/25' : 'bg-slate-200'
              }`}
            >
              <div
                className="h-full bg-red-600 rounded-full transition-all duration-100"
                style={{ width: `${progressPercent}%` }}
              />
            </div>
            <div
              className="w-3 h-3 rounded-full bg-red-600 border-2 border-white absolute -translate-x-1/2 pointer-events-none transition-transform group-hover:scale-125"
              style={{ left: `${progressPercent}%` }}
            />
            <input
              type="range"
              min={seekableStart}
              max={Math.max(seekableStart + 1, seekableEnd)}
              step={0.5}
              value={clampedCurrent}
              onChange={(e) => {
                const nextVal = parseFloat(e.target.value);
                setCurrentTime(nextVal);
                if (videoRef.current) {
                  try {
                    videoRef.current.currentTime = nextVal;
                  } catch {
                    // ignore
                  }
                }
                resetFullscreenAutoHideTimer();
              }}
              aria-label="Video Timeline"
              className="absolute inset-0 w-full h-full opacity-0 cursor-pointer"
            />
          </div>

          {/* SINGLE-ROW COMPACT CONTROL BAR */}
          <div className="w-full flex flex-nowrap items-center justify-between gap-1.5 overflow-x-auto no-scrollbar">
            <div className="flex flex-nowrap items-center gap-1 sm:gap-1.5 shrink-0">
              <button
                type="button"
                onClick={togglePlay}
                title={isPlaying ? 'Pause' : 'Play'}
                className="p-1.5 rounded-lg bg-red-600 hover:bg-red-700 text-white transition-colors shrink-0"
              >
                {isPlaying ? (
                  <Pause className="w-3.5 h-3.5 fill-current" />
                ) : (
                  <Play className="w-3.5 h-3.5 fill-current" />
                )}
              </button>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  performRelativeSeek(-10, 'left');
                }}
                title="Rewind 10 seconds (or double-tap left video)"
                className={`flex items-center justify-center gap-1 px-2 py-1 rounded-lg text-[11px] sm:text-xs font-bold transition-colors whitespace-nowrap shrink-0 ${buttonSurfaceClass}`}
              >
                <Rewind className="w-3 h-3 text-red-600 fill-current" />
                <span>-10s</span>
              </button>

              <button
                type="button"
                onClick={(e) => {
                  e.stopPropagation();
                  hasTriedResolveRef.current = false;
                  setResolvedOverrideStream(null);
                  startNew15sServerWindow();
                  setPlaybackEngine(computeInitialEngine(activeStreamUrl));
                  setReloadNonce((n) => n + 1);
                  resetFullscreenAutoHideTimer();
                }}
                title="Reconnect Stream"
                className={`flex items-center justify-center gap-1 px-2 py-1 rounded-lg text-[11px] sm:text-xs font-bold transition-colors whitespace-nowrap shrink-0 ${buttonSurfaceClass}`}
              >
                <Loader2
                  className={`w-3 h-3 text-red-600 ${
                    (isBuffering || isConnectingWindow) && !errorMsg ? 'animate-spin' : ''
                  }`}
                />
                <span>Reconnect</span>
              </button>

              <div
                className={`flex items-center gap-1 px-1.5 py-0.5 rounded-lg shrink-0 ${buttonSurfaceClass}`}
              >
                <button
                  type="button"
                  onClick={(e) => {
                    e.stopPropagation();
                    setIsMuted((m) => !m);
                    resetFullscreenAutoHideTimer();
                  }}
                  title={isMuted ? 'Unmute' : 'Mute'}
                  className="p-0.5 transition-colors"
                >
                  {isMuted || volume === 0 ? (
                    <VolumeX className="w-3.5 h-3.5 text-red-600" />
                  ) : (
                    <Volume2 className="w-3.5 h-3.5" />
                  )}
                </button>
                <input
                  type="range"
                  min={0}
                  max={1}
                  step={0.05}
                  value={isMuted ? 0 : volume}
                  onChange={(e) => {
                    const v = parseFloat(e.target.value);
                    setVolume(v);
                    if (v > 0 && isMuted) setIsMuted(false);
                    resetFullscreenAutoHideTimer();
                  }}
                  aria-label="Volume"
                  className={`w-12 sm:w-16 accent-red-600 cursor-pointer h-1 rounded-lg ${
                    isFullscreen ? 'bg-white/30' : 'bg-slate-300'
                  }`}
                />
              </div>

              <button
                type="button"
                disabled={!isBehindLive}
                onClick={handleGoLive}
                title={
                  isBehindLive
                    ? 'Click to jump back to live timeline'
                    : 'Already at live broadcast edge'
                }
                className={`flex items-center justify-center gap-1 px-2.5 py-1 rounded-lg text-[11px] sm:text-xs font-bold tracking-wide transition-all whitespace-nowrap shrink-0 ${
                  isBehindLive
                    ? 'bg-red-600 hover:bg-red-700 text-white cursor-pointer shadow-xs'
                    : isFullscreen
                    ? 'bg-white/10 text-white/40 border border-white/10 cursor-not-allowed'
                    : 'bg-slate-100 text-slate-400 border border-slate-200 cursor-not-allowed'
                }`}
              >
                <span
                  className={`w-1.5 h-1.5 rounded-full ${
                    isBehindLive ? 'bg-white animate-ping' : 'bg-current opacity-60'
                  }`}
                />
                <span>Go Live</span>
              </button>
            </div>

            <div className="flex flex-nowrap items-center gap-1 sm:gap-1.5 shrink-0">
              <div
                ref={recordBtnGroupRef}
                className={`flex items-center rounded-lg shrink-0 ${buttonSurfaceClass}`}
              >
                {!isRecording ? (
                  <>
                    <button
                      type="button"
                      data-player-menu="record-confirm"
                      onClick={(e) => {
                        e.stopPropagation();
                        updateRecordPopoverPosition();
                        setShowRecordConfirmMenu((prev) => !prev);
                        setShowRecordMenu(false);
                        setShowQualityMenu(false);
                        setShowServerMenu(false);
                        resetFullscreenAutoHideTimer();
                      }}
                      className="flex items-center gap-1 pl-2 pr-1.5 py-1 text-[11px] sm:text-xs font-bold transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                    >
                      <Disc className="w-3 h-3 text-red-600" />
                      <span>Rec ({recordQuality})</span>
                    </button>
                    <button
                      type="button"
                      data-player-menu="record"
                      onClick={(e) => {
                        e.stopPropagation();
                        updateRecordPopoverPosition();
                        setShowRecordMenu((prev) => !prev);
                        setShowRecordConfirmMenu(false);
                        setShowQualityMenu(false);
                        setShowServerMenu(false);
                      }}
                      title="Recording Quality"
                      className={`pr-1.5 pl-1 py-1 border-l cursor-pointer ${
                        isFullscreen ? 'border-white/15' : 'border-slate-200'
                      }`}
                    >
                      <ChevronDown className="w-3 h-3" />
                    </button>
                  </>
                ) : (
                  <button
                    type="button"
                    onClick={stopRecording}
                    className="flex items-center gap-1 px-2.5 py-1 text-[11px] sm:text-xs font-bold bg-red-600 hover:bg-red-700 text-white rounded-lg transition-colors whitespace-nowrap shrink-0 cursor-pointer"
                  >
                    <Square className="w-2.5 h-2.5 fill-current" />
                    <span className="font-mono tabular-nums">
                      Stop ({formatTime(recordSeconds)})
                    </span>
                  </button>
                )}
              </div>

              <button
                type="button"
                data-player-menu="quality"
                onClick={(e) => {
                  e.stopPropagation();
                  setShowQualityMenu((prev) => !prev);
                  setShowServerMenu(false);
                  setShowRecordMenu(false);
                  setShowRecordConfirmMenu(false);
                }}
                title="Video Quality"
                className={`flex items-center justify-center gap-1 px-2 py-1 text-[11px] sm:text-xs font-bold rounded-lg transition-colors whitespace-nowrap shrink-0 ${buttonSurfaceClass}`}
              >
                <Settings className="w-3 h-3 text-red-600" />
                <span>{activeTierObj.shortLabel}</span>
              </button>

              <button
                type="button"
                onClick={toggleOrientationRotate}
                title={
                  isRotatedHorizontal
                    ? 'Switch to Vertical 16:9'
                    : 'Rotate to Horizontal 16:9'
                }
                className={`flex items-center justify-center gap-1 px-2 py-1 rounded-lg text-[11px] sm:text-xs font-bold transition-colors whitespace-nowrap shrink-0 ${
                  isRotatedHorizontal
                    ? 'bg-red-600 text-white border border-red-600'
                    : buttonSurfaceClass
                }`}
              >
                <ScreenRotateIcon
                  className={`w-3 h-3 transition-transform ${
                    isRotatedHorizontal ? 'rotate-90' : ''
                  }`}
                />
                <span>{isRotatedHorizontal ? 'Vertical' : 'Horizontal'}</span>
              </button>

              <button
                type="button"
                onClick={handleToggleFullscreen}
                title={isFullscreen ? 'Exit Fullscreen' : 'Fullscreen'}
                className="flex items-center justify-center gap-1 px-2 py-1 rounded-lg bg-red-600 hover:bg-red-700 text-white text-[11px] sm:text-xs font-bold transition-colors shrink-0"
              >
                {isFullscreen ? (
                  <Minimize className="w-3.5 h-3.5" />
                ) : (
                  <Maximize className="w-3.5 h-3.5" />
                )}
              </button>
            </div>
          </div>
        </div>
      </div>
    </div>
  );
};

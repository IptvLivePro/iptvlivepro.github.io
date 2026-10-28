export type QualityTierId =
  | 'auto'
  | '1080p'
  | '720p'
  | '480p'
  | '360p'
  | '240p'
  | '144p';

export interface QualityTierOption {
  id: QualityTierId;
  label: string;
  shortLabel: string;
  height: number;
  targetKbps: number;
  estMbPerHour: number;
}

export const QUALITY_TIERS: QualityTierOption[] = [
  {
    id: 'auto',
    label: 'Auto',
    shortLabel: 'Auto',
    height: 0,
    targetKbps: 2000,
    estMbPerHour: 900,
  },
  {
    id: '1080p',
    label: '1080p',
    shortLabel: '1080p',
    height: 1080,
    targetKbps: 3500,
    estMbPerHour: 1575,
  },
  {
    id: '720p',
    label: '720p',
    shortLabel: '720p',
    height: 720,
    targetKbps: 1800,
    estMbPerHour: 810,
  },
  {
    id: '480p',
    label: '480p',
    shortLabel: '480p',
    height: 480,
    targetKbps: 900,
    estMbPerHour: 405,
  },
  {
    id: '360p',
    label: '360p',
    shortLabel: '360p',
    height: 360,
    targetKbps: 500,
    estMbPerHour: 225,
  },
  {
    id: '240p',
    label: '240p',
    shortLabel: '240p',
    height: 240,
    targetKbps: 240,
    estMbPerHour: 108,
  },
  {
    id: '144p',
    label: '144p',
    shortLabel: '144p',
    height: 144,
    targetKbps: 115,
    estMbPerHour: 52,
  },
];

export interface StreamLink {
  url: string;
  quality: string;
  httpReferrer?: string;
  userAgent?: string;
  title?: string;
  isGeoBlocked?: boolean;
}

export interface UnifiedChannel {
  id: string;
  name: string;
  country: string;
  countryName?: string;
  categories: string[];
  languages?: string[];
  logo: string;
  logos?: string[];
  streams: StreamLink[];
}

export interface PlaylistSource {
  id: string;
  name: string;
  url: string;
  isBuiltIn: boolean;
}

export const BUILT_IN_SOURCES: PlaylistSource[] = [
  {
    id: 'iptv-org-directory',
    name: 'Official IPTV-Org Master Library (index.m3u)',
    url: 'https://iptv-org.github.io/iptv/index.m3u',
    isBuiltIn: true,
  },
];

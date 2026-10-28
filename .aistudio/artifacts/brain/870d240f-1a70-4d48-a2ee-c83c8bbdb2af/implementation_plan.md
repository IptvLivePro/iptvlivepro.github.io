# Complete Channel & Stream URL Reset, Favorites Top-Right Card Layout & Removal of Play Stream URL

A comprehensive update to completely remove the "Play Stream URL" feature, reposition the "Favorites" button to the top-right of every channel card, purge all cached/filtered states, and freshly load all channels, logos, and stream URLs directly from `https://iptv-org.github.io/iptv/index.m3u` and `https://iptv-org.github.io/`.

## User Review & Critical Decisions

> [!IMPORTANT]
> 1. **Complete Removal of "Play Stream URL"**: The "Play Stream URL" button in the top navigation bar and its modal (`StreamModal`) will be completely removed.
> 2. **Favorites Button at Top-Right of Channel Cards**: Every channel card will position the "Favorites" star button cleanly at the top-right corner of the card.
> 3. **Full Cache Reset & Unfiltered Official Streams**: All server-side and client-side caches, health-check filters, and dead-stream exclusions are completely removed and reset. Every channel and its logo are loaded from `https://iptv-org.github.io/iptv/index.m3u` (and official IPTV-Org metadata), and **all** stream URLs from `https://iptv-org.github.io/` (`index.m3u` + `api/streams.json`) are attached to their respective channels without stripping or hiding any URLs.

- **Confirmed Decision 1**: Remove the "Play Stream URL" button and modal completely from the interface.
- **Confirmed Decision 2**: Place the "Favorites" star button at the top-right corner of each channel card.
- **Confirmed Decision 3**: Purge all stale caches and remove background stream pruning so 100% of official stream URLs from `https://iptv-org.github.io/` and channel logos/list from `https://iptv-org.github.io/iptv/index.m3u` are always available on every channel.

---

### 1. Overview & Core Concept

- **What It Does**:
  - Delivers a clean, focused live TV application without the "Play Stream URL" button or modal.
  - Resets all channel data and stream URLs so there is zero stale cache pollution.
  - Builds the channel list and logos directly from `https://iptv-org.github.io/iptv/index.m3u` and attaches every available stream URL from `https://iptv-org.github.io/` (`index.m3u` and `api/streams.json`).
  - Positions the Favorites star button at the top-right of each channel card for quick, intuitive bookmarking.
- **Key Value**: 100% authentic, unfiltered channel and stream availability from IPTV-Org with a clean card layout and zero cached stream loss.

---

### 2. User Experience & Visual Design

- **Header Bar (`App.tsx`)**:
  - Displays the brand logo (`StreamPulse`) and category navigation links (`All Channels`, `Favorites`, `News`, `Sports`) without the "Play Stream URL" button.
- **Channel Card Layout (`App.tsx`)**:
  - **Left**: Official channel logo box (`tvg-logo` from `index.m3u` + official logo fallbacks) alongside the channel title, country, category, and language metadata.
  - **Top-Right**: Dedicated **Favorites** star button positioned at the top-right of the card (`top-2.5 right-2.5`), allowing one-tap favoriting.
  - **Bottom-Right / Action Area**: Clean **Watch Live** / **Playing** button with the multi-server selector dropdown (`Server 1`, `Server 2`, etc.) listing all official stream URLs for that channel.
- **Complete Stream & Channel Reset (`server.ts` & `iptvCatalogClient.ts`)**:
  - Removes `streamVerifyStatus` dead-stream filtering that previously hid channels or stripped stream URLs.
  - Clears any stale client `localStorage` custom playlist keys.
  - Parses `https://iptv-org.github.io/iptv/index.m3u` and `https://iptv-org.github.io/api/streams.json` fresh, matching channels by ID, base ID (before `@`), and normalized channel name so every channel receives all of its official stream URLs.

---

### 3. Key Product Decisions & Trade-Offs

- **Decision 1: Never Strip or Hide Official Stream URLs**:
  - *Chosen Approach*: Remove server-side `streamVerifyStatus === 'dead'` pruning from `/api/iptv-org/catalog`. All official streams from `index.m3u` and `streams.json` are preserved and presented in the channel's server list.
  - *Why*: Server-side datacenter IP probes often get blocked by geo-fenced or residential-only broadcasters, which falsely marked working streams as dead and hid them from the user. Keeping all official streams ensures the browser's multi-engine player (`proxy-hls` -> `direct-hls` -> `mpegts` -> `transcode`) can play them.
- **Decision 2: Top-Right Favorites Button on Cards**:
  - *Chosen Approach*: Anchor the star button at the top-right corner of each channel card while keeping the "Watch Live + Server Selector" action cleanly aligned below/beside it without overlapping text.
  - *Why*: Matches the user's exact layout preference and makes favoriting immediately accessible on both mobile and desktop viewports.

---

### 4. Technical Architecture & Data Strategy

```
┌─────────────────────────────────────────────────────────────┐
│             Official IPTV-Org Fresh Data Pipeline           │
│                                                             │
│  1. https://iptv-org.github.io/iptv/index.m3u               │
│     └── Channel List, Names, Categories & tvg-logo          │
│     └── Master Playlist Stream URLs                         │
│                                                             │
│  2. https://iptv-org.github.io/api/streams.json             │
│     └── All Additional Official Stream URLs per Channel     │
│                                                             │
│  3. https://iptv-org.github.io/api/logos.json & channels    │
│     └── Supplemental Logos & Country/Language Metadata      │
└──────────────────────────────┬──────────────────────────────┘
                               │
         Zero Cache Pruning • All Stream URLs Preserved
                               │
                               ▼
┌─────────────────────────────────────────────────────────────┐
│                     Channel Card UI                         │
│ ┌────────┐  Channel Name                      [★ Favorites] │
│ │  LOGO  │  Country · Category · Language     (Top-Right)   │
│ └────────┘                               [▶ Watch Live | ▾] │
└─────────────────────────────────────────────────────────────┘
```

- **Interactive State & Component Mapping**:
  - `App.tsx`:
    - Remove `isModalOpen`, `StreamModal`, `handlePlayDirectStream`, and `handleAddPlaylistUrl`.
    - Purge old `localStorage` custom source keys on mount.
    - Update channel card JSX to place the Favorites `<Star />` button at the top-right corner.
  - `server.ts` & `src/utils/iptvCatalogClient.ts`:
    - Reset catalog state and rebuild `syncOfficialIptvOrgCatalog` and `getOfficialIptvOrgCatalogClient` so `https://iptv-org.github.io/iptv/index.m3u` and `https://iptv-org.github.io/api/streams.json` populate all channels, logos, and all stream URLs without any dead-stream filtering.

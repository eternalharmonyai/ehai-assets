# ehai-assets

Reusable, self-contained web components built by [Eternal Harmony AI](https://eternalharmony.ai). Free to use in any project.

## Shells (Frontend)

Each shell is a single `.html` file with all CSS and JavaScript inline. No build step, no dependencies (except optional Google Fonts).

| Shell | Description |
|-------|-------------|
| [stats-dashboard.html](shells/stats-dashboard.html) | Analytics dashboard with KPIs, Smart Insights, date range picker, export, light/dark theme |
| [video-player.html](shells/video-player.html) | Chapter-based video player with sidebar, theater mode, auto-advance, share links |

## Workers (Backend)

| Worker | Description |
|--------|-------------|
| [stats-tracker](workers/stats-tracker/) | Cloudflare Worker for event tracking, stats API, smart insights, auth, and contact form. Uses D1 + KV. |

## Scripts

| Script | Description |
|--------|-------------|
| [brand-assets.py](scripts/brand-assets.py) | Python script that generates favicons (5 sizes), multi-res .ico, and OG social banner from a single logo image. Requires Pillow. |

## Snippets

| Snippet | Description |
|---------|-------------|
| [theme-toggle.html](snippets/theme-toggle.html) | Animated sun/moon light-dark toggle. Drop-in CSS + HTML + JS with localStorage persistence. |

## Usage

1. Copy the file(s) into your project
2. Search for `🔧 PLACEHOLDER` and replace with your content
3. Done!

## License

Free to use, modify, and distribute. Attribution appreciated but not required.

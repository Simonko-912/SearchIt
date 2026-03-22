# ScrapeIt Search

A self-hosted search engine that crawls websites you add and indexes them for search.

## Features

- **Web search** — full-text search across indexed pages
- **Image search** — search images by alt text / description
- **Background crawler** — recursively discovers and crawls linked pages
- **Light / dark mode**
- **No external APIs** — fully self-contained

---

## Setup

### Requirements

- [Node.js](https://nodejs.org) v18 or newer

### Install

```bash
# 1. Navigate to the project folder
cd scrapeit

# 2. Install dependencies
cd backend && npm install
```

### Run

```bash
# From the scrapeit/ root:
npm start

# Or with auto-restart on changes:
npm run dev
```

Open **http://localhost:3001** in your browser.

---

## Usage

1. Click **Add Site** in the header.
2. Enter any URL (e.g. `https://example.com`) and click **Add & Crawl**.
3. ScrapeIt will:
   - Fetch and index the page (title, description, favicon, keywords, og:image)
   - Extract all images and add them to the image index
   - Find all links on the page and queue them for crawling
   - Repeat for every discovered link, up to depth 5
4. Use the **Search** tab to search indexed pages.
5. Use the **Images** tab to search indexed images.
6. Check **Stats** for crawl progress and totals.
7. Click the **Crawling** button in the header to pause/resume the crawler.

---

## Architecture

```
scrapeit/
├── backend/
│   ├── server.js    — Express API server
│   ├── db.js        — SQLite database setup
│   ├── crawler.js   — Background crawl engine (concurrent, depth-limited)
│   ├── scraper.js   — Page fetch + HTML parsing
│   └── data/        — SQLite database file (auto-created)
└── frontend/
    └── public/
        ├── index.html
        ├── css/style.css
        └── js/app.js
```

## API Endpoints

| Method | Path | Description |
|--------|------|-------------|
| GET | /api/stats | Crawler stats and recent activity |
| GET | /api/search?q= | Web search |
| GET | /api/search/images?q= | Image search |
| GET | /api/sites | List all sites (with pagination & filter) |
| POST | /api/sites | Add a new seed URL |
| DELETE | /api/sites/:id | Delete a site |
| POST | /api/sites/:id/recrawl | Re-queue a site for crawling |
| GET | /api/crawler/status | Crawler status |
| POST | /api/crawler/pause | Pause crawler |
| POST | /api/crawler/resume | Resume crawler |

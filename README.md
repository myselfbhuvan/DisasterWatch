# DisasterWatch v3 — multi-source disaster dashboard

## What's included
- `backend/server.js`: resilient Express API integrating USGS earthquakes, GDACS alerts, and NASA EONET natural-event metadata.
- `frontend/src/App.jsx`: multi-disaster dashboard with map, type/severity/source filters, search, incident detail popups, auto-refresh, severity analytics, and source health.
- `frontend/src/App.css`: dashboard styling.

## Install / apply
1. Back up the current files.
2. Copy `backend/server.js` into `~/DisasterWatch/backend/server.js`.
3. Copy `frontend/src/App.jsx` into `~/DisasterWatch/frontend/src/App.jsx`.
4. Copy `frontend/src/App.css` into `~/DisasterWatch/frontend/src/App.css`.

## Run
Backend terminal:
```bash
cd ~/DisasterWatch/backend
npm install express axios cors
node server.js
```
Frontend terminal:
```bash
cd ~/DisasterWatch/frontend
npm run dev
```
Open the URL printed by Vite (previously `http://localhost:5174`).

## Verify
```bash
curl -s http://localhost:5000/api/health
curl -s http://localhost:5000/api/disasters | python3 -c "import sys,json; d=json.load(sys.stdin); print('Total:', d['count']); print('Sources:', {k:(v['status'],v['count']) for k,v in d['sources'].items()}); print('Types:', sorted({x['type'] for x in d['disasters']}))"
curl -s http://localhost:5000/api/nasa-eonet | python3 -c "import sys,json; d=json.load(sys.stdin); print('NASA EONET status:',d['status']); print('Events:',d['count'])"
```

## Notes
- Feeds are polled by the frontend every 60 seconds. The backend caches successful upstream responses for 60 seconds.
- NASA EONET is a curated, near-real-time natural-event metadata feed; it is not a universal feed for every flood, storm, or disaster. Data source coverage and publication latency vary.
- Severity is source-derived/normalized and is not a single cross-hazard risk score. NASA EONET events are shown as `unknown` severity unless the source provides a compatible measure.
- Same physical incident can appear in multiple providers; this implementation preserves provider records rather than guessing at cross-provider deduplication.
- The API reports upstream health and can serve cached data if a provider temporarily fails.

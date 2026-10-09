import { useCallback, useEffect, useMemo, useRef, useState } from "react";
import * as maplibregl from "maplibre-gl";
import "maplibre-gl/dist/maplibre-gl.css";
import "./App.css";


const API_URL = import.meta.env.VITE_API_URL || "http://localhost:5000";
const REFRESH_MS = 60_000;

const TYPES = [
  ["all", "All events"],
  ["earthquake", "Earthquakes"],
  ["cyclone", "Cyclones / storms"],
  ["flood", "Floods"],
  ["wildfire", "Wildfires"],
  ["volcano", "Volcanoes"],
  ["tsunami", "Tsunamis"],
  ["landslide", "Landslides"],
  ["drought", "Drought"],
  ["dust", "Dust / haze"],
  ["ice", "Ice"],
  ["snow", "Snow"],
  ["marine", "Marine"],
  ["other", "Other"]
];

const SEVERITIES = ["all", "major", "strong", "moderate", "minor", "unknown"];
const SEVERITY_COLORS = {
  major: "#ff4d5e",
  strong: "#ff842e",
  moderate: "#f4c542",
  minor: "#20c878",
  unknown: "#8c9aaf"
};
const TYPE_COLORS = {
  earthquake: "#ff5864",
  cyclone: "#a78bfa",
  flood: "#38bdf8",
  wildfire: "#fb923c",
  volcano: "#f97316",
  tsunami: "#22d3ee",
  landslide: "#c084fc",
  drought: "#eab308",
  dust: "#cbd5e1",
  ice: "#67e8f9",
  snow: "#e2e8f0",
  marine: "#2dd4bf",
  other: "#94a3b8"
};

function safeDate(value) {
  if (value === null || value === undefined || value === "") return null;
  const date = typeof value === "number" ? new Date(value) : new Date(value);
  return Number.isNaN(date.getTime()) ? null : date;
}

function formatDate(value) {
  const date = safeDate(value);
  return date ? date.toLocaleString([], { dateStyle: "medium", timeStyle: "short" }) : "Time not provided";
}

function eventLabel(event) {
  if (event.type === "earthquake" && event.magnitude !== null && event.magnitude !== undefined) {
    return `M${Number(event.magnitude).toFixed(1)}`;
  }
  if (event.severityValue !== null && event.severityValue !== undefined && event.severityUnit) {
    return `${Number(event.severityValue).toFixed(1)} ${event.severityUnit}`;
  }
  return event.type.replaceAll("-", " ");
}

function severityLabel(value) {
  return String(value || "unknown").replaceAll("-", " ").toUpperCase();
}

function getEventDate(event) {
  return safeDate(event.timestamp ?? event.updated);
}

function toFeatureCollection(events) {
  return {
    type: "FeatureCollection",
    features: events
      .filter(event => Number.isFinite(Number(event.longitude)) && Number.isFinite(Number(event.latitude)))
      .filter(event => Math.abs(Number(event.latitude)) <= 90 && Math.abs(Number(event.longitude)) <= 180)
      .map(event => ({
        type: "Feature",
        geometry: { type: "Point", coordinates: [Number(event.longitude), Number(event.latitude)] },
        properties: {
          id: event.id,
          title: event.title || "Unnamed event",
          location: event.location || event.country || event.title || "Location not provided",
          source: event.source || "Unknown source",
          type: event.type || "other",
          severity: event.severity || "unknown",
          magnitude: event.magnitude === null || event.magnitude === undefined ? -1 : Number(event.magnitude),
          label: eventLabel(event),
          description: event.description || "",
          searchText: [event.title, event.description, event.location, event.country, event.source, event.type].filter(Boolean).join(" ").toLowerCase(),
          country: event.country || "",
          updated: event.updated || "",
          detailsUrl: event.detailsUrl || ""
        }
      }))
  };
}

function escapeHtml(value) {
  return String(value ?? "")
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function popupHtml(event) {
  const url = event.detailsUrl && /^https?:\/\//i.test(event.detailsUrl) ? event.detailsUrl : "";
  const magnitudeText = event.magnitude !== null && event.magnitude !== undefined
    ? `Magnitude: ${Number(event.magnitude).toFixed(1)}`
    : (event.severityText || "Measurement not supplied");
  return `
    <div class="map-popup">
      <div class="popup-kicker">${escapeHtml(event.source)} · ${escapeHtml(event.type)}</div>
      <h3>${escapeHtml(event.title || "Unnamed event")}</h3>
      <p>${escapeHtml(event.location || event.country || "Location not provided")}</p>
      <div class="popup-grid">
        <span>Severity</span><strong>${escapeHtml(severityLabel(event.severity))}</strong>
        <span>Measurement</span><strong>${escapeHtml(magnitudeText)}</strong>
        <span>Updated</span><strong>${escapeHtml(formatDate(event.timestamp ?? event.updated))}</strong>
      </div>
      ${url ? `<a href="${escapeHtml(url)}" target="_blank" rel="noopener noreferrer">Open source report ↗</a>` : ""}
    </div>`;
}

function StatCard({ label, value, detail, accent = "blue" }) {
  return <article className={`stat-card accent-${accent}`}>
    <div className="stat-label">{label}</div>
    <div className="stat-value">{value}</div>
    <div className="stat-description">{detail}</div>
  </article>;
}

function App() {
  const [events, setEvents] = useState([]);
  const [sourceStatus, setSourceStatus] = useState({});
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState("");
  const [lastUpdated, setLastUpdated] = useState(null);
  const [typeFilter, setTypeFilter] = useState("all");
  const [severityFilter, setSeverityFilter] = useState("all");
  const [sourceFilter, setSourceFilter] = useState("all");
  const [search, setSearch] = useState("");
  const [selectedId, setSelectedId] = useState(null);
  const mapContainerRef = useRef(null);
  const mapRef = useRef(null);
  const mapReadyRef = useRef(false);
  const eventsRef = useRef([]);

  const fetchEvents = useCallback(async (quiet = false) => {
    try {
      if (!quiet) setLoading(true);
      const response = await fetch(`${API_URL}/api/disasters`, { headers: { Accept: "application/json" } });
      const payload = await response.json();
      if (!response.ok && !Array.isArray(payload.disasters)) {
        throw new Error(payload.message || `API returned HTTP ${response.status}`);
      }
      if (!Array.isArray(payload.disasters)) throw new Error("The API response did not contain a disasters array.");
      setEvents(payload.disasters);
      setSourceStatus(payload.sources || {});
      setLastUpdated(payload.updated || new Date().toISOString());
      setError(payload.status === "error" ? "All configured data sources are currently unavailable." : "");
    } catch (err) {
      console.error("DisasterWatch refresh failed:", err);
      setError(`Unable to refresh disaster feeds. ${err.message || "Check that the backend is running."}`);
    } finally {
      setLoading(false);
    }
  }, []);

  useEffect(() => {
    fetchEvents();
    const timer = setInterval(() => fetchEvents(true), REFRESH_MS);
    return () => clearInterval(timer);
  }, [fetchEvents]);

  const filteredEvents = useMemo(() => {
    const term = search.trim().toLowerCase();
    return events.filter(event => {
      if (typeFilter !== "all" && event.type !== typeFilter) return false;
      if (severityFilter !== "all" && (event.severity || "unknown") !== severityFilter) return false;
      if (sourceFilter !== "all" && event.source !== sourceFilter) return false;
      if (term) {
        const haystack = [event.title, event.description, event.location, event.country, event.source, event.type]
          .filter(Boolean).join(" ").toLowerCase();
        if (!haystack.includes(term)) return false;
      }
      return true;
    });
  }, [events, typeFilter, severityFilter, sourceFilter, search]);

  const latestEvent = useMemo(() => {
    return [...events].sort((a, b) => (getEventDate(b)?.getTime() || 0) - (getEventDate(a)?.getTime() || 0))[0] || null;
  }, [events]);

  const criticalCount = events.filter(event => event.severity === "major").length;
  const representedSources = [...new Set(events.map(event => event.source).filter(Boolean))];
  const typeCount = new Set(events.map(event => event.type)).size;
  const severityCounts = SEVERITIES.filter(item => item !== "all").map(severity => ({
    severity,
    count: events.filter(event => (event.severity || "unknown") === severity).length
  }));

  useEffect(() => {
    if (!mapContainerRef.current || mapRef.current) return;
    const map = new maplibregl.Map({
      container: mapContainerRef.current,
      style: "https://tiles.openfreemap.org/styles/liberty",
      center: [0, 18],
      zoom: 1.25,
      minZoom: 1,
      maxZoom: 18,
      attributionControl: false
    });
    mapRef.current = map;
    map.addControl(new maplibregl.NavigationControl({ visualizePitch: true }), "top-right");
    map.addControl(new maplibregl.AttributionControl({ compact: true }), "bottom-right");

    map.on("load", () => {
      mapReadyRef.current = true;
      map.addSource("disasters", { type: "geojson", data: toFeatureCollection(eventsRef.current) });
      map.addLayer({
        id: "disaster-glow",
        type: "circle",
        source: "disasters",
        paint: {
          "circle-radius": ["match", ["get", "severity"], "major", 17, "strong", 14, "moderate", 11, "minor", 8, 7],
          "circle-color": ["match", ["get", "severity"], "major", SEVERITY_COLORS.major, "strong", SEVERITY_COLORS.strong, "moderate", SEVERITY_COLORS.moderate, "minor", SEVERITY_COLORS.minor, SEVERITY_COLORS.unknown],
          "circle-opacity": 0.17,
          "circle-blur": 0.8
        }
      });
      map.addLayer({
        id: "disaster-points",
        type: "circle",
        source: "disasters",
        paint: {
          "circle-radius": ["match", ["get", "severity"], "major", 7, "strong", 6, "moderate", 5, "minor", 4, 4],
          "circle-color": ["match", ["get", "severity"], "major", SEVERITY_COLORS.major, "strong", SEVERITY_COLORS.strong, "moderate", SEVERITY_COLORS.moderate, "minor", SEVERITY_COLORS.minor, SEVERITY_COLORS.unknown],
          "circle-stroke-color": "#f8fafc",
          "circle-stroke-width": 1.1,
          "circle-opacity": 0.94
        }
      });
      map.on("mouseenter", "disaster-points", () => { map.getCanvas().style.cursor = "pointer"; });
      map.on("mouseleave", "disaster-points", () => { map.getCanvas().style.cursor = ""; });
      map.on("click", "disaster-points", e => {
        const feature = e.features?.[0];
        if (!feature) return;
        const event = eventsRef.current.find(item => item.id === feature.properties.id);
        if (!event) return;
        setSelectedId(event.id);
        new maplibregl.Popup({ offset: 12, maxWidth: "320px" })
          .setLngLat(feature.geometry.coordinates)
          .setHTML(popupHtml(event))
          .addTo(map);
      });
    });

    return () => {
      mapReadyRef.current = false;
      map.remove();
      mapRef.current = null;
    };
  }, []);

  useEffect(() => {
    eventsRef.current = events;
    if (!mapRef.current || !mapReadyRef.current) return;
    const source = mapRef.current.getSource("disasters");
    if (source) source.setData(toFeatureCollection(events));
  }, [events]);

  useEffect(() => {
    const map = mapRef.current;
    if (!map || !mapReadyRef.current) return;
    const typeFilterExpr = typeFilter === "all" ? null : ["==", ["get", "type"], typeFilter];
    const severityFilterExpr = severityFilter === "all" ? null : ["==", ["get", "severity"], severityFilter];
    const sourceFilterExpr = sourceFilter === "all" ? null : ["==", ["get", "source"], sourceFilter];
    const term = search.trim().toLowerCase();
    const searchFilterExpr = term ? [">=", ["index-of", term, ["get", "searchText"]], 0] : null;
    const expressions = [typeFilterExpr, severityFilterExpr, sourceFilterExpr, searchFilterExpr].filter(Boolean);
    const combined = expressions.length ? ["all", ...expressions] : null;
    map.setFilter("disaster-points", combined);
    map.setFilter("disaster-glow", combined);
  }, [typeFilter, severityFilter, sourceFilter, search]);

  const resetFilters = () => {
    setTypeFilter("all");
    setSeverityFilter("all");
    setSourceFilter("all");
    setSearch("");
    setSelectedId(null);
  };

  const sourceEntries = Object.entries(sourceStatus);
  const onlineCount = sourceEntries.filter(([, value]) => value.status === "online" || value.status === "stale").length;

  return <div className="app-shell">
    <header className="topbar">
      <div className="brand">
        <div className="brand-mark">DW</div>
        <div><strong>DisasterWatch</strong><span>REAL-TIME DISASTER INTELLIGENCE</span></div>
      </div>
      <div className={`live-pill ${onlineCount === 0 && sourceEntries.length ? "offline" : ""}`}>
        <i /> {loading ? "CONNECTING" : onlineCount ? "LIVE DATA" : "DATA OFFLINE"}
      </div>
    </header>

    <main className="dashboard">
      <section className="hero">
        <div className="eyebrow">GLOBAL HAZARD MONITORING</div>
        <h1>Global Disaster Intelligence</h1>
        <p>Verified event feeds from USGS, GDACS and NASA EONET. Updates are polled periodically; source reporting delays vary.</p>
        <div className="hero-meta">
          <span>{lastUpdated ? `Last updated ${formatDate(lastUpdated)}` : "Waiting for first update"}</span>
          <button className="refresh-button" onClick={() => fetchEvents()} disabled={loading}>↻ Refresh now</button>
        </div>
      </section>

      {error && <div className="error-banner" role="alert"><strong>Feed warning:</strong> {error}</div>}

      <section className="stats-grid">
        <StatCard label="TOTAL EVENTS" value={loading && !events.length ? "—" : events.length.toLocaleString()} detail="Events returned by configured feeds" />
        <StatCard label="MAJOR ALERTS" value={criticalCount.toLocaleString()} detail="Events marked major by source/severity mapping" accent="red" />
        <StatCard label="DISASTER TYPES" value={typeCount.toLocaleString()} detail="Types represented in current feed" accent="purple" />
        <StatCard label="DATA SOURCES" value={representedSources.length.toLocaleString()} detail={representedSources.join(" · ") || "Waiting for feeds"} accent="green" />
      </section>

      <section className="filter-panel">
        <div className="panel-heading">
          <div><h2>Filter events</h2><p>Filters apply to the incident list and map markers.</p></div>
          <button className="text-button" onClick={resetFilters}>Reset filters</button>
        </div>
        <label className="search-field"><span>⌕</span><input value={search} onChange={e => setSearch(e.target.value)} placeholder="Search event, country, type or source…" /></label>
        <div className="filter-row">
          <span className="filter-label">DISASTER TYPE</span>
          <div className="chip-list">
            {TYPES.map(([value, label]) => <button key={value} className={`filter-chip ${typeFilter === value ? "active" : ""}`} onClick={() => setTypeFilter(value)}>{label}</button>)}
          </div>
        </div>
        <div className="filter-row">
          <span className="filter-label">SEVERITY</span>
          <div className="chip-list">
            {SEVERITIES.map(value => <button key={value} className={`filter-chip ${severityFilter === value ? "active" : ""}`} onClick={() => setSeverityFilter(value)}>
              {value !== "all" && <i className="severity-dot" style={{ background: SEVERITY_COLORS[value] }} />}{value === "all" ? "All severities" : severityLabel(value)}
            </button>)}
          </div>
        </div>
        <div className="filter-row">
          <span className="filter-label">SOURCE</span>
          <div className="chip-list">
            {["all", ...representedSources].map(value => <button key={value} className={`filter-chip ${sourceFilter === value ? "active" : ""}`} onClick={() => setSourceFilter(value)}>{value === "all" ? "All sources" : value}</button>)}
          </div>
        </div>
      </section>

      <section className="content-grid">
        <article className="panel map-panel">
          <div className="panel-heading map-heading">
            <div><h2>Global incident map</h2><p>Click a marker for event details</p></div>
            <span className="count-badge">{filteredEvents.filter(e => Number.isFinite(Number(e.longitude)) && Number.isFinite(Number(e.latitude))).length} mapped</span>
          </div>
          <div className="map-wrap"><div ref={mapContainerRef} className="map-container" /></div>
          <div className="map-legend">
            {Object.entries(SEVERITY_COLORS).map(([key, color]) => <span key={key}><i style={{ background: color }} />{severityLabel(key)}</span>)}
          </div>
          <div className="type-legend">
            {Object.entries(TYPE_COLORS).filter(([type]) => type !== "other").slice(0, 8).map(([type, color]) => <span key={type}><i style={{ background: color }} />{type}</span>)}
            <small>Marker colors indicate source severity; type filters control visibility.</small>
          </div>
        </article>

        <aside className="panel incident-panel">
          <div className="panel-heading">
            <div><h2>Recent incidents</h2><p>Sorted by event timestamp where available</p></div>
            <span className="count-badge">{filteredEvents.length}</span>
          </div>
          <div className="incident-list">
            {filteredEvents.length === 0 && <div className="empty-state">{loading ? "Loading real event feeds…" : "No events match these filters."}</div>}
            {filteredEvents.slice(0, 100).map(event => <button key={event.id} className={`incident-card ${selectedId === event.id ? "selected" : ""}`} onClick={() => {
              setSelectedId(event.id);
              const map = mapRef.current;
              if (map && Number.isFinite(Number(event.longitude)) && Number.isFinite(Number(event.latitude))) {
                map.flyTo({ center: [Number(event.longitude), Number(event.latitude)], zoom: Math.max(map.getZoom(), 3.5), speed: 0.8 });
              }
            }}>
              <div className="incident-card-top">
                <span className="event-label">{eventLabel(event)}</span>
                <span className={`severity-badge sev-${event.severity || "unknown"}`}>{severityLabel(event.severity)}</span>
              </div>
              <strong className="incident-title">{event.title || "Unnamed event"}</strong>
              <span className="incident-location">{event.location || event.country || "Location not provided"}</span>
              <span className="incident-meta">{event.source || "Unknown source"} · {event.type || "other"} · {formatDate(event.timestamp ?? event.updated)}</span>
              {event.detailsUrl && /^https?:\/\//i.test(event.detailsUrl) && <span className="incident-link">View source report ↗</span>}
            </button>)}
          </div>
        </aside>
      </section>

      <section className="panel analytics-panel">
        <div className="panel-heading"><div><h2>Severity distribution</h2><p>Counts reflect normalized source severity, not a universal risk score.</p></div></div>
        <div className="severity-bars">
          {severityCounts.map(item => <div className="severity-stat" key={item.severity}>
            <div className="severity-stat-top"><i style={{ background: SEVERITY_COLORS[item.severity] }} /><span>{severityLabel(item.severity)}</span><strong>{item.count}</strong></div>
            <div className="bar-track"><div style={{ width: `${events.length ? item.count / events.length * 100 : 0}%`, background: SEVERITY_COLORS[item.severity] }} /></div>
          </div>)}
        </div>
      </section>

      <section className="panel sources-panel">
        <div className="panel-heading"><div><h2>Data source health</h2><p>Availability of configured upstream providers</p></div><span className="count-badge">{onlineCount}/3 available</span></div>
        <div className="source-grid">
          {["USGS", "GDACS", "NASA EONET"].map(name => {
            const status = sourceStatus[name] || { status: "checking", count: 0 };
            return <div className="source-card" key={name}>
              <div className="source-card-top"><strong>{name}</strong><span className={`source-status status-${status.status}`}>{status.status}</span></div>
              <div className="source-count">{status.count ?? 0} events</div>
              <p>{status.error ? `Provider issue: ${status.error}` : status.cached ? "Using cached upstream response" : "Live upstream response"}</p>
            </div>;
          })}
        </div>
      </section>

      <footer className="footer">
        <span><strong>DisasterWatch</strong> · Multi-source disaster intelligence</span>
        <span>Sources: USGS · GDACS · NASA EONET</span>
      </footer>
    </main>
  </div>;
}

export default App;

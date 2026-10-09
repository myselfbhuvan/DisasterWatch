const dns = require("dns");
dns.setDefaultResultOrder("ipv4first");

const https = require("https");
const express = require("express");
const axios = require("axios");
const cors = require("cors");

const app = express();

const PORT = Number(process.env.PORT || 5000);
const CACHE_TTL_MS = Number(process.env.CACHE_TTL_MS || 60_000);
const REQUEST_TIMEOUT_MS = Number(process.env.REQUEST_TIMEOUT_MS || 20_000);

app.use(cors());
app.use(express.json({ limit: "1mb" }));

const cache = new Map();

const SOURCES = {
  USGS:
    "https://earthquake.usgs.gov/earthquakes/feed/v1.0/summary/all_day.geojson",

  GDACS:
    "https://www.gdacs.org/gdacsapi/api/Events/geteventlist/EVENTS4APP",

  NASA_EONET:
    "https://eonet.gsfc.nasa.gov/api/v3/events?status=open&limit=500"
};


/*
 * NASA EONET
 *
 * Node.js HTTPS requests to the NASA hostname are failing in the
 * Docker environment, while direct IPv4 + Host + SNI works.
 *
 * Therefore:
 * 1. Resolve NASA hostname to IPv4.
 * 2. Connect to the IPv4 address.
 * 3. Preserve the NASA Host header.
 * 4. Preserve TLS SNI using servername.
 */
function fetchNASA() {
  return new Promise((resolve, reject) => {
    dns.lookup(
      "eonet.gsfc.nasa.gov",
      { family: 4 },
      (dnsError, address) => {
        if (dnsError) {
          reject(dnsError);
          return;
        }

        const options = {
          hostname: address,
          port: 443,
          path: "/api/v3/events?status=open&limit=500",
          method: "GET",

          headers: {
            Host: "eonet.gsfc.nasa.gov",
            Accept: "application/json",
            "User-Agent": "DisasterWatch/1.0"
          },

          servername: "eonet.gsfc.nasa.gov"
        };

        const request = https.request(options, (response) => {
          let body = "";

          response.on("data", (chunk) => {
            body += chunk;
          });

          response.on("end", () => {
            if (
              response.statusCode < 200 ||
              response.statusCode >= 300
            ) {
              reject(
                new Error(
                  `NASA EONET HTTP ${response.statusCode}`
                )
              );
              return;
            }

            try {
              resolve(JSON.parse(body));
            } catch (error) {
              reject(error);
            }
          });
        });

        request.setTimeout(REQUEST_TIMEOUT_MS, () => {
          request.destroy(
            new Error("NASA EONET request timeout")
          );
        });

        request.on("error", reject);

        request.end();
      }
    );
  });
}


/*
 * Generic cached HTTP request
 *
 * NASA uses fetchNASA() because of the Docker/Node HTTPS
 * connection issue described above.
 */
async function cachedGet(key, url) {
  const cached = cache.get(key);

  if (
    cached &&
    Date.now() - cached.timestamp < CACHE_TTL_MS
  ) {
    return {
      data: cached.data,
      cached: true
    };
  }

  let data;

  if (key === "NASA EONET") {
    data = await fetchNASA();
  } else {
    const response = await axios.get(url, {
      timeout: REQUEST_TIMEOUT_MS,

      headers: {
        Accept: "application/json",
        "User-Agent": "DisasterWatch/1.0"
      }
    });

    data = response.data;
  }

  cache.set(key, {
    timestamp: Date.now(),
    data
  });

  return {
    data,
    cached: false
  };
}


/*
 * Utility
 */
function safeNumber(value) {
  if (
    value === null ||
    value === undefined ||
    value === ""
  ) {
    return null;
  }

  const number = Number(value);

  return Number.isFinite(number) ? number : null;
}


/*
 * USGS
 */
function severityFromMagnitude(magnitude) {
  if (magnitude === null) return "unknown";

  if (magnitude >= 6) return "major";
  if (magnitude >= 5) return "strong";
  if (magnitude >= 4) return "moderate";

  return "minor";
}


function normalizeUSGS(feature) {
  const p = feature?.properties || {};
  const coords = feature?.geometry?.coordinates;

  if (!Array.isArray(coords) || coords.length < 2) {
    return null;
  }

  const longitude = safeNumber(coords[0]);
  const latitude = safeNumber(coords[1]);

  if (
    longitude === null ||
    latitude === null ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return null;
  }

  const magnitude = safeNumber(p.mag);

  return {
    id: `USGS-${
      feature.id ||
      `${latitude}-${longitude}-${p.time || ""}`
    }`,

    source: "USGS",

    type: "earthquake",

    eventType: "EQ",

    title:
      p.place ||
      p.title ||
      "Earthquake",

    description:
      p.title ||
      p.place ||
      "Earthquake reported by USGS",

    location:
      p.place ||
      "Location not provided",

    latitude,
    longitude,

    depth: safeNumber(coords[2]),

    severity:
      severityFromMagnitude(magnitude),

    magnitude,

    severityValue: magnitude,

    severityUnit: "M",

    severityText:
      magnitude === null
        ? "Magnitude unavailable"
        : `Magnitude ${magnitude}`,

    alertLevel: null,

    country: null,

    updated:
      p.time
        ? new Date(p.time).toISOString()
        : null,

    timestamp:
      safeNumber(p.time),

    detailsUrl:
      p.url ||
      null,

    closed: false
  };
}


/*
 * GDACS
 */
function getGDACSFeatures(data) {
  if (
    data &&
    Array.isArray(data.features)
  ) {
    return data.features;
  }

  if (
    data &&
    data.data &&
    Array.isArray(data.data.features)
  ) {
    return data.data.features;
  }

  return [];
}


function gdacsType(code) {
  const map = {
    EQ: "earthquake",
    TC: "cyclone",
    FL: "flood",
    WF: "wildfire",
    VO: "volcano",
    DR: "drought",
    TS: "tsunami",
    LS: "landslide"
  };

  return (
    map[String(code || "").toUpperCase()] ||
    "other"
  );
}


function gdacsSeverity(level) {
  const value =
    String(level || "").toLowerCase();

  if (value === "red") return "major";
  if (value === "orange") return "strong";
  if (value === "green") return "moderate";
  if (
    value === "grey" ||
    value === "gray"
  ) {
    return "minor";
  }

  return "unknown";
}


function normalizeGDACS(feature) {
  const p = feature?.properties || {};

  const coords =
    feature?.geometry?.coordinates;

  const bbox = feature?.bbox;

  const longitude = safeNumber(
    Array.isArray(coords)
      ? coords[0]
      : Array.isArray(bbox)
      ? bbox[0]
      : null
  );

  const latitude = safeNumber(
    Array.isArray(coords)
      ? coords[1]
      : Array.isArray(bbox)
      ? bbox[1]
      : null
  );

  if (
    longitude === null ||
    latitude === null ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return null;
  }

  const severityData =
    p.severitydata || {};

  const severityValue =
    safeNumber(
      severityData.severity
    );

  const eventType =
    String(
      p.eventtype || ""
    ).toUpperCase();

  const affected =
    Array.isArray(
      p.affectedcountries
    )
      ? p.affectedcountries[0]
      : null;

  const detailsUrl =
    p.url &&
    typeof p.url === "object"
      ? (
          p.url.details ||
          p.url.report ||
          p.url.geometry ||
          null
        )
      : null;

  return {
    id: `GDACS-${
      p.eventid ||
      p.episodeid ||
      `${latitude}-${longitude}`
    }`,

    source: "GDACS",

    type: gdacsType(eventType),

    eventType,

    title:
      p.name ||
      p.description ||
      "Unnamed GDACS event",

    description:
      p.htmldescription ||
      p.description ||
      p.name ||
      "Event reported by GDACS",

    location:
      affected?.countryname ||
      p.name ||
      "Location not provided",

    latitude,
    longitude,

    depth: null,

    severity:
      gdacsSeverity(
        p.alertlevel
      ),

    magnitude:
      eventType === "EQ"
        ? severityValue
        : null,

    severityValue,

    severityUnit:
      severityData.severityunit ||
      null,

    severityText:
      severityData.severitytext ||
      null,

    alertLevel:
      p.alertlevel ||
      null,

    alertScore:
      safeNumber(p.alertscore),

    country:
      affected?.countryname ||
      null,

    updated:
      p.fromdate ||
      p.datemodified ||
      null,

    timestamp:
      p.fromdate
        ? Date.parse(p.fromdate) ||
          null
        : null,

    detailsUrl,

    closed: false
  };
}


/*
 * NASA EONET
 */
function flattenCoordinatePairs(
  coordinates,
  result = []
) {
  if (!Array.isArray(coordinates)) {
    return result;
  }

  if (
    coordinates.length >= 2 &&
    typeof coordinates[0] === "number" &&
    typeof coordinates[1] === "number"
  ) {
    result.push([
      coordinates[0],
      coordinates[1]
    ]);
  } else {
    for (const item of coordinates) {
      flattenCoordinatePairs(
        item,
        result
      );
    }
  }

  return result;
}


function eonetType(categories = []) {
  const labels =
    categories
      .map(
        (c) =>
          `${c?.id || ""} ${
            c?.title || ""
          }`.toLowerCase()
      )
      .join(" ");

  if (
    labels.includes("wildfire") ||
    labels.includes("fire")
  ) {
    return "wildfire";
  }

  if (
    labels.includes("severe storm") ||
    labels.includes("storm") ||
    labels.includes("cyclone")
  ) {
    return "cyclone";
  }

  if (labels.includes("volcano")) {
    return "volcano";
  }

  if (labels.includes("landslide")) {
    return "landslide";
  }

  if (labels.includes("earthquake")) {
    return "earthquake";
  }

  if (labels.includes("flood")) {
    return "flood";
  }

  if (labels.includes("drought")) {
    return "drought";
  }

  if (
    labels.includes("dust") ||
    labels.includes("haze")
  ) {
    return "dust";
  }

  if (
    labels.includes("sea and lake ice") ||
    labels.includes("ice")
  ) {
    return "ice";
  }

  if (labels.includes("snow")) {
    return "snow";
  }

  if (labels.includes("water color")) {
    return "marine";
  }

  return "other";
}


function normalizeEONET(event) {
  const geometryList =
    Array.isArray(event?.geometry)
      ? event.geometry
      : [];

  let selected = null;
  let pairs = [];

  for (
    const item of [...geometryList].reverse()
  ) {
    const candidatePairs =
      flattenCoordinatePairs(
        item?.coordinates
      );

    if (candidatePairs.length) {
      selected = item;
      pairs = candidatePairs;
      break;
    }
  }

  if (
    !selected ||
    !pairs.length
  ) {
    return null;
  }

  /*
   * For polygons/lines use the mean
   * of their coordinates.
   */
  const longitude =
    pairs.reduce(
      (sum, pair) =>
        sum + pair[0],
      0
    ) / pairs.length;

  const latitude =
    pairs.reduce(
      (sum, pair) =>
        sum + pair[1],
      0
    ) / pairs.length;

  if (
    !Number.isFinite(longitude) ||
    !Number.isFinite(latitude) ||
    Math.abs(latitude) > 90 ||
    Math.abs(longitude) > 180
  ) {
    return null;
  }

  const categories =
    Array.isArray(event.categories)
      ? event.categories
      : [];

  const type =
    eonetType(categories);

  const date =
    selected.date || null;

  const magnitudeValue =
    safeNumber(
      selected.magnitudeValue
    );

  const sourceLinks =
    Array.isArray(event.sources)
      ? event.sources
      : [];

  return {
    id:
      `NASA-EONET-${event.id}`,

    source:
      "NASA EONET",

    type,

    eventType:
      categories
        .map((c) => c.title)
        .filter(Boolean)
        .join(", ") ||
      "Natural event",

    title:
      event.title ||
      "NASA natural event",

    description:
      event.description ||
      "Natural event tracked by NASA EONET",

    location:
      event.title ||
      "Location not provided",

    latitude,
    longitude,

    depth: null,

    severity: "unknown",

    magnitude:
      magnitudeValue,

    severityValue:
      magnitudeValue,

    severityUnit:
      selected.magnitudeUnit ||
      null,

    severityText:
      selected.magnitudeDescription ||
      null,

    alertLevel: null,

    country: null,

    updated: date,

    timestamp:
      date
        ? Date.parse(date) ||
          null
        : null,

    detailsUrl:
      event.link ||
      sourceLinks[0]?.url ||
      "https://eonet.gsfc.nasa.gov/",

    categories:
      categories
        .map((c) => c.title)
        .filter(Boolean),

    closed:
      Boolean(event.closed),

    closedAt:
      event.closed ||
      null
  };
}


/*
 * Load one source
 */
async function loadSource(
  key,
  url,
  normalizer,
  getItems
) {
  try {
    const result =
      await cachedGet(
        key,
        url
      );

    const items =
      getItems(result.data);

    const events =
      items
        .map(normalizer)
        .filter(Boolean);

    return {
      events,

      status: {
        status: "online",
        count: events.length,
        received: items.length,
        cached: result.cached,
        error: null
      }
    };
  } catch (error) {
    const cached =
      cache.get(key);

    /*
     * If an upstream source fails,
     * serve the last successful response.
     */
    if (cached) {
      const items =
        getItems(cached.data);

      const events =
        items
          .map(normalizer)
          .filter(Boolean);

      return {
        events,

        status: {
          status: "stale",
          count: events.length,
          received: items.length,
          cached: true,
          error: error.message
        }
      };
    }

    return {
      events: [],

      status: {
        status: "offline",
        count: 0,
        received: 0,
        cached: false,
        error: error.message
      }
    };
  }
}


/*
 * Combine all disaster sources
 */
async function getCombinedDisasters() {
  const [
    usgs,
    gdacs,
    nasa
  ] = await Promise.all([
    loadSource(
      "USGS",
      SOURCES.USGS,
      normalizeUSGS,
      (d) =>
        Array.isArray(d?.features)
          ? d.features
          : []
    ),

    loadSource(
      "GDACS",
      SOURCES.GDACS,
      normalizeGDACS,
      getGDACSFeatures
    ),

    loadSource(
      "NASA EONET",
      SOURCES.NASA_EONET,
      normalizeEONET,
      (d) =>
        Array.isArray(d?.events)
          ? d.events
          : []
    )
  ]);

  const all = [
    ...usgs.events,
    ...gdacs.events,
    ...nasa.events
  ];

  all.sort(
    (a, b) =>
      (
        b.timestamp ||
        Date.parse(b.updated || "") ||
        0
      ) -
      (
        a.timestamp ||
        Date.parse(a.updated || "") ||
        0
      )
  );

  return {
    status:
      Object.values({
        USGS: usgs.status,
        GDACS: gdacs.status,
        NASA_EONET: nasa.status
      }).some(
        (s) =>
          s.status === "online" ||
          s.status === "stale"
      )
        ? "success"
        : "error",

    count: all.length,

    sources: {
      USGS: usgs.status,
      GDACS: gdacs.status,
      "NASA EONET": nasa.status
    },

    updated:
      new Date().toISOString(),

    cacheTtlSeconds:
      Math.round(
        CACHE_TTL_MS / 1000
      ),

    disasters: all
  };
}


/*
 * Root endpoint
 */
app.get("/", (req, res) => {
  res.json({
    status: "success",

    message:
      "DisasterWatch API is running",

    version: "3.0.0",

    endpoints: [
      "/api/health",
      "/api/disasters",
      "/api/gdacs",
      "/api/nasa-eonet"
    ],

    sources: [
      "USGS",
      "GDACS",
      "NASA EONET"
    ]
  });
});


/*
 * Health endpoint
 */
app.get(
  "/api/health",
  async (req, res) => {
    try {
      const data =
        await getCombinedDisasters();

      const healthyCount =
        Object.values(data.sources)
          .filter(
            (s) =>
              s.status === "online" ||
              s.status === "stale"
          )
          .length;

      res
        .status(
          healthyCount > 0
            ? 200
            : 503
        )
        .json({
          status:
            healthyCount === 3
              ? "healthy"
              : healthyCount > 0
              ? "degraded"
              : "unavailable",

          healthySources:
            healthyCount,

          totalSources: 3,

          sources:
            data.sources,

          updated:
            data.updated
        });
    } catch (error) {
      console.error(
        "Health endpoint error:",
        error.message
      );

      res.status(500).json({
        status: "error",
        message:
          "Unable to check source health"
      });
    }
  }
);


/*
 * Combined disasters
 */
app.get(
  "/api/disasters",
  async (req, res) => {
    try {
      const data =
        await getCombinedDisasters();

      res
        .status(
          data.status === "success"
            ? 200
            : 503
        )
        .json(data);
    } catch (error) {
      console.error(
        "Combined disaster API error:",
        error.message
      );

      res.status(500).json({
        status: "error",
        message:
          "Unable to assemble disaster feeds",
        disasters: [],
        count: 0
      });
    }
  }
);


/*
 * GDACS endpoint
 */
app.get(
  "/api/gdacs",
  async (req, res) => {
    const result =
      await loadSource(
        "GDACS",
        SOURCES.GDACS,
        normalizeGDACS,
        getGDACSFeatures
      );

    res
      .status(
        result.status.status === "offline"
          ? 502
          : 200
      )
      .json({
        status:
          result.status.status === "offline"
            ? "error"
            : "success",

        source: "GDACS",

        ...result.status,

        disasters:
          result.events,

        updated:
          new Date().toISOString()
      });
  }
);


/*
 * NASA EONET endpoint
 */
app.get(
  "/api/nasa-eonet",
  async (req, res) => {
    const result =
      await loadSource(
        "NASA EONET",
        SOURCES.NASA_EONET,
        normalizeEONET,
        (d) =>
          Array.isArray(d?.events)
            ? d.events
            : []
      );

    res
      .status(
        result.status.status === "offline"
          ? 502
          : 200
      )
      .json({
        status:
          result.status.status === "offline"
            ? "error"
            : "success",

        source:
          "NASA EONET",

        ...result.status,

        disasters:
          result.events,

        updated:
          new Date().toISOString()
      });
  }
);


/*
 * 404 handler
 */
app.use(
  (req, res) => {
    res.status(404).json({
      status: "error",
      message: "Endpoint not found",
      path: req.originalUrl
    });
  }
);


/*
 * Global error handler
 */
app.use(
  (error, req, res, next) => {
    console.error(
      "Unhandled server error:",
      error
    );

    if (res.headersSent) {
      return next(error);
    }

    res.status(500).json({
      status: "error",
      message: "Internal server error"
    });
  }
);


/*
 * Start server
 */
const server =
  app.listen(
    PORT,
    () => {
      console.log(
        `DisasterWatch API v3.0.0 listening on http://localhost:${PORT}`
      );

      console.log(
        "Feeds: USGS, GDACS, NASA EONET"
      );
    }
  );


/*
 * Graceful shutdown
 */
function shutdown(signal) {
  console.log(
    `${signal} received. Closing DisasterWatch API...`
  );

  server.close(
    () => process.exit(0)
  );

  setTimeout(
    () => process.exit(1),
    5000
  ).unref();
}


process.on(
  "SIGINT",
  () => shutdown("SIGINT")
);

process.on(
  "SIGTERM",
  () => shutdown("SIGTERM")
);
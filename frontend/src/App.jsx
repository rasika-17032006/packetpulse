import { useEffect, useMemo, useRef, useState, useCallback } from "react";
import {
  MapContainer,
  TileLayer,
  Polyline,
  Marker,
  Tooltip,
  ZoomControl,
  useMap,
  useMapEvents,
} from "react-leaflet";
import L from "leaflet";
import "leaflet/dist/leaflet.css";
import "./App.css";
import axios from "axios";

const RAW_BACKEND = import.meta.env.VITE_BACKEND_URL || "http://localhost:8001";
const BACKEND_URL = RAW_BACKEND.startsWith("http") ? RAW_BACKEND : `https://${RAW_BACKEND}`;
const API = `${BACKEND_URL}/api`;
const WS_URL = `${BACKEND_URL.replace(/^http/, "ws")}/api/ws/stream`;
const nodeIcon = (label, kind = "node") =>
  L.divIcon({
    className: "pp-node-wrap",
    html: `<div class="pp-node ${kind}"><div class="pp-node-text">${label}</div></div>`,
    iconSize: [14, 14],
    iconAnchor: [7, 7],
  });

const fmt = (n, d = 1) => (n == null || Number.isNaN(n) ? "—" : Number(n).toFixed(d));

// ---- one-time-fit-bounds (does NOT re-fit on every topology change so user can pan freely) ----
function FitOnce({ nodes }) {
  const map = useMap();
  const doneRef = useRef(false);
  useEffect(() => {
    if (doneRef.current || !nodes?.length) return;
    const bounds = L.latLngBounds(nodes.map((n) => [n.lat, n.lng]));
    map.fitBounds(bounds, { padding: [60, 60] });
    doneRef.current = true;
  }, [map, nodes]);
  return null;
}

// ---- background "click empty map -> add node" trigger ----
function MapClickHandler({ onMapClick }) {
  useMapEvents({
    click(e) {
      // Skip if the click landed on a marker / its label / a control / our overlays.
      const t = e.originalEvent?.target;
      if (!t) return;
      if (t.closest?.(".leaflet-marker-icon")) return;
      if (t.closest?.(".leaflet-control")) return;
      if (t.closest?.(".pp-overlay")) return;
      if (t.closest?.(".pp-add-modal")) return;
      onMapClick(e.latlng);
    },
  });
  return null;
}

// Polyline wrapper that imperatively sets the SVG path className so our CSS
// flowing-current animation actually attaches (react-leaflet v4 doesn't
// re-apply pathOptions.className on updates).
function FlowPolyline({ positions, color, weight, opacity, className, children }) {
  const ref = useRef(null);
  useEffect(() => {
    const layer = ref.current;
    const path = layer?._path || layer?.getElement?.();
    if (path && path.setAttribute) {
      path.setAttribute("class", `leaflet-interactive ${className || ""}`.trim());
    }
  });
  return (
    <Polyline
      ref={ref}
      positions={positions}
      pathOptions={{ color, weight, opacity, className, lineCap: "round", lineJoin: "round" }}
    >
      {children}
    </Polyline>
  );
}

export default function App() {
  const [topology, setTopology] = useState({ nodes: [], edges: [], attacked: [] });
  const [edgeMetrics, setEdgeMetrics] = useState({});
  const [nodeTraffic, setNodeTraffic] = useState({});
  const [source, setSource] = useState(null);
  const [target, setTarget] = useState(null);
  const [routes, setRoutes] = useState(null);
  const [events, setEvents] = useState([]);
  const [wsStatus, setWsStatus] = useState("connecting");
  const [throughput, setThroughput] = useState(0);
  const [ddosSeverity, setDdosSeverity] = useState(9999);
  const [ddosDuration, setDdosDuration] = useState(20);
  const [addNodePrompt, setAddNodePrompt] = useState(null); // {lat, lng, screenX, screenY}
  const [newNodeName, setNewNodeName] = useState("");
  const wsRef = useRef(null);
  const wsRetryRef = useRef(0);

  // initial topology
  useEffect(() => {
    axios.get(`${API}/topology`).then((r) => applySnapshot(r.data));
  }, []);

  const applySnapshot = (snap) => {
    setTopology({ nodes: snap.nodes, edges: snap.edges, attacked: snap.attacked });
    const m = {};
    snap.edges.forEach((e) => {
      m[`${e.source}|${e.target}`] = { latency: e.latency, traffic: e.traffic };
    });
    setEdgeMetrics(m);
    if (snap.events) setEvents(snap.events);
  };

  // WebSocket with auto-reconnect
  useEffect(() => {
    let alive = true;
    const connect = () => {
      if (!alive) return;
      const ws = new WebSocket(WS_URL);
      wsRef.current = ws;
      ws.onopen = () => { setWsStatus("live"); wsRetryRef.current = 0; };
      ws.onerror = () => setWsStatus("error");
      ws.onclose = () => {
        setWsStatus("offline");
        if (!alive) return;
        const wait = Math.min(8000, 700 * Math.pow(1.5, wsRetryRef.current++));
        setTimeout(connect, wait);
      };
      ws.onmessage = (msg) => {
        if (!alive) return;
        const data = JSON.parse(msg.data);
        if (data.type === "snapshot" || data.type === "topology_changed") {
          applySnapshot(data);
        } else if (data.type === "tick") {
          const m = {};
          data.edges.forEach((e) => {
            m[`${e.source}|${e.target}`] = { latency: e.latency, traffic: e.traffic };
          });
          setEdgeMetrics(m);
          if (data.nodes) {
            const nt = {};
            data.nodes.forEach((n) => (nt[n.id] = n.traffic));
            setNodeTraffic(nt);
          }
          setTopology((t) => ({ ...t, attacked: data.attacked || t.attacked }));
          if (typeof data.throughput === "number") setThroughput(data.throughput);
        } else if (data.type === "event") {
          if (data.attacked) setTopology((t) => ({ ...t, attacked: data.attacked }));
          if (data.event) setEvents((prev) => [...prev.slice(-99), data.event]);
        }
      };
    };
    connect();
    return () => {
      alive = false;
      if (wsRef.current) wsRef.current.close();
    };
  }, []);

  // routing
  const computeRoutes = useCallback(async (s, t) => {
    if (!s || !t || s === t) { setRoutes(null); return; }
    try {
      const r = await axios.post(`${API}/route`, { source: s, target: t, k: 6 });
      setRoutes(r.data);
    } catch (e) { setRoutes(null); }
  }, []);
  useEffect(() => { if (source && target) computeRoutes(source, target); }, [source, target, computeRoutes]);
  useEffect(() => {
    if (!source || !target) return;
    const id = setInterval(() => computeRoutes(source, target), 3000);
    return () => clearInterval(id);
  }, [source, target, computeRoutes]);

  // refresh routes whenever attack list changes (instant reroute UI)
  useEffect(() => {
    if (source && target) computeRoutes(source, target);
  }, [JSON.stringify(topology.attacked.map((a) => (typeof a === "string" ? a : a.id)).sort()), source, target, computeRoutes]);

  const handleNodeClick = (nodeId) => {
    if (!source) { setSource(nodeId); setRoutes(null); }
    else if (source && !target && nodeId !== source) setTarget(nodeId);
    else { setSource(nodeId); setTarget(null); setRoutes(null); }
  };

  const reset = () => { setSource(null); setTarget(null); setRoutes(null); };

  const injectDDoS = async (nodeId) => {
    const params = new URLSearchParams({
      severity: String(ddosSeverity),
      ...(ddosDuration ? { duration: String(ddosDuration) } : {}),
    });
    await axios.post(`${API}/ddos/${nodeId}?${params.toString()}`);
  };
  const clearDDoS = async (nodeId) => {
    await axios.post(`${API}/ddos/${nodeId}/clear`);
  };
  const runScenario = async () => { await axios.post(`${API}/scenario/demo`); };

  const handleMapClick = (latlng) => {
    setAddNodePrompt({ lat: latlng.lat, lng: latlng.lng });
    setNewNodeName("");
  };
  const submitAddNode = async () => {
    if (!addNodePrompt) return;
    await axios.post(`${API}/nodes`, {
      name: newNodeName || null,
      lat: addNodePrompt.lat,
      lng: addNodePrompt.lng,
    });
    setAddNodePrompt(null); setNewNodeName("");
  };
  const removeNode = async (nodeId) => {
    await axios.delete(`${API}/nodes/${nodeId}`);
    if (source === nodeId) setSource(null);
    if (target === nodeId) setTarget(null);
  };

  // path lookups
  const optimalEdges = useMemo(() => {
    if (!routes?.optimal) return new Set();
    const s = new Set();
    for (let i = 0; i < routes.optimal.length - 1; i++) {
      const a = routes.optimal[i], b = routes.optimal[i + 1];
      s.add(`${a}|${b}`); s.add(`${b}|${a}`);
    }
    return s;
  }, [routes]);

  const altEdges = useMemo(() => {
    if (!routes?.paths) return new Set();
    const s = new Set();
    routes.paths.slice(1).forEach((p) => {
      for (let i = 0; i < p.hops.length - 1; i++) {
        s.add(`${p.hops[i]}|${p.hops[i + 1]}`);
        s.add(`${p.hops[i + 1]}|${p.hops[i]}`);
      }
    });
    return s;
  }, [routes]);

  const nodeMap = useMemo(() => {
    const m = {}; topology.nodes.forEach((n) => (m[n.id] = n)); return m;
  }, [topology.nodes]);

  const attackedIds = useMemo(
    () => new Set(topology.attacked.map((a) => (typeof a === "string" ? a : a.id))),
    [topology.attacked]
  );

  const kpis = useMemo(() => {
    const lats = Object.values(edgeMetrics).map((e) => e.latency).filter((x) => x < 9000);
    const traffics = Object.values(edgeMetrics).map((e) => e.traffic);
    return {
      avgLatency: lats.length ? lats.reduce((a, b) => a + b, 0) / lats.length : 0,
      avgTraffic: traffics.length ? traffics.reduce((a, b) => a + b, 0) / traffics.length : 0,
      attacked: attackedIds.size,
      throughput,
    };
  }, [edgeMetrics, attackedIds, throughput]);

  return (
    <div className="pp-shell">
      <header className="pp-top">
        <div className="pp-brand">
          <span className="dot" />
          <span>PacketPulse</span>
          <small>Global CDN Routing &amp; DDoS Mitigation</small>
        </div>
        <div className="pp-top-actions">
          <button className="pp-btn scenario" onClick={runScenario} >
            ▶ Run scripted DDoS demo
          </button>
          <span
            className={`pp-pill ${wsStatus === "live" ? "live" : "offline"}`}
          >
            {wsStatus === "live" ? "STREAM LIVE" : `STREAM ${wsStatus.toUpperCase()}`}
          </span>
          <button className="pp-btn ghost" onClick={reset} >
            Reset selection
          </button>
        </div>
      </header>

      <div className="pp-map-wrap">
        <MapContainer
          className="pp-map"
          center={[20, 10]}
          zoom={2}
          minZoom={2}
          worldCopyJump
          scrollWheelZoom
          zoomControl={false}
          data-testid="pp-map"
        >
          <TileLayer
            attribution='Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics &amp; the GIS User Community'
            url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
            className="pp-tile-imagery"
          />
          <TileLayer
            attribution='Labels &copy; Esri'
            url="https://server.arcgisonline.com/ArcGIS/rest/services/Reference/World_Boundaries_and_Places/MapServer/tile/{z}/{y}/{x}"
            className="pp-tile-labels"
          />
          
          <ZoomControl position="bottomleft" />
          <FitOnce nodes={topology.nodes} />
          <MapClickHandler onMapClick={handleMapClick} />

          {topology.edges.map((e) => {
            const a = nodeMap[e.source]; const b = nodeMap[e.target];
            if (!a || !b) return null;
            const key = `${e.source}|${e.target}`;
            const live = edgeMetrics[key] || { latency: e.latency, traffic: e.traffic };
            const isOptimal = optimalEdges.has(key);
            const isAlt = altEdges.has(key) && !isOptimal;
            const isAttacked = attackedIds.has(e.source) || attackedIds.has(e.target);

            let color = "#cbd5e1"; let weight = 1.5; let opacity = 0.75; let className = "";
            if (isAttacked) { color = "#ef4444"; weight = 1.5; opacity = 0.55; className = "pp-flow-attacked"; }
            if (isAlt)     { color = "#f59e0b"; weight = 3;   opacity = 0.9;  className = "pp-flow-alt"; }
            if (isOptimal) { color = "#1f9d55"; weight = 5;   opacity = 1;    className = "pp-flow-optimal"; }

            return (
              <FlowPolyline
                key={`${key}-${className}`}
                positions={[[a.lat, a.lng], [b.lat, b.lng]]}
                color={color}
                weight={weight}
                opacity={opacity}
                className={className}
              >
                <Tooltip sticky direction="top" className="pp-edge-tooltip">
                  {a.name} ↔ {b.name}
                  <br />latency: <b>{fmt(live.latency)} ms</b>
                  <br />traffic: <b>{fmt(live.traffic, 0)}%</b>
                </Tooltip>
              </FlowPolyline>
            );
          })}

          {topology.nodes.map((n) => {
            const isSrc = source === n.id;
            const isDst = target === n.id;
            const isAttk = attackedIds.has(n.id);
            const kind = isAttk ? "attacked" : isSrc ? "src" : isDst ? "dst" : "node";
            const label = n.name;
            const traf = nodeTraffic[n.id];
            return (
              <Marker
                key={n.id}
                position={[n.lat, n.lng]}
                icon={nodeIcon(label, kind)}
                eventHandlers={{ click: () => handleNodeClick(n.id) }}
              >
                <Tooltip direction="top" offset={[0, -10]} className="pp-edge-tooltip">
                  <div style={{ minWidth: 160 }}>
                    <div><b>{n.name}</b> ({n.id}){n.custom && " · custom"}</div>
                    <div style={{ fontSize: 10.5, color: "#4a5468", marginTop: 2 }}>
                      {isAttk ? "⚠ UNDER ATTACK"
                        : isSrc ? "● SOURCE"
                        : isDst ? "● DESTINATION"
                        : "click to select"}
                    </div>
                    {typeof traf === "number" && (
                      <div style={{ fontSize: 10.5, color: "#4a5468", marginTop: 2 }}>
                        node traffic: <b>{fmt(traf, 0)}%</b>
                      </div>
                    )}
                    {n.custom && (
                      <button
                        className="pp-btn"
                        style={{ marginTop: 6, fontSize: 10, padding: "3px 7px" }}
                        onClick={(e) => { e.stopPropagation(); removeNode(n.id); }}
                      >
                        remove node
                      </button>
                    )}
                  </div>
                </Tooltip>
              </Marker>
            );
          })}
        </MapContainer>

        {/* legend */}
        <div className="pp-legend">
          <div><span className="sw" style={{ background: "#1f9d55" }} /> optimal route (flowing)</div>
          <div><span className="sw" style={{ background: "#f59e0b" }} /> alternative route</div>
          <div><span className="sw" style={{ background: "#9aa9be" }} /> idle link</div>
          <div><span className="sw" style={{ background: "#ef4444" }} /> under attack</div>
          <div style={{ marginTop: 4, paddingTop: 6, borderTop: "1px dashed #d9e2ee" }}>
            <span className="dot" style={{ background: "#2563eb" }} /> source &nbsp;
            <span className="dot" style={{ background: "#a855f7" }} /> destination
          </div>
          <div className="muted" style={{ fontSize: 10.5, marginTop: 2 }}>
            tip: click empty ocean / land to add a new data center
          </div>
        </div>

        {/* selection + DDoS controls overlay */}
        <div className="pp-overlay">
          <h3>Selection &amp; DDoS</h3>
          {!source && <p className="muted">Click any data center to set <b>source</b>.</p>}
          {source && !target && (
            <p>
              Source: <b>{nodeMap[source]?.name}</b>
              <br /><span className="muted">Click another to set destination.</span>
            </p>
          )}
          {source && target && (
            <p>
              <b>{nodeMap[source]?.name}</b> → <b>{nodeMap[target]?.name}</b>
            </p>
          )}

          <div className="pp-slider-block">
            <div className="pp-slider-label">
              <span>DDoS severity</span>
              <span><b>{ddosSeverity}</b> ms</span>
            </div>
            <input
              type="range" min="50" max="9999" step="1"
              value={ddosSeverity}
              onChange={(e) => setDdosSeverity(Number(e.target.value))}
            />
          </div>
          <div className="pp-slider-block">
            <div className="pp-slider-label">
              <span>Auto-heal duration</span>
              <span>{ddosDuration === 0 ? "forever" : `${ddosDuration}s`}</span>
            </div>
            <input
              type="range" min="0" max="60" step="5"
              value={ddosDuration}
              onChange={(e) => setDdosDuration(Number(e.target.value))}
            />
          </div>

          <div className="pp-row" style={{ marginTop: 8 }}>
            <button
              className="pp-btn danger"
              disabled={!source}
              onClick={() => source && injectDDoS(source)}
            >⚡ DDoS source</button>
            <button
              className="pp-btn danger"
              disabled={!target}
              onClick={() => target && injectDDoS(target)}
            >⚡ DDoS target</button>
            <button
              className="pp-btn"
              disabled={attackedIds.size === 0}
              onClick={() => attackedIds.forEach(clearDDoS)}
            >Clear ({attackedIds.size})</button>
          </div>
        </div>

        {/* add-node modal */}
        {addNodePrompt && (
          <div className="pp-add-modal" style={{ left: "50%", top: "30%", transform: "translateX(-50%)" }}>
            <h4>Add data center</h4>
            <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
              {addNodePrompt.lat.toFixed(2)}°, {addNodePrompt.lng.toFixed(2)}°
            </div>
            <input
              autoFocus
              placeholder="optional name (e.g. Bangalore)"
              value={newNodeName}
              onChange={(e) => setNewNodeName(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && submitAddNode()}
            />
            <div className="pp-row">
              <button className="pp-btn primary" onClick={submitAddNode}>
                Add &amp; auto-link
              </button>
              <button className="pp-btn ghost" onClick={() => setAddNodePrompt(null)}>
                Cancel
              </button>
            </div>
          </div>
        )}
      </div>

      {/* side panel */}
      <aside className="pp-side">
        <div className="pp-side-section">
          <h2>Live network</h2>
          <div className="pp-kpi">
            <div><span>Avg latency</span><b className="link">{fmt(kpis.avgLatency)} ms</b></div>
            <div><span>Avg traffic</span><b>{fmt(kpis.avgTraffic, 0)}%</b></div>
            <div><span>Throughput</span><b className="accent">{fmt(kpis.throughput, 0)} units</b></div>
            <div><span>Under attack</span><b className={kpis.attacked ? "bad" : ""}>{kpis.attacked}</b></div>
          </div>
        </div>

        {topology.nodes.some((n) => n.custom) && (
          <div className="pp-side-section">
            <h2>Your custom data centers</h2>
            <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
              {topology.nodes.filter((n) => n.custom).map((n) => (
                <div key={n.id} style={{
                  display: "flex", justifyContent: "space-between", alignItems: "center",
                  padding: "6px 10px", background: "var(--panel-2)",
                  border: "1px solid var(--line)", borderRadius: 8, fontSize: 12
                }}>
                  <span><b>{n.name}</b> <span className="muted">({n.lat.toFixed(1)}°, {n.lng.toFixed(1)}°)</span></span>
                  <button
                    className="pp-btn"
                    style={{ padding: "3px 8px", fontSize: 11 }}
                    onClick={() => removeNode(n.id)}
                  >remove</button>
                </div>
              ))}
            </div>
          </div>
        )}

        <div className="pp-side-section" style={{ paddingBottom: 6 }}>
          <h2>Routes {source && target ? `· ${source.toUpperCase()} → ${target.toUpperCase()}` : ""}</h2>
          {!source || !target ? (
            <div className="muted">
              Pick a <b>source</b> then a <b>destination</b> on the map. Dijkstra k-shortest
              paths re-rank every 3s using live latency &amp; traffic. The{" "}
              <span style={{ color: "var(--accent)", fontWeight: 700 }}>green flowing line</span>{" "}
              on the map is the optimal route.
            </div>
          ) : (
            <div className="muted">
              {routes?.paths?.length || 0} alternative paths · ranked by live traffic + latency.
            </div>
          )}
        </div>

        <div className="pp-routes">
          {routes?.paths?.map((p) => {
            const cls = `pp-route-card ${p.rank === 1 ? "optimal" : ""} ${p.blocked_by_attack ? "blocked" : ""}`;
            return (
              <div key={p.rank} className={cls}>
                <div className="pp-route-header">
                  <span className="pp-route-rank">
                    {p.rank === 1 ? "★ OPTIMAL" : `#${p.rank}`}
                  </span>
                  {p.blocked_by_attack && (
                    <span style={{ fontSize: 11, color: "var(--bad)" }}>⚠ transit blocked</span>
                  )}
                </div>
                <div className="pp-route-hops">
                  {p.hops.map((h) => nodeMap[h]?.name || h).join(" → ")}
                </div>
                <div className="pp-route-meta">
                  <span>latency: <b>{fmt(p.total_latency)} ms</b></span>
                  <span>avg traffic: <b>{fmt(p.avg_traffic, 0)}%</b></span>
                  <span>peak: <b>{fmt(p.max_traffic, 0)}%</b></span>
                  <span>hops: <b>{p.hop_count}</b></span>
                </div>
              </div>
            );
          })}
        </div>

        <div className="pp-side-section">
          <h2>Event log</h2>
          <div className="pp-log">
            {events.length === 0 && (
              <div className="pp-log-empty">No events yet. Inject a DDoS or select two nodes.</div>
            )}
            {events.slice().reverse().map((ev, i) => (
              <div key={i} className="pp-log-row">
                <span className={`k ${ev.kind}`}>{ev.kind}</span>
                <span>{ev.message}</span>
              </div>
            ))}
          </div>
        </div>
      </aside>
    </div>
  );
}











// import { useEffect, useMemo, useRef, useState, useCallback } from "react";
// import {
//   MapContainer,
//   TileLayer,
//   Polyline,
//   Marker,
//   Tooltip,
//   ZoomControl,
//   useMap,
//   useMapEvents,
// } from "react-leaflet";
// import L from "leaflet";
// import "leaflet/dist/leaflet.css";
// import "./App.css";
// import axios from "axios";

// const BACKEND_URL = import.meta.env.VITE_BACKEND_URL || "http://localhost:8001";
// const API = `${BACKEND_URL}/api`;
// const WS_URL = `${BACKEND_URL.replace(/^http/, "ws")}/api/ws/stream`;

// const nodeIcon = (label, kind = "node") =>
//    L.divIcon({
//    className: "pp-node-wrap",
//      html: `<div class="pp-node ${kind}"><div class="pp-node-text">${label}</div></div>`,
//      iconSize: [14, 14],
//      iconAnchor: [7, 7],
//  });

// const fmt = (n, d = 1) =>
//   n == null || Number.isNaN(n) ? "-" : Number(n).toFixed(d);

// function FitOnce({ nodes }) {
//   const map = useMap();
//   const doneRef = useRef(false);

//   useEffect(() => {
//     if (doneRef.current || !nodes?.length) return;
//     const bounds = L.latLngBounds(nodes.map((n) => [n.lat, n.lng]));
//     map.fitBounds(bounds, { padding: [60, 60] });
//     doneRef.current = true;
//   }, [map, nodes]);

//   return null;
// }

// function MapClickHandler({ onMapClick }) {
//   useMapEvents({
//     click(e) {
//       const t = e.originalEvent?.target;
//       if (!t) return;
//       if (t.closest?.(".leaflet-marker-icon")) return;
//       if (t.closest?.(".leaflet-control")) return;
//       if (t.closest?.(".pp-overlay")) return;
//       if (t.closest?.(".pp-add-modal")) return;
//       onMapClick(e.latlng);
//     },
//   });
//   return null;
// }

// function FlowPolyline({ positions, color, weight, opacity, className, children }) {
//   const ref = useRef(null);

//   useEffect(() => {
//     const layer = ref.current;
//     const path = layer?._path || layer?.getElement?.();
//     if (path && path.setAttribute) {
//       path.setAttribute(
//         "class",
//         `leaflet-interactive ${className || ""}`.trim()
//       );
//     }
//   });

//   return (
//     <Polyline
//       ref={ref}
//       positions={positions}
//       pathOptions={{
//         color,
//         weight,
//         opacity,
//         className,
//         lineCap: "round",
//         lineJoin: "round",
//       }}
//     >
//       {children}
//     </Polyline>
//   );
// }

// export default function App() {
//   const [topology, setTopology] = useState({ nodes: [], edges: [], attacked: [] });
//   const [edgeMetrics, setEdgeMetrics] = useState({});
//   const [nodeTraffic, setNodeTraffic] = useState({});
//   const [source, setSource] = useState(null);
//   const [target, setTarget] = useState(null);
//   const [routes, setRoutes] = useState(null);
//   const [events, setEvents] = useState([]);
//   const [wsStatus, setWsStatus] = useState("connecting");
//   const [throughput, setThroughput] = useState(0);
//   const [ddosSeverity, setDdosSeverity] = useState(9999);
//   const [ddosDuration, setDdosDuration] = useState(20);
//   const [addNodePrompt, setAddNodePrompt] = useState(null);
//   const [newNodeName, setNewNodeName] = useState("");
//   const wsRef = useRef(null);
//   const wsRetryRef = useRef(0);

//   useEffect(() => {
//     axios.get(`${API}/topology`).then((r) => applySnapshot(r.data));
//   }, []);

//   const applySnapshot = (snap) => {
//     setTopology({
//       nodes: snap.nodes,
//       edges: snap.edges,
//       attacked: snap.attacked,
//     });
//     const m = {};
//     snap.edges.forEach((e) => {
//       m[`${e.source}|${e.target}`] = { latency: e.latency, traffic: e.traffic };
//     });
//     setEdgeMetrics(m);
//     if (snap.events) setEvents(snap.events);
//   };

//   useEffect(() => {
//     let alive = true;
//     const connect = () => {
//       if (!alive) return;
//       const ws = new WebSocket(WS_URL);
//       wsRef.current = ws;

//       ws.onopen = () => {
//         setWsStatus("live");
//         wsRetryRef.current = 0;
//       };
//       ws.onerror = () => setWsStatus("error");
//       ws.onclose = () => {
//         setWsStatus("offline");
//         if (!alive) return;
//         const wait = Math.min(8000, 700 * Math.pow(1.5, wsRetryRef.current++));
//         setTimeout(connect, wait);
//       };

//       ws.onmessage = (msg) => {
//         if (!alive) return;
//         const data = JSON.parse(msg.data);
//         if (data.type === "snapshot" || data.type === "topology_changed") {
//           applySnapshot(data);
//         } else if (data.type === "tick") {
//           const m = {};
//           data.edges.forEach((e) => {
//             m[`${e.source}|${e.target}`] = { latency: e.latency, traffic: e.traffic };
//           });
//           setEdgeMetrics(m);
//           if (data.nodes) {
//             const nt = {};
//             data.nodes.forEach((n) => {
//               nt[n.id] = n.traffic;
//             });
//             setNodeTraffic(nt);
//           }
//           setTopology((t) => ({ ...t, attacked: data.attacked || t.attacked }));
//           if (typeof data.throughput === "number") {
//             setThroughput(data.throughput);
//           }
//         } else if (data.type === "event") {
//           if (data.attacked) {
//             setTopology((t) => ({ ...t, attacked: data.attacked }));
//           }
//           if (data.event) {
//             setEvents((prev) => [...prev.slice(-99), data.event]);
//           }
//         }
//       };
//     };

//     connect();
//     return () => {
//       alive = false;
//       if (wsRef.current) wsRef.current.close();
//     };
//   }, []);

//   const computeRoutes = useCallback(async (s, t) => {
//     if (!s || !t || s === t) {
//       setRoutes(null);
//       return;
//     }
//     try {
//       const r = await axios.post(`${API}/route`, { source: s, target: t, k: 6 });
//       setRoutes(r.data);
//     } catch (e) {
//       setRoutes(null);
//     }
//   }, []);

//   useEffect(() => {
//     if (source && target) computeRoutes(source, target);
//   }, [source, target, computeRoutes]);

//   useEffect(() => {
//     if (!source || !target) return;
//     const id = setInterval(() => computeRoutes(source, target), 3000);
//     return () => clearInterval(id);
//   }, [source, target, computeRoutes]);

//   useEffect(() => {
//     if (source && target) computeRoutes(source, target);
//   }, [
//     JSON.stringify(
//       topology.attacked.map((a) => (typeof a === "string" ? a : a.id)).sort()
//     ),
//     source,
//     target,
//     computeRoutes,
//   ]);

//   const handleNodeClick = (nodeId) => {
//     if (!source) {
//       setSource(nodeId);
//       setRoutes(null);
//     } else if (source && !target && nodeId !== source) {
//       setTarget(nodeId);
//     } else {
//       setSource(nodeId);
//       setTarget(null);
//       setRoutes(null);
//     }
//   };

//   const reset = () => {
//     setSource(null);
//     setTarget(null);
//     setRoutes(null);
//   };

//   const injectDDoS = async (nodeId) => {
//     const params = new URLSearchParams({
//       severity: String(ddosSeverity),
//       ...(ddosDuration ? { duration: String(ddosDuration) } : {}),
//     });
//     await axios.post(`${API}/ddos/${nodeId}?${params.toString()}`);
//   };

//   const clearDDoS = async (nodeId) => {
//     await axios.post(`${API}/ddos/${nodeId}/clear`);
//   };

//   const runScenario = async () => {
//     await axios.post(`${API}/scenario/demo`);
//   };

//   const handleMapClick = (latlng) => {
//     setAddNodePrompt({ lat: latlng.lat, lng: latlng.lng });
//     setNewNodeName("");
//   };

//   const submitAddNode = async () => {
//     if (!addNodePrompt) return;
//     await axios.post(`${API}/nodes`, {
//       name: newNodeName || null,
//       lat: addNodePrompt.lat,
//       lng: addNodePrompt.lng,
//     });
//     setAddNodePrompt(null);
//     setNewNodeName("");
//   };

//   const removeNode = async (nodeId) => {
//     await axios.delete(`${API}/nodes/${nodeId}`);
//     if (source === nodeId) setSource(null);
//     if (target === nodeId) setTarget(null);
//   };

//   const optimalEdges = useMemo(() => {
//     if (!routes?.optimal) return new Set();
//     const s = new Set();
//     for (let i = 0; i < routes.optimal.length - 1; i++) {
//       const a = routes.optimal[i],
//         b = routes.optimal[i + 1];
//       s.add(`${a}|${b}`);
//       s.add(`${b}|${a}`);
//     }
//     return s;
//   }, [routes]);

//   const altEdges = useMemo(() => {
//     if (!routes?.paths) return new Set();
//     const s = new Set();
//     routes.paths.slice(1).forEach((p) => {
//       for (let i = 0; i < p.hops.length - 1; i++) {
//         s.add(`${p.hops[i]}|${p.hops[i + 1]}`);
//         s.add(`${p.hops[i + 1]}|${p.hops[i]}`);
//       }
//     });
//     return s;
//   }, [routes]);

//   const nodeMap = useMemo(() => {
//     const m = {};
//     topology.nodes.forEach((n) => {
//       m[n.id] = n;
//     });
//     return m;
//   }, [topology.nodes]);

//   const attackedIds = useMemo(
//     () =>
//       new Set(
//         topology.attacked.map((a) => (typeof a === "string" ? a : a.id))
//       ),
//     [topology.attacked]
//   );

//   const kpis = useMemo(() => {
//     const lats = Object.values(edgeMetrics)
//       .map((e) => e.latency)
//       .filter((x) => x < 9000);
//     const traffics = Object.values(edgeMetrics).map((e) => e.traffic);
//     return {
//       avgLatency: lats.length ? lats.reduce((a, b) => a + b, 0) / lats.length : 0,
//       avgTraffic: traffics.length ? traffics.reduce((a, b) => a + b, 0) / traffics.length : 0,
//       attacked: attackedIds.size,
//       throughput,
//     };
//   }, [edgeMetrics, attackedIds, throughput]);

//   return (
//     <div className="pp-shell">
//       <header className="pp-top">
//         <div className="pp-brand">
//           <span className="dot" />
//           <span>PacketPulse Telemetry</span>
//           <small>Global Content Delivery Network Optimizer</small>
//         </div>
//         <div className="pp-top-actions">
//           <button className="pp-btn scenario" onClick={runScenario}>
//             ⚡ Run Scripted Simulation Test
//           </button>
//           <span className={`pp-pill ${wsStatus === "live" ? "live" : "offline"}`}>
//             {wsStatus === "live" ? "LIVE COMPILING FEED" : `FEED: ${wsStatus.toUpperCase()}`}
//           </span>
//           <button className="pp-btn ghost" onClick={reset}>
//             Reset Path Vectors
//           </button>
//         </div>
//       </header>

//       <div className="pp-map-wrap">
//         <MapContainer
//           className="pp-map"
//           center={[20, 10]}
//           zoom={2}
//           minZoom={2}
//           worldCopyJump
//           scrollWheelZoom
//           zoomControl={false}
//         >
//           {/* <TileLayer
//             attribution="Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics"
//             url="https://arcgisonline.com{z}/{y}/{x}"
//             className="pp-tile-imagery"
//           />
//           <TileLayer
//             attribution="Labels &copy; CARTO"
//             url="https://{s}://{z}/{x}/{y}{r}.png"
//             subdomains="abcd"
//             className="pp-tile-labels"
//           /> */}
//           <TileLayer
//              attribution='Tiles &copy; Esri &mdash; Source: Esri, Maxar, Earthstar Geographics &amp; the GIS User Community'
//              url="https://server.arcgisonline.com/ArcGIS/rest/services/World_Imagery/MapServer/tile/{z}/{y}/{x}"
//              className="pp-tile-imagery"
//            />
//            <TileLayer
//              attribution='Labels &copy; CARTO'
//              url="https://{s}.basemaps.cartocdn.com/dark_only_labels/{z}/{x}/{y}{r}.png"
//              subdomains="abcd"
//              className="pp-tile-labels"
//            />
//           <ZoomControl position="bottomleft" />
//           <FitOnce nodes={topology.nodes} />
//           <MapClickHandler onMapClick={handleMapClick} />

//           {topology.edges.map((e) => {
//             const a = nodeMap[e.source];
//             const b = nodeMap[e.target];
//             if (!a || !b) return null;

//             const key = `${e.source}|${e.target}`;
//             const live = edgeMetrics[key] || { latency: e.latency, traffic: e.traffic };
//             const isOptimal = optimalEdges.has(key);
//             const isAlt = altEdges.has(key) && !isOptimal;
//             const isAttacked = attackedIds.has(e.source) || attackedIds.has(e.target);

//             let color = "#9aa9be";
//             let weight = 1.5;
//             let opacity = 0.55;
//             let className = "";

//             if (isAttacked) {
//               color = "#ef4444";
//               weight = 1.5;
//               opacity = 0.55;
//               className = "pp-flow-attacked";
//             } else if (isAlt) {
//               color = "#f59e0b";
//               weight = 3;
//               opacity = 0.9;
//               className = "pp-flow-alt";
//             } else if (isOptimal) {
//               color = "#1f9d55";
//               weight = 5;
//               opacity = 1;
//               className = "pp-flow-optimal";
//             }

//             return (
//               <FlowPolyline
//                 key={`${key}-${className}`}
//                 positions={[[a.lat, a.lng], [b.lat, b.lng]]}
//                 color={color}
//                 weight={weight}
//                 opacity={opacity}
//                 className={className}
//               >
//                 <Tooltip sticky direction="top" className="pp-edge-tooltip">
//                   <strong>{a.name} ── {b.name}</strong>
//                   <br />
//                   latency: <b>{fmt(live.latency)} ms</b>
//                   <br />
//                   traffic: <b>{fmt(live.traffic, 0)}%</b>
//                 </Tooltip>
//               </FlowPolyline>
//             );
//           })}

//           {topology.nodes.map((n) => {
//             const isSrc = source === n.id;
//             const isDst = target === n.id;
//             const isAttk = attackedIds.has(n.id);
//             const kind = isAttk ? "attacked" : isSrc ? "src" : isDst ? "dst" : "node";
//             const label = n.name;
//             const traf = nodeTraffic[n.id];

//             return (
//               <Marker
//                 key={n.id}
//                 position={[n.lat, n.lng]}
//                 icon={nodeIcon(label, kind)}
//                 eventHandlers={{
//                   click: () => handleNodeClick(n.id),
//                 }}
//               >
//                 <Tooltip direction="top" offset={[0, -10]} className="pp-edge-tooltip">
//                   <div style={{ minWidth: 160 }}>
//                     <div>
//                       <strong>{n.name}</strong> ({n.id})
//                       {n.custom && " ★ Custom"}
//                     </div>
//                     <div style={{ fontSize: 10.5, color: "#4a5468", marginTop: 2 }}>
//                       {isAttk ? "⚠️ NODE INGESTION DISRUPTED" : isSrc ? "🔵 ACTIVE ROUTING ORIGIN" : isDst ? "🟣 DATA TRANSIT ENDPOINT" : "click to select"}
//                     </div>
//                     {typeof traf === "number" && (
//                       <div style={{ fontSize: 10.5, color: "#4a5468", marginTop: 2 }}>
//                         node traffic: <b>{fmt(traf, 0)}%</b>
//                       </div>
//                     )}
//                     {n.custom && (
//                       <button
//                         className="pp-btn danger-sm"
//                         style={{ marginTop: 6, fontSize: 10, padding: "3px 7px" }}
//                         onClick={(e) => {
//                           e.stopPropagation();
//                           removeNode(n.id);
//                         }}
//                       >
//                         Decommission Endpoint
//                       </button>
//                     )}
//                   </div>
//                 </Tooltip>
//               </Marker>
//             );
//           })}
//         </MapContainer>

//         <div className="pp-legend">
//           <div className="legend-title">Telemetry Index Channels</div>
//           <div><span className="sw" style={{ background: "#1f9d55" }} /> Primary Transit Channels</div>
//           <div><span className="sw" style={{ background: "#f59e0b" }} /> Alternative Backup Paths</div>
//           <div><span className="sw" style={{ background: "#9aa9be" }} /> Structural Edge Bounds</div>
//           <div><span className="sw" style={{ background: "#ef4444" }} /> Active Ingestion Overloads</div>
//           <div style={{ marginTop: 4, paddingTop: 6, borderTop: "1px dashed #d9e2ee" }}>
//             <span className="dot" style={{ background: "#2563eb" }} /> source &nbsp;
//             <span className="dot" style={{ background: "#a855f7" }} /> destination
//           </div>
//           <div className="muted" style={{ fontSize: 10.5, marginTop: 2 }}>
//             tip: click empty ocean / land to add a new data center
//           </div>
//         </div>

//         <div className="pp-overlay">
//           <h3>Selection &amp; DDoS</h3>
//           {!source && <p className="muted">Click any data center to set <b>source</b>.</p>}
//           {source && !target && (
//             <p>
//               Source: <b>{nodeMap[source]?.name}</b>
//               <br />
//               <span className="muted">Click another to set destination.</span>
//             </p>
//           )}
//           {source && target && (
//             <p>
//               <b>{nodeMap[source]?.name}</b> ➔ <b>{nodeMap[target]?.name}</b>
//             </p>
//           )}

//           <div className="pp-slider-block">
//             <div className="pp-slider-label">
//               <span>DDoS severity</span>
//               <span><b>{ddosSeverity}</b> ms</span>
//             </div>
//             <input
//               type="range"
//               min="50"
//               max="9999"
//               step="1"
//               value={ddosSeverity}
//               onChange={(e) => setDdosSeverity(Number(e.target.value))}
//             />
//           </div>

//           <div className="pp-slider-block">
//             <div className="pp-slider-label">
//               <span>Auto-heal duration</span>
//               <span>{ddosDuration === 0 ? "forever" : `${ddosDuration}s`}</span>
//             </div>
//             <input
//               type="range"
//               min="0"
//               max="60"
//               step="5"
//               value={ddosDuration}
//               onChange={(e) => setDdosDuration(Number(e.target.value))}
//             />
//           </div>

//           <div className="pp-row" style={{ marginTop: 8 }}>
//             <button
//               className="pp-btn danger"
//               disabled={!source}
//               onClick={() => source && injectDDoS(source)}
//             >
//               ⚡ DDoS source
//             </button>
//             <button
//               className="pp-btn danger"
//               disabled={!target}
//               onClick={() => target && injectDDoS(target)}
//             >
//               ⚡ DDoS target
//             </button>
//             <button
//               className="pp-btn"
//               disabled={attackedIds.size === 0}
//               onClick={() => attackedIds.forEach(clearDDoS)}
//             >
//               Clear ({attackedIds.size})
//             </button>
//           </div>
//         </div>

//         <aside className="pp-side">
//           <div className="pp-side-section">
//             <h2>Live network</h2>
//             <div className="pp-kpi">
//               <div><span>Avg latency</span><b className="link">{fmt(kpis.avgLatency)} ms</b></div>
//               <div><span>Avg traffic</span><b>{fmt(kpis.avgTraffic, 0)}%</b></div>
//               <div><span>Throughput</span><b className="accent">{fmt(kpis.throughput, 0)} Gbps</b></div>
//               <div><span>Under attack</span><b className={kpis.attacked ? "bad" : ""}>{kpis.attacked} Nodes</b></div>
//             </div>
//           </div>
//           {topology.nodes.some((n) => n.custom) && (
//         <div className="pp-side-section">
//           <h2>Your custom data centers</h2>
//           <div style={{ display: "flex", flexDirection: "column", gap: 6 }}>
//             {topology.nodes
//               .filter((n) => n.custom)
//               .map((n) => (
//                 <div
//                   key={n.id}
//                   style={{
//                     display: "flex",
//                     justifyContent: "space-between",
//                     alignItems: "center",
//                     padding: "6px 10px",
//                     background: "var(--panel-2)",
//                     border: "1px solid var(--line)",
//                     borderRadius: 8,
//                     fontSize: 12,
//                   }}
//                 >
//                   <span>
//                     <strong>{n.name}</strong> ({n.lat.toFixed(1)}°, {n.lng.toFixed(1)}°)
//                   </span>
//                   <button
//                     className="pp-btn"
//                     style={{ padding: "3px 8px", fontSize: 11 }}
//                     onClick={() => removeNode(n.id)}
//                   >
//                     remove
//                   </button>
//                 </div>
//               ))}
//           </div>
//         </div>
//       )}

//       {/* --- Routes Calculation Control Plane --- */}
//       <div className="pp-side-section" style={{ paddingBottom: 6 }}>
//         <h2>
//           Routes{" "}
//           {source && target
//             ? `${nodeMap[source]?.name?.toUpperCase()} ➔ ${nodeMap[target]?.name?.toUpperCase()}`
//             : ""}
//         </h2>
//         {!source || !target ? (
//           <div className="muted">
//             Pick a source then a destination on the map. Dijkstra k-shortest
//             paths re-rank every 3s using live latency &amp; traffic. The{" "}
//             <span style={{ color: "var(--accent)", fontWeight: 700 }}>
//               green flowing line on the map is the optimal route.
//             </span>
//           </div>
//         ) : (
//           <div className="muted">
//             {(routes?.paths?.length || 0)} alternative paths ranked by live
//             traffic + latency.
//           </div>
//         )}
//       </div>

//       {/* --- Computed Path Traversal Cards --- */}
//       <div className="pp-routes">
//         {routes?.paths?.map((p) => {
//           const cls = `pp-route-card ${p.rank === 1 ? "optimal" : ""} ${
//             p.blocked_by_attack ? "blocked" : ""
//           }`;
//           return (
//             <div key={p.rank} className={cls}>
//               <div className="pp-route-header">
//                 <span className="pp-route-rank">
//                   {p.rank === 1 ? "★ OPTIMAL" : `#${p.rank}`}
//                 </span>
//                 {p.blocked_by_attack && (
//                   <span style={{ fontSize: 11, color: "var(--bad)" }}>
//                     transit blocked
//                   </span>
//                 )}
//               </div>
//               <div className="pp-route-hops">
//                 {p.hops.map((h) => nodeMap[h]?.name || h).join(" ➔ ")}
//               </div>
//               <div className="pp-route-meta">
//                 <span>
//                   latency: <b>{fmt(p.total_latency)} ms</b>
//                 </span>
//                 <span>
//                   avg traffic: <b>{fmt(p.avg_traffic, 0)}%</b>
//                 </span>
//                 <span>
//                   peak: <b>{fmt(p.max_traffic, 0)}%</b>
//                 </span>
//                 <span>
//                   hops: <b>{p.hop_count}</b>
//                 </span>
//               </div>
//             </div>
//           );
//         })}
//       </div>

//       {/* --- Live Network Security Event Log Audit --- */}
//       <div className="pp-side-section">
//         <h2>Event log</h2>
//         <div className="pp-log">
//           {events.length === 0 ? (
//             <div className="pp-log-empty">
//               No events yet. Inject a DDoS or select two nodes.
//             </div>
//           ) : (
//             events
//               .slice()
//               .reverse()
//               .map((ev, i) => (
//                 <div key={i} className="pp-log-row">
//                   <span className={`log-badge ${ev.kind}`}>{ev.kind}</span>
//                   <span>{ev.message}</span>
//                 </div>
//               ))
//           )}
//         </div>
//       </div>
//     </aside>
//   </div>

//   {/* --- Provision New Edge Node Overlay Modal --- */}
//   {addNodePrompt && (
//     <div
//       className="pp-add-modal"
//       style={{ left: "50%", top: "30%", transform: "translateX(-50%)" }}
//     >
//       <h4>Add data center</h4>
//       <div className="muted" style={{ fontSize: 11, marginBottom: 6 }}>
//         {addNodePrompt.lat.toFixed(2)}°N, {addNodePrompt.lng.toFixed(2)}°E
//       </div>
//       <input
//         autoFocus
//         type="text"
//         placeholder="optional name (e.g. Bangalore)"
//         value={newNodeName}
//         onChange={(e) => setNewNodeName(e.target.value)}
//         onKeyDown={(e) => e.key === "Enter" && submitAddNode()}
//         className="modal-input"
//       />
//       <div className="pp-row">
//         <button className="pp-btn primary" onClick={submitAddNode}>
//           Add &amp; auto-link
//         </button>
//         <button
//           className="pp-btn ghost"
//           onClick={() => setAddNodePrompt(null)}
//         >
//           Cancel
//         </button>
//       </div>
//     </div>
//   )}
// </div>
// );
// }
# """
# PacketPulse — Real-time CDN routing & DDoS mitigation engine.
# """

# from __future__ import annotations

# import asyncio
# import json
# import logging
# import math
# import os
# import random
# import time
# import uuid
# from contextlib import asynccontextmanager
# from pathlib import Path
# from typing import Dict, List, Optional, Set, Tuple

# import networkx as nx
# from dotenv import load_dotenv
# from fastapi import APIRouter, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
# from pydantic import BaseModel
# from starlette.middleware.cors import CORSMiddleware

# ROOT_DIR = Path(__file__).parent
# load_dotenv(ROOT_DIR / ".env")

# logging.basicConfig(level=logging.INFO, format="%(asctime)s | %(levelname)s | %(message)s")
# log = logging.getLogger("packetpulse")


# # ---------------------------------------------------------------------------
# # Topology seed (real-world cities — geography, not hardcoded logic)
# # ---------------------------------------------------------------------------
# SEED_NODES: List[Dict] = [
#     {"id": "nyc", "name": "New York",      "lat": 40.7128,  "lng": -74.0060},
#     {"id": "sfo", "name": "San Francisco", "lat": 37.7749,  "lng": -122.4194},
#     {"id": "lax", "name": "Los Angeles",   "lat": 34.0522,  "lng": -118.2437},
#     {"id": "dal", "name": "Dallas",        "lat": 32.7767,  "lng": -96.7970},
#     {"id": "lon", "name": "London",        "lat": 51.5074,  "lng":  -0.1278},
#     {"id": "fra", "name": "Frankfurt",     "lat": 50.1109,  "lng":   8.6821},
#     {"id": "par", "name": "Paris",         "lat": 48.8566,  "lng":   2.3522},
#     {"id": "ams", "name": "Amsterdam",     "lat": 52.3676,  "lng":   4.9041},
#     {"id": "sng", "name": "Singapore",     "lat":  1.3521,  "lng": 103.8198},
#     {"id": "tok", "name": "Tokyo",         "lat": 35.6762,  "lng": 139.6503},
#     {"id": "syd", "name": "Sydney",        "lat": -33.8688, "lng": 151.2093},
#     {"id": "mum", "name": "Mumbai",        "lat": 19.0760,  "lng":  72.8777},
#     {"id": "sao", "name": "São Paulo",     "lat": -23.5505, "lng": -46.6333},
#     {"id": "cpt", "name": "Cape Town",     "lat": -33.9249, "lng":  18.4241},
# ]

# SEED_EDGES: List[Tuple[str, str]] = [
#     ("nyc", "sfo"), ("nyc", "dal"), ("nyc", "lon"), ("nyc", "par"), ("nyc", "sao"),
#     ("sfo", "lax"), ("sfo", "tok"), ("sfo", "syd"),
#     ("lax", "dal"), ("lax", "tok"),
#     ("dal", "sao"), ("dal", "lon"),
#     ("lon", "par"), ("lon", "ams"), ("lon", "fra"),
#     ("par", "fra"), ("par", "ams"),
#     ("fra", "ams"), ("fra", "mum"), ("fra", "cpt"),
#     ("ams", "sng"),
#     ("sng", "tok"), ("sng", "mum"), ("sng", "syd"),
#     ("tok", "syd"),
#     ("mum", "cpt"),
#     ("sao", "cpt"),
# ]


# def haversine_km(a: Dict, b: Dict) -> float:
#     R = 6371.0
#     lat1, lat2 = math.radians(a["lat"]), math.radians(b["lat"])
#     dlat = math.radians(b["lat"] - a["lat"])
#     dlng = math.radians(b["lng"] - a["lng"])
#     h = math.sin(dlat/2)**2 + math.cos(lat1)*math.cos(lat2)*math.sin(dlng/2)**2
#     return 2 * R * math.asin(math.sqrt(h))


# def base_latency(a: Dict, b: Dict) -> float:
#     # ~0.005ms/km baseline + 5ms switching overhead → realistic-ish CDN numbers
#     return round(5 + haversine_km(a, b) * 0.005, 2)


# # ---------------------------------------------------------------------------
# # Live network state
# # ---------------------------------------------------------------------------
# class NetworkState:
#     def __init__(self) -> None:
#         self.graph: nx.Graph = nx.Graph()
#         self.nodes_by_id: Dict[str, Dict] = {}
#         # node_id -> (severity_ms, expires_at_or_None)
#         self.attacked: Dict[str, Dict] = {}
#         self.event_log: List[Dict] = []
#         self._build()

#     def _build(self) -> None:
#         for n in SEED_NODES:
#             self.graph.add_node(n["id"], **n)
#             self.nodes_by_id[n["id"]] = n
#         for a, b in SEED_EDGES:
#             base = base_latency(self.nodes_by_id[a], self.nodes_by_id[b])
#             self.graph.add_edge(a, b, base=base, latency=base,
#                                 traffic=random.randint(20, 70))

#     # ----- live tick -----
#     def tick(self) -> Dict:
#         now = time.time()
#         # auto-heal expired attacks
#         expired = [nid for nid, info in self.attacked.items()
#                    if info.get("expires_at") and info["expires_at"] <= now]
#         for nid in expired:
#             self.attacked.pop(nid, None)
#             self._log("ddos_cleared",
#                       f"Auto-heal: {self.nodes_by_id[nid]['name']} recovered.")

#         edges_payload = []
#         total_traffic = 0.0
#         for u, v, data in self.graph.edges(data=True):
#             base = data["base"]
#             if u in self.attacked or v in self.attacked:
#                 sev = max(self.attacked.get(u, {}).get("severity", 0),
#                           self.attacked.get(v, {}).get("severity", 0))
#                 data["latency"] = sev or 9999.0
#                 data["traffic"] = random.randint(95, 100)
#             else:
#                 jitter = random.uniform(-6, 12)
#                 data["latency"] = round(max(5.0, base + jitter), 2)
#                 data["traffic"] = max(5, min(94, data["traffic"] + random.randint(-8, 9)))
#             total_traffic += data["traffic"]
#             edges_payload.append({
#                 "source": u, "target": v,
#                 "latency": data["latency"],
#                 "traffic": data["traffic"],
#                 "base": data["base"],
#             })

#         # node-level traffic: avg of incident edges (used for pulsing UI)
#         node_payload = []
#         for nid in self.nodes_by_id:
#             incident = list(self.graph.edges(nid, data=True))
#             if incident:
#                 t = sum(d["traffic"] for _, _, d in incident) / len(incident)
#             else:
#                 t = 0
#             node_payload.append({"id": nid, "traffic": round(t, 1)})

#         attacked_payload = [
#             {"id": nid,
#              "severity": info["severity"],
#              "expires_in": max(0, info["expires_at"] - now) if info.get("expires_at") else None}
#             for nid, info in self.attacked.items()
#         ]
#         return {
#             "type": "tick",
#             "edges": edges_payload,
#             "nodes": node_payload,
#             "attacked": attacked_payload,
#             "throughput": round(total_traffic, 1),
#         }

#     # ----- ops -----
#     def add_node(self, name: str, lat: float, lng: float) -> Dict:
#         nid = "x" + uuid.uuid4().hex[:5]
#         node = {"id": nid, "name": name or f"Node {nid[1:]}", "lat": lat, "lng": lng, "custom": True}
#         self.graph.add_node(nid, **node)
#         self.nodes_by_id[nid] = node
#         # auto-link to 3 nearest existing nodes (so it's reachable, no manual wiring)
#         others = [n for n in self.nodes_by_id.values() if n["id"] != nid]
#         others.sort(key=lambda o: haversine_km(node, o))
#         for o in others[:3]:
#             base = base_latency(node, o)
#             self.graph.add_edge(nid, o["id"], base=base, latency=base,
#                                 traffic=random.randint(20, 60))
#         self._log("node_added", f"New data center added: {node['name']} ({nid}) — auto-linked to 3 nearest peers.")
#         return node

#     def remove_node(self, node_id: str) -> None:
#         if node_id not in self.nodes_by_id:
#             raise KeyError(node_id)
#         if not self.nodes_by_id[node_id].get("custom"):
#             raise ValueError("seed nodes cannot be removed")
#         self.attacked.pop(node_id, None)
#         self.graph.remove_node(node_id)
#         name = self.nodes_by_id.pop(node_id)["name"]
#         self._log("node_removed", f"Data center removed: {name} ({node_id}).")

#     def inject_ddos(self, node_id: str, severity: float = 9999.0,
#                     duration: Optional[float] = None) -> None:
#         if node_id not in self.nodes_by_id:
#             raise KeyError(node_id)
#         expires_at = time.time() + duration if duration else None
#         self.attacked[node_id] = {"severity": float(severity), "expires_at": expires_at}
#         msg = (f"DDoS injected on {self.nodes_by_id[node_id]['name']} ({node_id}) — "
#                f"latency forced to {severity:.0f}ms"
#                + (f" (auto-heal in {duration:.0f}s)" if duration else ""))
#         self._log("ddos_injected", msg)

#     def clear_ddos(self, node_id: str) -> None:
#         if node_id in self.attacked:
#             self.attacked.pop(node_id, None)
#             self._log("ddos_cleared", f"DDoS cleared on {self.nodes_by_id[node_id]['name']} ({node_id})")

#     def _log(self, kind: str, message: str) -> None:
#         entry = {"kind": kind, "message": message, "ts": time.time()}
#         self.event_log.append(entry)
#         self.event_log = self.event_log[-200:]
#         log.info("EVENT %s | %s", kind, message)

#     # ----- routing -----
#     def compute_routes(self, source: str, target: str, k: int = 6) -> Dict:
#         if source not in self.nodes_by_id or target not in self.nodes_by_id:
#             raise KeyError("unknown node")
#         if source == target:
#             raise ValueError("source and target must differ")

#         try:
#             paths_gen = nx.shortest_simple_paths(self.graph, source, target, weight="latency")
#         except nx.NetworkXNoPath:
#             return {"source": source, "target": target, "paths": [], "optimal": None}

#         ranked: List[Dict] = []
#         for i, path in enumerate(paths_gen):
#             if i >= k:
#                 break
#             edges = list(zip(path[:-1], path[1:]))
#             total_latency = sum(self.graph[u][v]["latency"] for u, v in edges)
#             avg_traffic = round(sum(self.graph[u][v]["traffic"] for u, v in edges) / max(1, len(edges)), 1)
#             max_traffic = max((self.graph[u][v]["traffic"] for u, v in edges), default=0)
#             blocked = any(n in self.attacked for n in path[1:-1])
#             ranked.append({
#                 "rank": i + 1,
#                 "hops": path,
#                 "edges": [{"source": u, "target": v,
#                             "latency": self.graph[u][v]["latency"],
#                             "traffic": self.graph[u][v]["traffic"]} for u, v in edges],
#                 "total_latency": round(total_latency, 2),
#                 "avg_traffic": avg_traffic,
#                 "max_traffic": max_traffic,
#                 "hop_count": len(path) - 1,
#                 "blocked_by_attack": blocked,
#             })

#         def score(p):
#             penalty = 1e9 if p["blocked_by_attack"] else 0
#             return p["total_latency"] + p["avg_traffic"] * 0.8 + penalty
#         ranked.sort(key=score)
#         for idx, p in enumerate(ranked):
#             p["rank"] = idx + 1

#         optimal = ranked[0]["hops"] if ranked else None

#         self._log(
#             "route_computed",
#             f"Routed {self.nodes_by_id[source]['name']} → {self.nodes_by_id[target]['name']}: "
#             f"{len(ranked)} paths, optimal via {' → '.join(optimal) if optimal else 'N/A'}"
#         )
#         return {"source": source, "target": target, "paths": ranked, "optimal": optimal}

#     def snapshot(self) -> Dict:
#         now = time.time()
#         attacked_payload = [
#             {"id": nid,
#              "severity": info["severity"],
#              "expires_in": max(0, info["expires_at"] - now) if info.get("expires_at") else None}
#             for nid, info in self.attacked.items()
#         ]
#         return {
#             "nodes": list(self.nodes_by_id.values()),
#             "edges": [
#                 {"source": u, "target": v,
#                  "latency": d["latency"], "traffic": d["traffic"], "base": d["base"]}
#                 for u, v, d in self.graph.edges(data=True)
#             ],
#             "attacked": attacked_payload,
#             "events": self.event_log[-50:],
#         }


# STATE = NetworkState()


# # ---------------------------------------------------------------------------
# # WebSocket hub
# # ---------------------------------------------------------------------------
# class Hub:
#     def __init__(self) -> None:
#         self.clients: Set[WebSocket] = set()

#     async def connect(self, ws: WebSocket) -> None:
#         await ws.accept()
#         self.clients.add(ws)

#     def disconnect(self, ws: WebSocket) -> None:
#         self.clients.discard(ws)

#     async def broadcast(self, payload: Dict) -> None:
#         if not self.clients:
#             return
#         dead = []
#         data = json.dumps(payload)
#         for ws in list(self.clients):
#             try:
#                 await ws.send_text(data)
#             except Exception:
#                 dead.append(ws)
#         for ws in dead:
#             self.clients.discard(ws)


# HUB = Hub()


# async def streamer() -> None:
#     while True:
#         try:
#             payload = STATE.tick()
#             await HUB.broadcast(payload)
#         except Exception as e:
#             log.exception("streamer error: %s", e)
#         await asyncio.sleep(0.9)


# @asynccontextmanager
# async def lifespan(app: FastAPI):
#     task = asyncio.create_task(streamer())
#     log.info("PacketPulse streamer started")
#     yield
#     task.cancel()
#     log.info("PacketPulse streamer stopped")


# app = FastAPI(title="PacketPulse", lifespan=lifespan)
# api = APIRouter(prefix="/api")


# # ---------------------------------------------------------------------------
# # REST
# # ---------------------------------------------------------------------------
# class RouteRequest(BaseModel):
#     source: str
#     target: str
#     k: int = 6


# class NodeCreate(BaseModel):
#     name: Optional[str] = None
#     lat: float
#     lng: float


# @api.get("/")
# async def root():
#     return {"service": "PacketPulse", "status": "ok"}


# @api.get("/topology")
# async def topology():
#     return STATE.snapshot()


# @api.post("/nodes")
# async def create_node(req: NodeCreate):
#     if not (-90 <= req.lat <= 90) or not (-180 <= req.lng <= 180):
#         raise HTTPException(status_code=400, detail="invalid coordinates")
#     node = STATE.add_node(req.name or "", req.lat, req.lng)
#     await HUB.broadcast({"type": "topology_changed", **STATE.snapshot()})
#     return node


# @api.delete("/nodes/{node_id}")
# async def delete_node(node_id: str):
#     try:
#         STATE.remove_node(node_id)
#     except KeyError:
#         raise HTTPException(status_code=404, detail="unknown node")
#     except ValueError as e:
#         raise HTTPException(status_code=400, detail=str(e))
#     await HUB.broadcast({"type": "topology_changed", **STATE.snapshot()})
#     return {"ok": True}


# @api.post("/ddos/{node_id}")
# async def ddos(node_id: str,
#                severity: float = Query(9999.0, ge=50, le=9999),
#                duration: Optional[float] = Query(None, ge=1, le=120)):
#     try:
#         STATE.inject_ddos(node_id, severity=severity, duration=duration)
#     except KeyError:
#         raise HTTPException(status_code=404, detail=f"unknown node '{node_id}'")
#     await HUB.broadcast({"type": "event",
#                           "attacked": [{"id": nid, "severity": info["severity"],
#                                          "expires_in": max(0, info["expires_at"] - time.time()) if info.get("expires_at") else None}
#                                         for nid, info in STATE.attacked.items()],
#                           "event": STATE.event_log[-1]})
#     return {"ok": True}


# @api.post("/ddos/{node_id}/clear")
# async def ddos_clear(node_id: str):
#     STATE.clear_ddos(node_id)
#     await HUB.broadcast({"type": "event",
#                           "attacked": [{"id": nid, "severity": info["severity"],
#                                          "expires_in": max(0, info["expires_at"] - time.time()) if info.get("expires_at") else None}
#                                         for nid, info in STATE.attacked.items()],
#                           "event": STATE.event_log[-1] if STATE.event_log else None})
#     return {"ok": True}


# @api.post("/route")
# async def route(req: RouteRequest):
#     try:
#         result = STATE.compute_routes(req.source, req.target, k=max(1, min(req.k, 8)))
#     except KeyError:
#         raise HTTPException(status_code=404, detail="unknown node")
#     except ValueError as e:
#         raise HTTPException(status_code=400, detail=str(e))
#     await HUB.broadcast({"type": "event", "event": STATE.event_log[-1]})
#     return result


# @api.post("/scenario/demo")
# async def scenario_demo():
#     """Run a scripted DDoS scenario (background task).
#     Sequence: pick LON, inject 9999ms attack for 12s → auto-heal."""
#     target = "lon"
#     if target not in STATE.nodes_by_id:
#         target = next(iter(STATE.nodes_by_id))
#     STATE.inject_ddos(target, severity=9999, duration=12)
#     await HUB.broadcast({"type": "event",
#                           "attacked": [{"id": nid, "severity": info["severity"],
#                                          "expires_in": info["expires_at"] - time.time() if info.get("expires_at") else None}
#                                         for nid, info in STATE.attacked.items()],
#                           "event": STATE.event_log[-1]})
#     return {"ok": True, "scenario": "ddos_london_12s"}


# @api.get("/events")
# async def events():
#     return {"events": STATE.event_log[-100:]}


# @api.websocket("/ws/stream")
# async def ws_stream(websocket: WebSocket):
#     await HUB.connect(websocket)
#     await websocket.send_text(json.dumps({"type": "snapshot", **STATE.snapshot()}))
#     try:
#         while True:
#             await websocket.receive_text()
#     except WebSocketDisconnect:
#         HUB.disconnect(websocket)
#     except Exception:
#         HUB.disconnect(websocket)


# app.include_router(api)

# app.add_middleware(
#     CORSMiddleware,
#     allow_origins=os.environ.get("CORS_ORIGINS", "*").split(","),
#     allow_credentials=True,
#     allow_methods=["*"],
#     allow_headers=["*"],
# )







































"""
PacketPulse - Core Real-Time Content Delivery Network (CDN) Latency Router 
& Anaylytical Traffic Flow Coordination Pipeline Engine.
"""

from __future__ import annotations
import asyncio
import json
import logging
import math
import os
import random
import time
import uuid
from contextlib import asynccontextmanager
from pathlib import Path
from typing import Dict, List, Optional, Set, Tuple

import networkx as nx
from dotenv import load_dotenv
from fastapi import APIRouter, FastAPI, HTTPException, Query, WebSocket, WebSocketDisconnect
from pydantic import BaseModel
from starlette.middleware.cors import CORSMiddleware

# Initialize Local Environment Path Matrix
ROOT_DIR = Path(__file__).parent
load_dotenv(ROOT_DIR / ".env")

# Standardized System Logging Core Configurations
logging.basicConfig(
    level=logging.INFO, 
    format="%(asctime)s │ %(levelname)s │ %(message)s"
)
logger = logging.getLogger("packetpulse")

# Global Network Infrastructure Geolocation Presets
SEED_NODES: List[Dict] = [
    {"id": "nyc", "name": "New York", "lat": 40.7128, "lng": -74.0060},
    {"id": "sfo", "name": "San Francisco", "lat": 37.7749, "lng": -122.4194},
    {"id": "lax", "name": "Los Angeles", "lat": 34.0522, "lng": -118.2437},
    {"id": "dal", "name": "Dallas", "lat": 32.7767, "lng": -96.7970},
    {"id": "lon", "name": "London", "lat": 51.5074, "lng": -0.1278},
    {"id": "fra", "name": "Frankfurt", "lat": 50.1109, "lng": 8.6821},
    {"id": "par", "name": "Paris", "lat": 48.8566, "lng": 2.3522},
    {"id": "ams", "name": "Amsterdam", "lat": 52.3676, "lng": 4.9041},
    {"id": "sng", "name": "Singapore", "lat": 1.3521, "lng": 103.8198},
    {"id": "tok", "name": "Tokyo", "lat": 35.6762, "lng": 139.6503},
    {"id": "syd", "name": "Sydney", "lat": -33.8688, "lng": 151.2093},
    {"id": "mum", "name": "Mumbai", "lat": 19.0760, "lng": 72.8777},
    {"id": "sao", "name": "São Paulo", "lat": -23.5505, "lng": -46.6333},
    {"id": "cpt", "name": "Cape Town", "lat": -33.9249, "lng": 18.4241}
]

SEED_EDGES: List[Tuple[str, str]] = [
    ("nyc", "sfo"), ("nyc", "dal"), ("nyc", "lon"), ("nyc", "par"), ("nyc", "sao"),
    ("sfo", "lax"), ("sfo", "tok"), ("sfo", "syd"),
    ("lax", "dal"), ("lax", "tok"),
    ("dal", "sao"), ("dal", "lon"),
    ("lon", "par"), ("lon", "ams"), ("lon", "fra"),
    ("par", "fra"), ("par", "ams"),
    ("fra", "ams"), ("fra", "mum"), ("fra", "cpt"),
    ("ams", "sng"),
    ("sng", "tok"), ("sng", "mum"), ("sng", "syd"),
    ("tok", "syd"),
    ("mum", "cpt"),
    ("sao", "cpt")
]

def haversine_km(a: Dict, b: Dict) -> float:
    """Computes genuine geographical distance using the Haversine mathematical algorithm."""
    R = 6371.0
    lat1, lat2 = math.radians(a["lat"]), math.radians(b["lat"])
    dlat = math.radians(b["lat"] - a["lat"])
    dlng = math.radians(b["lng"] - a["lng"])
    h = math.sin(dlat / 2)**2 + math.cos(lat1) * math.cos(lat2) * math.sin(dlng / 2)**2
    return 2 * R * math.asin(math.sqrt(max(0.0, h)))

def base_latency(a: Dict, b: Dict) -> float:
    """Calculates realistic CDN switching thresholds baseline latency parameters."""
    return round(5.0 + haversine_km(a, b) * 0.005, 2)

class NetworkState:
    """Maintains active real-time operational state metrics across the CDN layout grid."""
    def __init__(self) -> None:
        self.graph: nx.Graph = nx.Graph()
        self.nodes_by_id: Dict[str, Dict] = {}
        self.attacked: Dict[str, Dict] = {}
        self.event_log: List[Dict] = []
        self._build_topology()

    def _build_topology(self) -> None:
        for n in SEED_NODES:
            self.graph.add_node(n["id"], **n)
            self.nodes_by_id[n["id"]] = n
        for a, b in SEED_EDGES:
            base = base_latency(self.nodes_by_id[a], self.nodes_by_id[b])
            self.graph.add_edge(
                a, b, base=base, latency=base, 
                traffic=float(random.randint(20, 70))
            )

    def _log(self, kind: str, message: str) -> None:
        entry = {"kind": kind, "message": message, "ts": time.time()}
        self.event_log.append(entry)
        self.event_log = self.event_log[-200:]
        logger.info(f"[{kind.upper()}] {message}")

    def tick(self) -> Dict:
        """Triggers a dynamic hardware transaction pulse cycle sweep across all pipes."""
        now = time.time()
        expired = [nid for nid, info in self.attacked.items() if info.get("expires_at") and info["expires_at"] <= now]
        
        for nid in expired:
            self.attacked.pop(nid, None)
            self._log("ddos_cleared", f"Auto-heal routine finished: Data center {self.nodes_by_id[nid]['name']} completely recovered.")

        edges_payload = []
        total_traffic = 0.0

        for u, v, data in self.graph.edges(data=True):
            base = data["base"]
            if u in self.attacked or v in self.attacked:
                sev = max(self.attacked.get(u, {}).get("severity", 0.0), self.attacked.get(v, {}).get("severity", 0.0))
                data["latency"] = sev or 9999.0
                data["traffic"] = float(random.randint(95, 100))
            else:
                jitter = random.uniform(-6.0, 12.0)
                data["latency"] = round(max(5.0, base + jitter), 2)
                data["traffic"] = float(max(5, min(94, int(data["traffic"]) + random.randint(-8, 9))))
            
            total_traffic += data["traffic"]
            edges_payload.append({
                "source": u, "target": v,
                "latency": data["latency"], "traffic": data["traffic"], "base": data["base"]
            })

        node_payload = []
        for nid in self.nodes_by_id:
            incident = list(self.graph.edges(nid, data=True))
            t = sum(d["traffic"] for _, _, d in incident) / max(1, len(incident)) if incident else 0.0
            node_payload.append({"id": nid, "traffic": round(t, 1)})

        attacked_payload = [
            {
                "id": nid, "severity": info["severity"],
                "expires_in": max(0.0, info["expires_at"] - now) if info.get("expires_at") else None
            }
            for nid, info in self.attacked.items()
        ]

        return {
            "type": "tick",
            "edges": edges_payload,
            "nodes": node_payload,
            "attacked": attacked_payload,
            "throughput": round(total_traffic, 1)
        }

    def add_node(self, name: str, lat: float, lng: float) -> Dict:
        nid = "x" + uuid.uuid4().hex[:5]
        node = {"id": nid, "name": name or f"Node_{nid[1:]}", "lat": lat, "lng": lng, "custom": True}
        self.graph.add_node(nid, **node)
        self.nodes_by_id[nid] = node

        others = [n for n in self.nodes_by_id.values() if n["id"] != nid]
        others.sort(key=lambda o: haversine_km(node, o))
        for o in others[:3]:
            base = base_latency(node, o)
            self.graph.add_edge(nid, o["id"], base=base, latency=base, traffic=float(random.randint(20, 60)))
        
        self._log("node_added", f"New core telemetry point registered: {node['name']} auto-linked to 3 nearest peers.")
        return node

    def remove_node(self, node_id: str) -> None:
        if node_id not in self.nodes_by_id:
            raise KeyError(node_id)
        if not self.nodes_by_id[node_id].get("custom"):
            raise ValueError("Seed nodes are structural constants and cannot be removed.")
        self.attacked.pop(node_id, None)
        self.graph.remove_node(node_id)
        name = self.nodes_by_id.pop(node_id)["name"]
        self._log("node_removed", f"Data center decommissioned out of routing registry: {name} ({node_id})")

    def inject_ddos(self, node_id: str, severity: float = 9999.0, duration: Optional[float] = None) -> None:
        if node_id not in self.nodes_by_id:
            raise KeyError(node_id)
        expires_at = time.time() + duration if duration else None
        self.attacked[node_id] = {"severity": float(severity), "expires_at": expires_at}
        msg = f"Traffic surge vector active on data center: {self.nodes_by_id[node_id]['name']}. Latency forced to {severity:.0f}ms."
        if duration:
            msg += f" (Auto-healing script engaged for {duration:.0f}s)"
        self._log("ddos_injected", msg)

    def clear_ddos(self, node_id: str) -> None:
        if node_id in self.attacked:
            self.attacked.pop(node_id, None)
            self._log("ddos_cleared", f"DDoS mitigation scripts complete. Anomalies resolved on node {self.nodes_by_id[node_id]['name']}.")

    def compute_routes(self, source: str, target: str, k: int = 6) -> Dict:
        if source not in self.nodes_by_id or target not in self.nodes_by_id:
            raise KeyError("Unknown network nodes mapping request points.")
        if source == target:
            raise ValueError("Source and destination endpoints must differ.")

        try:
            paths_gen = nx.shortest_simple_paths(self.graph, source, target, weight="latency")
        except nx.NetworkXNoPath:
            return {"source": source, "target": target, "paths": [], "optimal": None}

        ranked: List[Dict] = []
        try:
            all_paths = []
            for i, path in enumerate(paths_gen):
                if i >= k:
                    break
                all_paths.append(path)
        except nx.NetworkXNoPath:
            return {"source": source, "target": target, "paths": [], "optimal": None}
        for i, path in enumerate(all_paths):
            edges = list(zip(path[:-1], path[1:]))
            total_latency = sum(self.graph[u][v]["latency"] for u, v in edges)
            avg_traffic = round(sum(self.graph[u][v]["traffic"] for u, v in edges) / max(1, len(edges)), 1)
            max_traffic = max((self.graph[u][v]["traffic"] for u, v in edges), default=0.0)
            blocked = any(n in self.attacked for n in path[1:-1])

            ranked.append({
                "rank": i + 1,
                "hops": path,
                "edges": [
                    {
                        "source": u,
                        "target": v,
                        "latency": self.graph[u][v]["latency"],
                        "traffic": self.graph[u][v]["traffic"]
                    }
                    for u, v in edges
                ],
                "total_latency": round(total_latency, 2),
                "avg_traffic": avg_traffic,
                "max_traffic": max_traffic,
                "hop_count": len(path) - 1,
                "blocked_by_attack": blocked
            })

        def score(p):
            penalty = 1e9 if p["blocked_by_attack"] else 0.0
            return p["total_latency"] + p["avg_traffic"] * 0.8 + penalty

        ranked.sort(key=score)
        for idx, p in enumerate(ranked):
            p["rank"] = idx + 1

        optimal = ranked[0]["hops"] if ranked else None
        self._log(
            "route_computed",
            f"Optimized multi-path calculated: {self.nodes_by_id[source]['name']} -> {self.nodes_by_id[target]['name']} via {' -> '.join(optimal) if optimal else 'N/A'}"
        )
        return {"source": source, "target": target, "paths": ranked, "optimal": optimal}
    def snapshot(self) -> Dict:
        now = time.time()
        attacked_payload = [
            {
                "id": nid,
                "severity": info["severity"],
                "expires_in": max(0.0, info["expires_at"] - now) if info.get("expires_at") else None
            }
            for nid, info in self.attacked.items()
        ]
        return {
            "nodes": list(self.nodes_by_id.values()),
            "edges": [
                {
                    "source": u, 
                    "target": v, 
                    "latency": d["latency"], 
                    "traffic": d["traffic"], 
                    "base": d["base"]
                } 
                for u, v, d in self.graph.edges(data=True)
            ],
            "attacked": attacked_payload,
            "events": self.event_log[-50:]
        }

# --- Initialize Instance Singletons ---
STATE = NetworkState()

class Hub:
    """Manages full asynchronous real-time client socket connection streams."""
    def __init__(self) -> None:
        self.clients: Set[WebSocket] = set()

    async def connect(self, ws: WebSocket) -> None:
        await ws.accept()
        self.clients.add(ws)

    def disconnect(self, ws: WebSocket) -> None:
        self.clients.discard(ws)

    async def broadcast(self, payload: Dict) -> None:
        if not self.clients:
            return
        dead = []
        data = json.dumps(payload)
        for ws in list(self.clients):
            try:
                await ws.send_text(data)
            except Exception:
                dead.append(ws)
        for ws in dead:
            self.clients.discard(ws)

HUB = Hub()

async def streamer() -> None:
    """Asynchronous infinite looping ticker to broadcast live edge statistics."""
    while True:
        try:
            payload = STATE.tick()
            await HUB.broadcast(payload)
        except Exception as e:
            logger.exception("Telemetry streaming core cycle loop encountered fault: %s", e)
        await asyncio.sleep(0.9)

@asynccontextmanager
async def lifespan(app: FastAPI):
    task = asyncio.create_task(streamer())
    logger.info("PacketPulse engine real-time background tracking stream task initialized.")
    yield
    task.cancel()
    logger.info("PacketPulse background monitoring streaming instances cleanly shutdown.")

app = FastAPI(title="PacketPulse Pipeline", lifespan=lifespan)
api = APIRouter(prefix="/api")

# --- Pydantic Structural Contract Layout Models ---
class RouteRequest(BaseModel):
    source: str
    target: str
    k: int = 6

class NodeCreate(BaseModel):
    name: Optional[str] = None
    lat: float
    lng: float

# --- Core REST Controller Routines Routing Channels ---
@api.get("/")
async def root():
    return {"service": "PacketPulse Analytics Core", "status": "operational"}

@api.get("/topology")
async def topology():
    return STATE.snapshot()

@api.post("/nodes")
async def create_node(req: NodeCreate):
    if not (-90.0 <= req.lat <= 90.0) or not (-180.0 <= req.lng <= 180.0):
        raise HTTPException(status_code=400, detail="Invalid coordinates matrix layout bounds input variables.")
    node = STATE.add_node(req.name or "", req.lat, req.lng)
    await HUB.broadcast({"type": "topology_changed", **STATE.snapshot()})
    return node

@api.delete("/nodes/{node_id}")
async def delete_node(node_id: str):
    try:
        STATE.remove_node(node_id)
    except KeyError:
        raise HTTPException(status_code=404, detail="Target point node tracker ID not recognized.")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await HUB.broadcast({"type": "topology_changed", **STATE.snapshot()})
    return {"ok": True}

@api.post("/ddos/{node_id}")
async def inject_ddos(
    node_id: str,
    severity: float = Query(9999.0, ge=50.0, le=9999.0),
    duration: Optional[float] = Query(None, ge=1.0, le=120.0)
):
    try:
        STATE.inject_ddos(node_id, severity=severity, duration=duration)
    except KeyError:
        raise HTTPException(status_code=404, detail=f"Target node identifier '{node_id}' does not exist inside state logs.")
    
    current_attack_payload = [
        {
            "id": nid, "severity": info["severity"],
            "expires_in": max(0.0, info["expires_at"] - time.time()) if info.get("expires_at") else None
        }
        for nid, info in STATE.attacked.items()
    ]
    await HUB.broadcast({"type": "event", "attacked": current_attack_payload, "event": STATE.event_log[-1]})
    return {"ok": True}

@api.post("/ddos/{node_id}/clear")
async def ddos_clear(node_id: str):
    STATE.clear_ddos(node_id)
    current_attack_payload = [
        {
            "id": nid, "severity": info["severity"],
            "expires_in": max(0.0, info["expires_at"] - time.time()) if info.get("expires_at") else None
        }
        for nid, info in STATE.attacked.items()
    ]
    await HUB.broadcast({
        "type": "event", 
        "attacked": current_attack_payload, 
        "event": STATE.event_log[-1] if STATE.event_log else None
    })
    return {"ok": True}

@api.post("/route")
async def route(req: RouteRequest):
    try:
        result = STATE.compute_routes(req.source, req.target, k=max(1, min(req.k, 8)))
    except KeyError:
        raise HTTPException(status_code=404, detail="Target tracking configuration path points not found inside state logs.")
    except ValueError as e:
        raise HTTPException(status_code=400, detail=str(e))
    await HUB.broadcast({"type": "event", "event": STATE.event_log[-1]})
    return result

@api.post("/scenario/demo")
async def scenario_demo():
    """Triggers an automated scripted DDoS network surge pattern scenario task."""
    # target = "lon"
    # if target not in STATE.nodes_by_id:
    #     target = next(iter(STATE.nodes_by_id))
    import random
    target = random.choice(list(STATE.nodes_by_id.keys()))
    STATE.inject_ddos(target, severity=9999.0, duration=12.0)
    current_attack_payload = [
        {
            "id": nid, "severity": info["severity"],
            "expires_in": max(0.0, info["expires_at"] - time.time()) if info.get("expires_at") else None
        }
        for nid, info in STATE.attacked.items()
    ]
    await HUB.broadcast({"type": "event", "attacked": current_attack_payload, "event": STATE.event_log[-1]})
    return {"ok": True, "scenario": "ddos_london_12s"}

@api.get("/events")
async def events():
    return {"events": STATE.event_log[-100:]}

# --- Multi-Tenant Asynchronous WebSocket Handler Core ---
@api.websocket("/ws/stream")
async def ws_stream(websocket: WebSocket):
    await HUB.connect(websocket)
    await websocket.send_text(json.dumps({"type": "snapshot", **STATE.snapshot()}))
    try:
        while True:
            await websocket.receive_text()
    except WebSocketDisconnect:
        HUB.disconnect(websocket)
    except Exception:
        HUB.disconnect(websocket)

# Mount Routers and Middleware Matrices Settings
app.include_router(api)


ALLOWED_LOCAL_ORIGINS = [
    "http://localhost:3000",
    "http://127.0.0.1:3000",
    "http://localhost:5173",
    "http://127.0.0.1:5173"
]

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)
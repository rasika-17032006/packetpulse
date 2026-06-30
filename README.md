# PacketPulse: Global CDN Routing and DDoS Mitigation Telemetry Plane 
 
## System Architectural Blueprint 
PacketPulse is an interactive network telemetry orchestrator that visualizes real-time geographical traffic engineering. By implementing dynamic graph-traversal route planning, the system maps optimal transit channels across continents while exposing manual and scripted traffic disruption vectors to evaluate network resilience under live stress conditions. 
 
## Key Engineering Features 
* **Dynamic Optimal Route Selection:** Employs real-time pathfinding algorithms to compute and visualize optimal global routing paths across data center nodes. 
* **Interactive Congestion Mitigation:** Dynamically re-routes active data streams around congested pipelines or offline infrastructure layers to maintain high system throughput. 
* **Scripted Traffic Disruption Vectors:** Features an automated simulation script that targets nodes to trigger localized congestion anomalies and analyze real-time path adaptation. 
* **Polished Telemetry Dashboard:** Renders real-time operational feeds, network health indicators, and live event logs to track traffic shifts instantly. 
 
## Production Infrastructure Stack 
* **Core Traffic Controller:** Python 3 Core Telemetry Routing Engine with FastAPI Loops 
* **Geographical Network Interface:** Interactive React Map Canvas with Custom Status Layers 
* **Cross-Origin Pipeline Ingestion:** Synchronized Client-Server Telemetry Ingestion Over REST 
 
## System Topography Map 
* `/backend` - Manages node coordinate configurations, traffic simulation macros, and routing plane computations. 
* `/frontend` - Renders real-time map views, active traffic pipeline beams, and real-time operational feed badges.

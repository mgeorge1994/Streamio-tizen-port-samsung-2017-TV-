# Stremio Native v1.0.43 — engine now mirrors the Android TV streaming server

Source of truth: `decoded/assets/server.js` from the official Android TV APK (v1.10.4).
Its torrent engine is Stremio's fork of **torrent-stream** (Node), NOT libtorrent.
Ported to `app-native/nacl/src/torrent_engine.cc` (runs 100% on the TV, no laptop, no Node):

| Android (torrent-stream / enginefs)              | v1.0.43                                   |
|--------------------------------------------------|-------------------------------------------|
| Requests only pieces the peer has (peerPieces)   | BITFIELD/HAVE tracked, `peerHas()`        |
| getRequestsNumber(): 50 → 5 by unchoked count    | `requestDepth()` same formula             |
| Selection walks pieces in order from read head   | next 8 missing pieces from read head      |
| critical = first ~1 MB, hotswap from slow peers  | `hotswapPiece()` (+ CANCEL to slow peer)  |
| rank(): slow peers yield to faster ones          | `rankOk()` same rule, SPEED_THRESHOLD     |
| 4 s request timeout destroys silent wire         | wire timeout 4 s (last proven peer kept)  |
| unproven wire: 1 request from selection end      | same                                      |
| choke → requests failed & re-queued              | `releaseRequests()` on CHOKE              |
| async I/O                                        | handshakes on threads; socket drain loop  |
| 35 connections                                   | kMaxPeers 35                              |
| peerSearch: 20 default trackers + stream sources + DHT, parallel, min 40 / max 150 | same list, parallel announce threads, BEP 5 DHT get_peers, min 40 / max 150 |

Also fixed: 16 KiB-per-pass read cap + 100 ms connect poll (~300 KB/s ceiling),
blocking handshake that could hang forever on a silent peer, ut_metadata
request spam (hundreds/s), cache eviction that collapsed read-ahead after 64 pieces,
re-announces that blocked the download loop, 12 s of self-tests before discovery.

Local tests (VM loopback, realistic swarm: 150 ms latency, 30 dead peers,
stalled/empty/slow peers): v1.0.43 first byte 4.1 s, 720 KB/s (≈90% of the
swarm's capacity), data verified. v1.0.42 under the same conditions: froze on
the first dead peer, 0 bytes.

New /stats fields: depth, hotswaps, wireTimeouts, noBitfield, hsThreads, pending,
peerSpeeds, trackers, trackerPeers, dhtNodes, dhtQueries, dhtResponses, dhtPeers.

Backup of v1.0.42 engine: `backups/torrent_engine.v1041.cc`.
Build/install: `bash tools/deploy.sh` (macOS Terminal; version read from config.xml).

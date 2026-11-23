// On-device torrent engine for Samsung Tizen NaCl.
//
// Design goal: behave like the streaming server Stremio bundles on Android TV,
// but inside the Tizen web widget. It discovers peers over UDP trackers,
// downloads the requested file over the BitTorrent peer-wire protocol, and
// exposes it as a local HTTP endpoint with Range support so the existing
// <video> player can play it with no external machine involved.
//
// Network API: POSIX sockets provided by nacl_io (initialised by the PPAPI
// instance in engine_instance.cc). This keeps the protocol code portable and
// avoids hand-writing async PPAPI state machines.
#include "bencode.h"
#include "sha1.h"

#include <arpa/inet.h>
#include <ctype.h>
#include <errno.h>
#include <fcntl.h>
#include <netdb.h>
#include <netinet/in.h>
#include <poll.h>
#include <pthread.h>
#include <stdint.h>
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <sys/socket.h>
#include <sys/time.h>
#include <unistd.h>

#include <algorithm>
#include <map>
#include <set>
#include <sstream>
#include <string>
#include <vector>

namespace stremio {
namespace engine {

static const int kPiecesPerWindow = 64;   // sliding cache: ~16 MB at 256 KB/piece
static const int kMaxPeers = 35;          // enginefs btMaxConnections
static const int kBlockSize = 16384;
// Scheduler constants taken from Stremio's torrent-stream fork -- the download
// engine inside the official Android TV app (decoded/assets/server.js).
static const uint32_t kSpeedThreshold = 3 * 16384;  // SPEED_THRESHOLD: 3 blocks/s
static const uint64_t kWireTimeoutMs = 4000;        // btRequestTimeout: silent wire is dropped
static const int kSelectAhead = 8;        // missing pieces scheduled ahead of the read head
static const int kMaxHsThreads = 24;      // concurrent handshake threads
static const uint64_t kHsWatchdogMs = 12000;  // abandon a handshake stuck this long
static const int kMinPeers = 40;         // enginefs peerSearch.min: keep searching below this
static const int kMaxQueuedPeers = 150;  // enginefs peerSearch.max
static const uint16_t kHttpPort = 11470;

// ---------------------------------------------------------------------------
// small helpers
// ---------------------------------------------------------------------------
static std::string itoa(int v);
std::string statsJson();
struct Peer;
static void sendInterested(Peer* p);

static uint64_t nowMs() {
  struct timeval tv; gettimeofday(&tv, 0);
  return (uint64_t)tv.tv_sec * 1000 + tv.tv_usec / 1000;
}
static int g_hsRecvBytes = 0, g_hsZeroReads = 0;
static int g_curHsRx = 0, g_curHsZero = 0;
static int g_curSendOk = 0, g_curSendErr = 0;
static int g_curFirstRecv = 0, g_curFirstRecvErr = 0, g_curSoErr = 0;
static std::string be32(uint32_t v) {
  char b[4];
  b[0] = (char)(v >> 24); b[1] = (char)(v >> 16);
  b[2] = (char)(v >> 8);  b[3] = (char)v;
  return std::string(b, 4);
}
static std::string be64(uint64_t v) {
  char b[8];
  for (int i = 0; i < 8; i++) b[i] = (char)(v >> (56 - 8 * i));
  return std::string(b, 8);
}
static uint32_t rd32(const char* p) {
  return ((uint32_t)(unsigned char)p[0] << 24) | ((uint32_t)(unsigned char)p[1] << 16) |
         ((uint32_t)(unsigned char)p[2] << 8) | (uint32_t)(unsigned char)p[3];
}
static bool hexBytes(const std::string& hex, uint8_t out[20]) {
  if (hex.size() != 40) return false;
  for (int i = 0; i < 20; i++) {
    unsigned int v = 0;
    if (sscanf(hex.c_str() + i * 2, "%2x", &v) != 1) return false;
    out[i] = (uint8_t)v;
  }
  return true;
}
static bool setNonblocking(int fd) {
  int flags = fcntl(fd, F_GETFL, 0);
  if (flags < 0) return false;
  return fcntl(fd, F_SETFL, flags | O_NONBLOCK) == 0;
}
static bool waitFd(int fd, short events, int timeoutMs) {
  struct pollfd p; p.fd = fd; p.events = events; p.revents = 0;
  errno = 0;
  int r = poll(&p, 1, timeoutMs);
  if (r > 0 && (p.revents & events)) return true;
  // Report a real reason instead of leaving a stale EINPROGRESS from connect().
  if (r == 0) errno = 110;                    // ETIMEDOUT
  else if (r < 0 && errno == 0) errno = 111;  // poll failed
  else if (r > 0) errno = 112;                // POLLERR / POLLHUP, no requested event
  return false;
}
// Spin-based I/O. nacl_io's poll() reports sticky POLLIN/POLLOUT bits that do
// not reliably reflect FIFO state, so polling before recv() often yields a
// false readiness followed by recv()==0. Retrying recv()/send() directly with a
// short sleep is robust and avoids poll() entirely.
static bool recvExact(int fd, char* buf, size_t len, int timeoutMs) {
  size_t got = 0;
  bool first = true;
  uint64_t deadline = nowMs() + (uint64_t)timeoutMs;
  while (got < len && nowMs() < deadline) {
    errno = 0;
    ssize_t n = recv(fd, buf + got, len - got, 0);
    if (first) { g_curFirstRecv = (int)n; g_curFirstRecvErr = errno; first = false; }
    if (n > 0) { got += (size_t)n; g_hsRecvBytes += (int)n; g_curHsRx += (int)n; continue; }
    // nacl_io returns 0 for an empty FIFO even when a stale POLLIN bit is set.
    // Treat it as "not yet" and retry; a real close just costs the timeout.
    if (n == 0) { g_hsZeroReads++; g_curHsZero++; usleep(10000); continue; }
    if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK || errno == EINPROGRESS) {
      usleep(10000); continue;
    }
    return false;
  }
  if (got < len) { errno = 110; return false; }
  return true;
}
static bool sendAllFor(int fd, const char* buf, size_t len, int timeoutMs) {
  size_t sent = 0;
  uint64_t deadline = nowMs() + (uint64_t)timeoutMs;
  while (sent < len && nowMs() < deadline) {
    ssize_t n = send(fd, buf + sent, len - sent, 0);
    if (n > 0) { sent += (size_t)n; continue; }
    if (n == 0) { errno = 91; return false; }
    if (errno == EINTR || errno == EAGAIN || errno == EWOULDBLOCK || errno == EINPROGRESS) {
      usleep(10000); continue;
    }
    return false;
  }
  if (sent < len) { errno = 110; return false; }
  return true;
}

static bool sendAll(int fd, const char* buf, size_t len) { return sendAllFor(fd, buf, len, 8000); }

// Temporary crash tracing: send a small HTTP POST to the development PC.
static void __attribute__((unused)) ctrace(const char* tag, int a = 0, int b = 0, int c = 0) {
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) return;
  setNonblocking(fd);
  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = htons(8877);
  addr.sin_addr.s_addr = inet_addr("192.168.0.136");
  int rc = connect(fd, (struct sockaddr*)&addr, sizeof(addr));
  bool connected = (rc == 0);
  if (!connected && (errno == EINPROGRESS || errno == EALREADY)) {
    socklen_t sl = sizeof(rc);
    connected = waitFd(fd, POLLOUT, 300) &&
                getsockopt(fd, SOL_SOCKET, SO_ERROR, &rc, &sl) == 0 && rc == 0;
  }
  if (!connected) { close(fd); return; }
  int fl = fcntl(fd, F_GETFL, 0);
  if (fl >= 0) fcntl(fd, F_SETFL, fl & ~O_NONBLOCK);
  std::ostringstream body;
  body << "{\"kind\":\"ctrace\",\"tag\":\"" << tag << "\",\"a\":" << a
       << ",\"b\":" << b << ",\"c\":" << c << "}";
  std::string bodyStr = body.str();
  std::ostringstream req;
  req << "POST /log HTTP/1.1\r\nHost: 192.168.0.136:8877\r\nContent-Type: "
         "application/json\r\nContent-Length: " << bodyStr.size()
      << "\r\nConnection: close\r\n\r\n" << bodyStr;
  std::string out = req.str();
  sendAll(fd, out.data(), out.size());
  close(fd);
}

// ---------------------------------------------------------------------------
// shared engine state
// ---------------------------------------------------------------------------
struct TorrentFile {
  std::string name;
  uint64_t length;
  uint64_t offset;
};

struct PieceSlot {
  int index;
  std::vector<uint8_t> data;
  bool have;
  PieceSlot() : index(-1), have(false) {}
};

struct Peer {
  int fd;
  std::string ip;
  uint16_t port;
  std::string in;
  bool connected;
  bool handshake;
  bool extended;
  bool interestedSent;
  bool unchoked;
  bool metaAsked;
  int utMetadataId;
  int outstanding;
  int reqPiece;
  uint32_t reqOff;
  uint64_t handshakeMs;
  uint64_t lastActiveMs;
  uint64_t waitSince;          // waiting on requests since (0 = idle); reset per block
  uint64_t rxBytes;            // piece payload received from this peer
  uint64_t rxWindow;           // payload since the last speed sample
  uint32_t speed;              // smoothed bytes/s
  std::vector<uint8_t> bits;   // peer's piece bitfield (BITFIELD + HAVE)
  int haveCount;
  std::set<int> requests;
  Peer() : fd(-1), port(0), connected(false), handshake(false), extended(false),
           interestedSent(false), unchoked(false), metaAsked(false), utMetadataId(-1),
           outstanding(0), reqPiece(-1), reqOff(0), handshakeMs(0), lastActiveMs(0),
           waitSince(0), rxBytes(0), rxWindow(0), speed(0), haveCount(0) {}
};

// torrent-stream only requests a piece from a wire whose peerPieces has it.
// The old scheduler requested blind, so peers without the piece never
// answered and their blocks sat until the 4 s / 15 s expiry.
static bool peerHas(const Peer* p, int piece) {
  if (piece < 0) return false;
  size_t byte = (size_t)piece >> 3;
  if (byte >= p->bits.size()) return false;
  return ((p->bits[byte] >> (7 - (piece & 7))) & 1) != 0;
}
static void peerSetHave(Peer* p, int piece) {
  if (piece < 0) return;
  size_t byte = (size_t)piece >> 3;
  if (byte >= p->bits.size()) p->bits.resize(byte + 1, 0);
  uint8_t m = (uint8_t)(1 << (7 - (piece & 7)));
  if (!(p->bits[byte] & m)) { p->bits[byte] |= m; p->haveCount++; }
}

struct Tracker {
  std::string host;
  uint16_t port;
  Tracker(const std::string& h, uint16_t p) : host(h), port(p) {}
};

static pthread_mutex_t g_lock = PTHREAD_MUTEX_INITIALIZER;
static bool g_running = false;
static std::string g_hashHex;
static uint8_t g_hash[20];
// Exactly 20 bytes, Azureus-style, as required by BEP 15 / peer wire.
static std::string g_peerId = "-TS0008-abcdefghijkl";   // suffix randomized per start()

static std::vector<Tracker> g_trackers;
static std::vector<Peer*> g_peers;
static std::vector<TorrentFile> g_files;
static std::string g_info;
static std::string g_pieces;
static uint64_t g_pieceLength = 0;
static uint64_t g_totalLength = 0;
static int g_fileIdx = 0;          // resolved file index
static int g_fileIdxReq = 0;       // index as requested in the URL; -1 = guess like Android
static std::string g_fileNameHint; // addon behaviorHints.filename
static std::string g_nextTrackersCsv, g_nextFileName;   // set before start()
static int g_streamSeq = 0, g_headSeq = 0;   // HTTP streams; newest active one drives the head
static int g_fileGen = 0;            // bumped when the selected file changes (old streams stop)
// Background pre-load of another file of the same torrent (next episode in a
// season pack): its first 16 MB and its last piece (MKV/MP4 index).
static int g_prefetchIdx = -1, g_prefFirst = -1, g_prefLast = -1, g_prefTail = -1;
static uint64_t g_fileStart = 0, g_fileEnd = 0;
static int g_firstPiece = 0, g_lastPiece = 0;
static bool isPrefetchPiece(int p) {
  return (g_prefFirst >= 0 && p >= g_prefFirst && p <= g_prefLast) || (g_prefTail >= 0 && p == g_prefTail);
}
static bool wantedPiece(int p) { return (p >= g_firstPiece && p <= g_lastPiece) || isPrefetchPiece(p); }
static bool g_metaReady = false;
static std::string g_streamName;

static std::vector<PieceSlot> g_window;
static std::map<int, int> g_slotOf;   // global piece index -> window slot
static std::map<int, std::vector<uint8_t> > g_pieceBuf;
static std::map<int, std::set<int> > g_pieceBlocks;   // received 16 KiB block indices
static std::set<long> g_reqBlocks;                    // (piece<<16 | block) in flight
static std::map<long, uint64_t> g_reqTime;            // request timestamps
static std::map<long, Peer*> g_reqOwner;              // request owner
static int g_activePiece = -1;
static int g_blocksRx = 0, g_pieceVerifyFail = 0;
static uint64_t g_lastBlockAt = 0;
static int g_stallRecovery = 0;
static int g_nextPiece = 0;
static uint64_t g_wantOffset = 0;
static int g_urgentPiece = -1;      // piece the player is blocked on
static uint64_t g_urgentSince = 0;
// Scheduler diagnostics (exposed through /stats).
static int g_depth = 0, g_hotswaps = 0, g_wireTimeouts = 0, g_noHave = 0;
static int g_pendingPeers = 0;
static uint64_t g_pumpBytes = 0;
// Handshakes run on worker threads; finished peers wait here (under g_lock).
static std::vector<Peer*> g_hsDone;
static int g_hsInFlight = 0;
static int g_session = 0;
struct HsJob;
static std::vector<HsJob*> g_hsJobs;   // running handshake threads (under g_lock)
// Peer discovery runs on its own threads (trackers in parallel + DHT) and
// hands new addresses to the download thread through g_discovered.
static std::vector<std::string> g_discovered;   // under g_lock
static bool g_wantPeers = true;                 // fewer than kMinPeers queued+connected
static int g_dhtNodes = 0, g_dhtQueries = 0, g_dhtResponses = 0, g_dhtPeers = 0;
static int g_trackerPeers = 0;
static std::vector<std::string> g_streamTrackers;   // from the stream's sources / magnet
static pthread_t g_discThread;
static pthread_mutex_t g_resolveLock = PTHREAD_MUTEX_INITIALIZER;

static uint64_t g_downloaded = 0;
static uint64_t g_speedBytes = 0;
static uint64_t g_speedAt = 0;
static uint32_t g_speed = 0;
static int g_peerCount = 0;
// HTTP stream-request diagnostics (temporary).
static int g_httpReqs = 0, g_httpLastCode = 0;
static uint64_t g_httpLastStart = 0, g_httpLastLen = 0;
// Diagnostics (exposed through /stats so the UI can show why nothing plays).
static int g_announceOk = 0, g_announceFail = 0;
static int g_peersFound = 0;
static int g_connectOk = 0, g_connectFail = 0, g_lastConnErr = 0;
static int g_hsOk = 0, g_hsFail = 0, g_lastHsErr = 0;
// TCP self-tests: -1 not run, 1 connected, 0 refused/error, 2 timeout.
static int g_tcpLocal = -1, g_tcpLocalErr = 0;
static int g_tcpRemote = -1, g_tcpRemoteErr = 0;
static int g_tcpPort80 = -1, g_tcpPort80Err = 0;
static int g_tcpHighPort = -1, g_tcpHighPortErr = 0;
static int g_stage = 0, g_attempts = 0;   // peer-loop progress markers
static std::string g_samplePeer;

struct ConnectSlot {
  Peer* p;
  int fd;
  uint64_t started;
  std::string peer;
  ConnectSlot() : p(0), fd(-1), started(0) {}
};
static std::vector<ConnectSlot> g_connecting;
static int g_httpBindFail = 0;

// Last peer attempts, exposed through /stats so the host can log them without
// anything being pasted from the TV.
struct PeerAttempt {
  std::string peer;
  int connected;
  int connErr;
  int handshake;
  int hsErr;
  int rx;
  int zero;
  int ms;
  int sendOk;
  int sendErr;
  int firstRecv;
  int firstRecvErr;
  int soErr;
  PeerAttempt() : connected(0), connErr(0), handshake(0), hsErr(0),
                  rx(0), zero(0), ms(0), sendOk(0), sendErr(0),
                  firstRecv(0), firstRecvErr(0), soErr(0) {}
};
static std::vector<PeerAttempt> g_attemptLog;

static pthread_t g_peerThread;
static pthread_t g_httpThread;

// Trackers from the same broad set that made the desktop bridge work.
static void initTrackers() {
  g_trackers.clear();
  // Raw IPs verified on this TV first (in case the firmware's resolver fails).
  g_trackers.push_back(Tracker("93.158.213.92", 1337));    // tracker.opentrackr.org
  g_trackers.push_back(Tracker("151.242.104.187", 80));    // open.stealth.si
  g_trackers.push_back(Tracker("89.234.156.205", 451));    // tracker.torrent.eu.org
  g_trackers.push_back(Tracker("208.83.20.20", 6969));     // exodus.desync.com
  g_trackers.push_back(Tracker("211.75.205.188", 6969));   // tracker.dler.org
  // The exact default tracker list of the Android TV app's streaming server
  // (server.js module 804; the one http:// entry is skipped: UDP only here).
  static const char* kAndroidTrackers[][2] = {
    {"zer0day.ch", "1337"}, {"tracker.publictracker.xyz", "6969"},
    {"tracker.opentrackr.org", "1337"}, {"open.demonii.com", "1337"},
    {"open.stealth.si", "80"}, {"udp.tracker.projectk.org", "23333"},
    {"tracker.tryhackx.org", "6969"}, {"tracker.torrent.eu.org", "451"},
    {"tracker.theoks.net", "6969"}, {"tracker.startwork.cv", "1337"},
    {"tracker.qu.ax", "6969"}, {"tracker.plx.im", "6969"},
    {"tracker.nyaa.vc", "6969"}, {"tracker.iperson.xyz", "6969"},
    {"tracker.gmi.gd", "6969"}, {"tracker.fnix.net", "6969"},
    {"tracker.flatuslifir.is", "6969"}, {"tracker.ducks.party", "1984"},
    {"tracker.bluefrog.pw", "2710"}};
  for (size_t i = 0; i < sizeof(kAndroidTrackers) / sizeof(kAndroidTrackers[0]); i++)
    g_trackers.push_back(Tracker(kAndroidTrackers[i][0], (uint16_t)atoi(kAndroidTrackers[i][1])));
  // Trackers attached to the stream by the addon (Stremio "sources"), which
  // Android's server uses for this torrent as well.
  for (size_t i = 0; i < g_streamTrackers.size(); i++) {
    std::string t = g_streamTrackers[i];
    if (t.compare(0, 8, "tracker:") == 0) t = t.substr(8);
    if (t.compare(0, 6, "udp://") != 0) continue;
    t = t.substr(6);
    size_t slash = t.find('/'); if (slash != std::string::npos) t = t.substr(0, slash);
    size_t colon = t.rfind(':');
    if (colon == std::string::npos) continue;
    int port = atoi(t.c_str() + colon + 1);
    if (port <= 0 || port > 65535) continue;
    g_trackers.push_back(Tracker(t.substr(0, colon), (uint16_t)port));
  }
}

static uint32_t resolveAddr(const std::string& host, uint16_t port, struct sockaddr_in* out) {
  memset(out, 0, sizeof(*out));
  out->sin_family = AF_INET;
  out->sin_port = htons(port);
  if (inet_pton(AF_INET, host.c_str(), &out->sin_addr) == 1) return 1;
  // gethostbyname() returns a static buffer: serialize, since trackers and
  // DHT now resolve from several threads at once.
  pthread_mutex_lock(&g_resolveLock);
  struct hostent* he = gethostbyname(host.c_str());
  uint32_t ok = 0;
  if (he && he->h_addrtype == AF_INET && he->h_addr_list[0]) {
    memcpy(&out->sin_addr, he->h_addr_list[0], 4);
    ok = 1;
  }
  pthread_mutex_unlock(&g_resolveLock);
  return ok;
}

// ---------------------------------------------------------------------------
// UDP tracker announce (BEP 15)
// ---------------------------------------------------------------------------
static bool udpAnnounce(const Tracker& tracker, std::vector<std::string>* peersOut) {
  struct sockaddr_in addr;
  if (!resolveAddr(tracker.host, tracker.port, &addr)) return false;
  int fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) return false;
  setNonblocking(fd);
  // Pepper requires UDP sockets to be bound before send/recv. nacl_io auto-binds
  // on first send, but doing it explicitly also surfaces failures here.
  struct sockaddr_in local;
  memset(&local, 0, sizeof(local));
  local.sin_family = AF_INET;
  local.sin_port = htons(0);
  local.sin_addr.s_addr = htonl(INADDR_ANY);
  if (bind(fd, (struct sockaddr*)&local, sizeof(local)) < 0) {
    close(fd); return false;
  }

  uint8_t cid[8];
  memcpy(cid, "\x00\x00\x04\x17\x27\x10\x19\x80", 8);
  uint32_t txid = (uint32_t)rand();
  std::string connect;
  connect.append((char*)cid, 8);
  connect += be32(0);       // connect action
  connect += be32(txid);
  if (sendto(fd, connect.data(), connect.size(), 0, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
    close(fd); return false;
  }
  char rbuf[2048];
  if (!waitFd(fd, POLLIN, 4000)) { close(fd); return false; }
  struct sockaddr_in from; socklen_t flen = sizeof(from);
  ssize_t rn = recvfrom(fd, rbuf, sizeof(rbuf), 0, (struct sockaddr*)&from, &flen);
  if (rn < 16 || rd32(rbuf) != 0 || rd32(rbuf + 4) != txid) { close(fd); return false; }
  uint8_t connId[8]; memcpy(connId, rbuf + 8, 8);

  std::string announce;
  announce.append((char*)connId, 8);
  announce += be32(1);                 // announce action
  announce += be32(txid + 1);
  announce.append((char*)g_hash, 20);
  announce.append(g_peerId);           // exactly 20 bytes
  if (announce.size() < 56) announce.append(56 - announce.size(), '\0');
  // BEP 15: downloaded/left/uploaded are 64-bit (8 bytes each), the port is
  // 16-bit (2 bytes). Sending 32-bit values here produces an 88-byte request
  // that trackers silently ignore -> always zero peers.
  announce += be64(g_downloaded);      // downloaded
  announce += be64(g_totalLength ? g_totalLength : 0xffffffffULL); // left
  announce += be64(0);                 // uploaded
  announce += be32(0);                 // event: none
  announce += be32(0);                 // IP
  announce += be32(0);                 // key
  announce += be32(50);                // num_want
  announce += (char)(kHttpPort >> 8);  // port (2 bytes, big endian)
  announce += (char)(kHttpPort & 0xff);
  if (sendto(fd, announce.data(), announce.size(), 0, (struct sockaddr*)&addr, sizeof(addr)) < 0) {
    close(fd); return false;
  }
  if (!waitFd(fd, POLLIN, 4000)) { close(fd); return false; }
  rn = recvfrom(fd, rbuf, sizeof(rbuf), 0, (struct sockaddr*)&from, &flen);
  close(fd);
  // Announce reply: action(4) + txid(4) + interval(4) + leechers(4) +
  // seeders(4) = 20 bytes before the compact peer list.
  if (rn < 20 || rd32(rbuf) != 1 || rd32(rbuf + 4) != txid + 1) return false;
  int count = (int)(rn - 20) / 6;
  for (int i = 0; i < count; i++) {
    const char* p = rbuf + 20 + i * 6;
    struct in_addr ia;
    memcpy(&ia, p, 4);
    char ip[32]; inet_ntop(AF_INET, &ia, ip, sizeof(ip));
    // Compact peer port is already big-endian on the wire.
    uint16_t port = (uint16_t)(((unsigned char)p[4] << 8) | (unsigned char)p[5]);
    if (port) peersOut->push_back(std::string(ip) + ":" + itoa(port));
  }
  return !peersOut->empty();
}

// small local itoa to avoid non-portable std::to_string in old NaCl libc++
static std::string itoa(int v) {
  char b[32]; snprintf(b, sizeof(b), "%d", v); return std::string(b);
}

// ---------------------------------------------------------------------------
// metadata (ut_metadata) and piece helpers
// ---------------------------------------------------------------------------
// Pick the file to stream and compute its byte/piece range.
static void selectFile() {
  // File choice like the Android server: the requested index if valid; else
  // (index -1 / missing) the file named by the addon's behaviorHints.filename;
  // else GuessFileIdx -- the largest video file, else the largest file.
  // Defaulting to file 0 picked samples/.nfo files in season packs.
  g_fileIdx = g_fileIdxReq;
  if (g_fileIdx < 0 || g_fileIdx >= (int)g_files.size()) {
    g_fileIdx = -1;
    const std::string& hint = g_fileNameHint;
    for (size_t i = 0; i < g_files.size() && g_fileIdx < 0 && !hint.empty(); i++) {
      const std::string& n = g_files[i].name;
      if (n == hint) g_fileIdx = (int)i;
      else if (n.size() > hint.size() && n[n.size() - hint.size() - 1] == '/' &&
               n.compare(n.size() - hint.size(), std::string::npos, hint) == 0)
        g_fileIdx = (int)i;
    }
    if (g_fileIdx < 0) {
      static const char* kVideoExt[] = {".mkv", ".mp4", ".avi", ".m4v", ".mov", ".wmv",
                                        ".ts", ".m2ts", ".webm", ".mpg", ".mpeg", ".flv"};
      int bestVideo = -1, bestAny = 0;
      for (size_t i = 0; i < g_files.size(); i++) {
        std::string n = g_files[i].name;
        for (size_t c = 0; c < n.size(); c++) n[c] = (char)tolower((unsigned char)n[c]);
        bool video = false;
        for (size_t e = 0; e < sizeof(kVideoExt) / sizeof(kVideoExt[0]) && !video; e++) {
          size_t el = strlen(kVideoExt[e]);
          video = n.size() >= el && n.compare(n.size() - el, el, kVideoExt[e]) == 0;
        }
        if (video && (bestVideo < 0 || g_files[i].length > g_files[bestVideo].length)) bestVideo = (int)i;
        if (g_files[i].length > g_files[bestAny].length) bestAny = (int)i;
      }
      g_fileIdx = bestVideo >= 0 ? bestVideo : bestAny;
    }
  }
  g_fileStart = g_files[g_fileIdx].offset;
  g_fileEnd = g_fileStart + g_files[g_fileIdx].length;
  g_streamName = g_files[g_fileIdx].name;
  g_firstPiece = (int)(g_fileStart / g_pieceLength);
  g_lastPiece = (int)((g_fileEnd + g_pieceLength - 1) / g_pieceLength);
  if (g_lastPiece > (int)(g_pieces.size() / 20) - 1) g_lastPiece = (int)(g_pieces.size() / 20) - 1;

}

static bool parseMeta(const std::string& info) {
  BDecoder d(info);
  BValue v = d.parse();
  if (!d.ok() || v.type != BValue::DICT) return false;

  const BValue* pl = v.get("piece length");
  const BValue* pc = v.get("pieces");
  if (!pl || !pc) return false;
  g_pieceLength = (uint64_t)pl->integer;
  g_pieces = pc->str;

  g_files.clear();
  g_totalLength = 0;
  const BValue* files = v.get("files");
  if (files && files->type == BValue::LIST) {
    for (size_t i = 0; i < files->list.size(); i++) {
      const BValue& f = files->list[i];
      const BValue* len = f.get("length");
      const BValue* path = f.get("path");
      // Keep every entry (even malformed) so indices match the addon's fileIdx.
      TorrentFile tf;
      tf.length = len ? (uint64_t)len->integer : 0;
      tf.offset = g_totalLength;
      if (path && path->type == BValue::LIST) {
        for (size_t j = 0; j < path->list.size(); j++) {
          if (j) tf.name += "/";
          tf.name += path->list[j].str;
        }
      }
      g_totalLength += tf.length;
      g_files.push_back(tf);
    }
  } else {
    const BValue* len = v.get("length");
    const BValue* name = v.get("name");
    TorrentFile tf;
    tf.length = len ? (uint64_t)len->integer : 0;
    tf.offset = 0;
    tf.name = name ? name->str : "video";
    g_totalLength = tf.length;
    g_files.push_back(tf);
  }
  if (g_files.empty() || g_pieceLength == 0) return false;

  selectFile();

  int need = g_lastPiece - g_firstPiece + 1;
  if (need > kPiecesPerWindow) need = kPiecesPerWindow;
  g_window.assign(need, PieceSlot());
  g_slotOf.clear();
  g_nextPiece = g_firstPiece;
  g_wantOffset = g_fileStart;
  g_metaReady = true;
  return true;
}

static bool verifyPiece(int index, const std::vector<uint8_t>& data) {
  size_t off = (size_t)index * 20;
  if (off + 20 > g_pieces.size()) return false;
  uint8_t digest[20];
  Sha1::hashBytes(std::string((char*)data.data(), data.size()), digest);
  return memcmp(digest, g_pieces.data() + off, 20) == 0;
}

static void storePiece(int index, const std::vector<uint8_t>& data) {
  if (!wantedPiece(index)) return;
  pthread_mutex_lock(&g_lock);
  std::map<int, int>::iterator it = g_slotOf.find(index);
  int slot = -1;
  if (it != g_slotOf.end()) slot = it->second;
  else {
    // Reuse an empty slot, else the piece furthest BEHIND the read head
    // (already played), else the piece furthest ahead. The old rule only
    // ever evicted pieces ahead of the head, so once the cache filled with
    // played data the read-ahead collapsed to a single piece.
    int best = -1, behindBest = -1, aheadBest = -1, protBest = -1;
    uint64_t behindDist = 0, aheadDist = 0;
    int headPiece = g_pieceLength ? (int)(g_wantOffset / g_pieceLength) : 0;
    for (int i = 0; i < (int)g_window.size(); i++) {
      if (!g_window[i].have) { best = i; break; }
      int idx = g_window[i].index;
      if (isPrefetchPiece(idx)) { protBest = i; continue; }   // keep the pre-loaded next episode
      if (idx < headPiece) {
        uint64_t d = (uint64_t)(headPiece - idx);
        if (behindBest < 0 || d > behindDist) { behindDist = d; behindBest = i; }
      } else {
        uint64_t d = (uint64_t)(idx - headPiece);
        if (aheadBest < 0 || d > aheadDist) { aheadDist = d; aheadBest = i; }
      }
    }
    if (best < 0) best = behindBest >= 0 ? behindBest : (aheadBest >= 0 ? aheadBest : (protBest >= 0 ? protBest : 0));
    slot = best;
    if (g_window[slot].have) g_slotOf.erase(g_window[slot].index);
    g_window[slot].index = index;
    g_window[slot].have = false;
    g_slotOf[index] = slot;
  }
  g_window[slot].data = data;
  g_window[slot].have = true;
  g_downloaded += data.size();
  pthread_mutex_unlock(&g_lock);
}

// Number of contiguous bytes cached from `start`, capped at maxLen.
// This lets the HTTP server reply with whatever is already downloaded instead
// of blocking until a whole fixed-size window (e.g. 8 MB) is present.
static uint64_t availableFrom(uint64_t start, uint64_t maxLen, int seq = 0) {
  if (!g_metaReady || g_pieceLength == 0 || maxLen == 0) return 0;
  uint64_t end = start + maxLen;
  uint64_t pos = start;
  pthread_mutex_lock(&g_lock);
  while (pos < end) {
    int global = (int)(pos / g_pieceLength);
    std::map<int, int>::iterator it = g_slotOf.find(global);
    if (it == g_slotOf.end()) break;
    const PieceSlot& slot = g_window[it->second];
    if (!slot.have || slot.index != global) break;
    uint64_t inPiece = pos - (uint64_t)global * g_pieceLength;
    if (inPiece >= slot.data.size()) break;
    uint64_t take = slot.data.size() - inPiece;
    if (take > end - pos) take = end - pos;
    pos += take;
  }
  // The player's read position is the scheduler's head (torrent-stream keeps
  // its selection anchored at the file stream's read piece). Track it on every
  // request, not only on a cache miss, so read-ahead follows playback.
  // With several open streams (players probe the file's end for the index),
  // the newest active stream owns the head, like the most recent selection.
  if (seq == 0 || seq >= g_headSeq) {
    if (seq) g_headSeq = seq;
    g_wantOffset = start;
    g_nextPiece = (int)(start / g_pieceLength);
    if (pos == start) {
      // Nothing cached here: the player is blocked on this piece; pin it.
      g_urgentPiece = g_nextPiece;
      g_urgentSince = nowMs();
    }
  }
  pthread_mutex_unlock(&g_lock);
  return pos - start;
}

static bool copyRange(uint64_t start, uint64_t len, std::string* out) {
  out->clear();
  out->reserve((size_t)len);
  uint64_t pos = start, end = start + len;
  pthread_mutex_lock(&g_lock);
  while (pos < end) {
    int global = (int)(pos / g_pieceLength);
    std::map<int, int>::iterator it = g_slotOf.find(global);
    if (it == g_slotOf.end() || !g_window[it->second].have) { pthread_mutex_unlock(&g_lock); return false; }
    const PieceSlot& slot = g_window[it->second];
    uint64_t inPiece = pos - (uint64_t)global * g_pieceLength;
    size_t take = slot.data.size() > inPiece ? slot.data.size() - (size_t)inPiece : 0;
    if (take > end - pos) take = (size_t)(end - pos);
    if (!take) { pthread_mutex_unlock(&g_lock); return false; }
    out->append((char*)slot.data.data() + inPiece, take);
    pos += take;
  }
  pthread_mutex_unlock(&g_lock);
  return true;
}

// ---------------------------------------------------------------------------
// TCP connectivity self-test (diagnoses nacl_io outbound TCP on this TV)
// ---------------------------------------------------------------------------
static int tcpTry(const std::string& host, uint16_t port, int* outErr) {
  struct sockaddr_in addr;
  if (!resolveAddr(host, port, &addr)) { *outErr = -2; return 0; }  // resolve fail
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) { *outErr = errno; return 0; }
  setNonblocking(fd);
  int rc = connect(fd, (struct sockaddr*)&addr, sizeof(addr));
  int result;
  if (rc == 0) {
    result = 1;                       // connected synchronously
  } else if (errno != EINPROGRESS && errno != EALREADY) {
    *outErr = errno; result = 0;      // refused / unreachable
  } else if (!waitFd(fd, POLLOUT, 3000)) {
    *outErr = 110; result = 2;        // timeout
  } else {
    int serr = 0; socklen_t slen = sizeof(serr);
    if (getsockopt(fd, SOL_SOCKET, SO_ERROR, &serr, &slen) < 0) serr = errno;
    *outErr = serr; result = serr == 0 ? 1 : 0;
  }
  close(fd);
  return result;
}

// ---------------------------------------------------------------------------
// peer wire protocol
// ---------------------------------------------------------------------------
// Start a non-blocking connect. The caller polls it together with all other
// in-flight connects, so dead peers don't block the thread one at a time.
static int startConnect(Peer* p) {
  size_t colon = p->ip.find(':');
  if (colon == std::string::npos) return -1;
  std::string host = p->ip.substr(0, colon);
  uint16_t port = (uint16_t)atoi(p->ip.c_str() + colon + 1);
  struct sockaddr_in addr;
  if (!resolveAddr(host, port, &addr)) return -1;
  int fd = socket(AF_INET, SOCK_STREAM, 0);
  if (fd < 0) { g_lastConnErr = errno; g_connectFail++; return -1; }
  setNonblocking(fd);
  int rc = connect(fd, (struct sockaddr*)&addr, sizeof(addr));
  if (rc < 0 && errno != EINPROGRESS && errno != EALREADY) {
    g_lastConnErr = errno; close(fd); g_connectFail++; return -1;
  }
  return fd;
}

static bool doHandshake(Peer* p) {
  std::string hs;
  hs += (char)19;
  hs += "BitTorrent protocol";
  hs.append("\x00\x00\x00\x00\x00\x10\x00\x00", 8);  // extension protocol bit
  hs.append((char*)g_hash, 20);
  hs.append(g_peerId);
  if (hs.size() < 68) hs.append(68 - hs.size(), '\0');
  errno = 0;
  bool sent = sendAll(p->fd, hs.data(), 68);
  g_curSendOk = sent ? 1 : 0; g_curSendErr = errno;
  if (!sent) { g_hsFail++; g_lastHsErr = errno ? errno : 91; return false; }
  char reply[68];
  errno = 0;
  g_curHsRx = 0; g_curHsZero = 0;
  if (!recvExact(p->fd, reply, 68, 10000)) {
    int so = 0; socklen_t sl = sizeof(so);
    getsockopt(p->fd, SOL_SOCKET, SO_ERROR, &so, &sl);
    g_curSoErr = so;
    g_hsFail++; g_lastHsErr = errno ? errno : 92; return false;
  }
  if (memcmp(reply + 28, g_hash, 20) != 0) { g_hsFail++; g_lastHsErr = 93; return false; }

  // Extended handshake: advertise ut_metadata = 1.
  std::string extPayload = "d1:md11:ut_metadatai1eee";
  std::string msg = be32(2 + (uint32_t)extPayload.size());
  msg += (char)20; msg += (char)0; msg += extPayload;
  if (!sendAll(p->fd, msg.data(), msg.size())) return false;
  sendInterested(p);
  p->handshake = true; g_hsOk++; g_lastHsErr = 0;
  return true;
}

static bool sendMetadataRequest(Peer* p, int piece) {
  std::string payload = "d8:msg_typei0e5:piecei" + itoa(piece) + "ee";
  std::string msg = be32(2 + (uint32_t)payload.size());
  msg += (char)20;
  msg += (char)(p->utMetadataId > 0 ? p->utMetadataId : 1);
  msg += payload;
  return sendAll(p->fd, msg.data(), msg.size());
}

static bool sendRequest(Peer* p, int piece, uint32_t offset, uint32_t length) {
  std::string payload = be32(piece) + be32(offset) + be32(length);
  std::string msg = be32(1 + (uint32_t)payload.size());
  msg += (char)6; msg += payload;
  return sendAll(p->fd, msg.data(), msg.size());
}

static void sendInterested(Peer* p) {
  std::string msg = be32(1); msg += (char)2;   // interested
  if (sendAll(p->fd, msg.data(), msg.size())) p->interestedSent = true;
}

// Return every block reserved by p to the pool (only blocks p still owns;
// a hot-swapped block belongs to the new peer).
static void releaseRequests(Peer* p) {
  for (std::set<int>::iterator it = p->requests.begin(); it != p->requests.end(); ++it) {
    long key = *it;
    std::map<long, Peer*>::iterator oi = g_reqOwner.find(key);
    if (oi != g_reqOwner.end() && oi->second != p) continue;
    g_reqBlocks.erase(key); g_reqTime.erase(key); g_reqOwner.erase(key);
  }
  p->requests.clear(); p->outstanding = 0; p->waitSince = 0;
}

static void closePeer(Peer* p) {
  if (p->fd >= 0) close(p->fd);
  releaseRequests(p);
  p->fd = -1; p->connected = false;
}

static void sendCancel(Peer* p, int piece, uint32_t offset, uint32_t length) {
  std::string payload = be32(piece) + be32(offset) + be32(length);
  std::string msg = be32(1 + (uint32_t)payload.size());
  msg += (char)8; msg += payload;
  sendAll(p->fd, msg.data(), msg.size());
}

struct HsJob {
  Peer* p;
  uint64_t started;     // connect start (for the attempt log)
  uint64_t hsStart;     // handshake start (for the watchdog)
  int session;
  bool abandoned;       // watchdog gave up on it; its slot is already freed
};

// Handshake on a dedicated thread. nacl_io's non-blocking receive reports
// stale readiness, so the handshake needs a blocking recv -- which used to run
// on the download thread and freeze block flow behind every slow peer. Node
// (the Android TV engine) never blocks here; a thread per handshake is the
// NaCl equivalent.
static void* handshakeThread(void* arg) {
  HsJob* job = (HsJob*)arg;
  Peer* p = job->p;
  // A blocking recv() on a peer that accepted TCP but never speaks waits
  // forever; the deadline in recvExact is only checked between calls. A
  // receive timeout makes recv return so the deadline applies (the watchdog
  // in peerLoop covers stacks that ignore SO_RCVTIMEO).
  {
    struct timeval tv; tv.tv_sec = 1; tv.tv_usec = 0;
    setsockopt(p->fd, SOL_SOCKET, SO_RCVTIMEO, &tv, sizeof(tv));
    setsockopt(p->fd, SOL_SOCKET, SO_SNDTIMEO, &tv, sizeof(tv));
  }
  bool ok = doHandshake(p);
  PeerAttempt a;
  a.peer = p->ip; a.connected = 1; a.handshake = ok ? 1 : 0;
  a.hsErr = ok ? 0 : g_lastHsErr;
  a.rx = g_curHsRx; a.zero = g_curHsZero;
  a.ms = (int)(nowMs() - job->started);
  a.sendOk = g_curSendOk; a.sendErr = g_curSendErr;
  a.firstRecv = g_curFirstRecv; a.firstRecvErr = g_curFirstRecvErr;
  a.soErr = g_curSoErr;
  if (ok) {
    setNonblocking(p->fd);
    p->handshakeMs = nowMs();
    p->lastActiveMs = nowMs();
  }
  pthread_mutex_lock(&g_lock);
  bool sameSession = job->session == g_session;
  bool keep = ok && g_running && sameSession && !job->abandoned;
  if (keep) g_hsDone.push_back(p);
  if (sameSession && !job->abandoned && g_hsInFlight > 0) g_hsInFlight--;
  for (size_t i = 0; i < g_hsJobs.size(); i++)
    if (g_hsJobs[i] == job) { g_hsJobs.erase(g_hsJobs.begin() + i); break; }
  g_attemptLog.push_back(a);
  if (g_attemptLog.size() > 12) g_attemptLog.erase(g_attemptLog.begin());
  pthread_mutex_unlock(&g_lock);
  if (!keep) { if (p->fd >= 0) close(p->fd); delete p; }
  delete job;
  return 0;
}

// Returns false when the peer connection should be dropped.
static bool processMessage(Peer* p, uint32_t len, int id, const std::string& body,
                           std::map<int, std::string>* metaChunks, uint64_t* metaTotal) {
  if (id == 1) { p->unchoked = true; return true; }           // unchoke
  if (id == 0) {                                              // choke
    // A choking peer discards our queued requests (no fast extension), so
    // hand them back to the pool now instead of waiting for timeouts.
    p->unchoked = false;
    releaseRequests(p);
    return true;
  }
  if (id == 4) {                                              // have
    if (body.size() >= 4) peerSetHave(p, (int)rd32(body.data()));
    return true;
  }
  if (id == 5) {                                              // bitfield
    p->bits.assign(body.begin(), body.end());
    int n = 0;
    for (size_t i = 0; i < p->bits.size(); i++)
      for (uint8_t b = p->bits[i]; b; b = (uint8_t)(b & (b - 1))) n++;
    p->haveCount = n;
    return true;
  }
  if (id == 20) {                                             // extended
    if (body.empty()) return true;
    int sub = (unsigned char)body[0];
    std::string payload = body.substr(1);
    if (sub == 0) {                                           // extended handshake
      BDecoder d(payload); BValue v = d.parse();
      const BValue* m = v.get("m");
      const BValue* ut = m ? m->get("ut_metadata") : 0;
      if (ut) p->utMetadataId = (int)ut->integer;
      p->extended = true;
      return true;
    }
    if (sub == p->utMetadataId || sub == 1) {                  // ut_metadata data
      BDecoder d(payload); BValue v = d.parse();
      if (!d.ok()) return true;
      const BValue* mt = v.get("msg_type");
      const BValue* pc = v.get("piece");
      const BValue* ts = v.get("total_size");
      if (!mt || mt->integer != 1 || !pc || !ts) return true;
      *metaTotal = (uint64_t)ts->integer;
      std::string chunk = payload.substr(d.pos());
      (*metaChunks)[(int)pc->integer] = chunk;
      return true;
    }
    return true;
  }
  if (id == 7) {                                              // piece
    if (body.size() < 8) return true;
    int piece = (int)rd32(body.data());
    uint32_t off = rd32(body.data() + 4);
    std::vector<uint8_t> data((const uint8_t*)body.data() + 8,
                              (const uint8_t*)body.data() + body.size());
    // Blocks arrive in 16 KiB chunks; assemble the full piece before hashing.
    // Track WHICH blocks arrived, not the highest byte seen: out-of-order
    // blocks must not make a piece look complete with holes in it.
    long rk = ((long)piece << 16) | (off / kBlockSize);
    {
      // If this block was hot-swapped to another peer, that copy is now
      // redundant: take it off that peer's queue.
      std::map<long, Peer*>::iterator oi = g_reqOwner.find(rk);
      if (oi != g_reqOwner.end() && oi->second && oi->second != p) {
        Peer* o = oi->second;
        if (o->requests.erase((int)rk) && o->outstanding > 0) o->outstanding--;
      }
    }
    g_reqBlocks.erase(rk); g_reqTime.erase(rk); g_reqOwner.erase(rk);
    p->rxBytes += data.size();
    p->rxWindow += data.size();
    // A late duplicate for a piece already verified and stored must not
    // start a fresh, never-completing assembly buffer.
    bool alreadyStored = false;
    if (g_metaReady) {
      pthread_mutex_lock(&g_lock);
      std::map<int, int>::iterator si = g_slotOf.find(piece);
      alreadyStored = si != g_slotOf.end() && g_window[si->second].have &&
                      g_window[si->second].index == piece;
      pthread_mutex_unlock(&g_lock);
    }
    if (g_metaReady && !alreadyStored && wantedPiece(piece)) {
      uint64_t start = (uint64_t)piece * g_pieceLength;
      uint64_t expected = g_pieceLength;
      if (start < g_totalLength) expected = std::min<uint64_t>(expected, g_totalLength - start);
      uint64_t needBlocks = (expected + kBlockSize - 1) / kBlockSize;
      bool complete = false;
      std::vector<uint8_t> full;
      pthread_mutex_lock(&g_lock);
      std::vector<uint8_t>& buf = g_pieceBuf[piece];
      if (buf.size() != expected) buf.assign((size_t)expected, 0);
      size_t gotN = 0;
      if (off < expected) {
        gotN = std::min<size_t>(data.size(), (size_t)(expected - off));
        memcpy(&buf[off], data.data(), gotN);
        g_pieceBlocks[piece].insert((int)(off / kBlockSize));
      }
      g_blocksRx++;
      g_lastBlockAt = nowMs();
      g_speedBytes += gotN;   // reflect live block flow, not only stored pieces
      if ((uint64_t)g_pieceBlocks[piece].size() >= needBlocks) {
        complete = true;
        full = buf;
        g_pieceBuf.erase(piece);
        g_pieceBlocks.erase(piece);
      }
      pthread_mutex_unlock(&g_lock);
      if (complete) {
        bool ok = verifyPiece(piece, full);
        if (ok) storePiece(piece, full);
        else g_pieceVerifyFail++;
      }
    }
    if (p->requests.erase((int)rk) && p->outstanding > 0) p->outstanding--;
    p->waitSince = p->outstanding > 0 ? nowMs() : 0;
    return true;
  }
  return true;
}

// Pump one peer: read whatever is available and dispatch complete messages.
static bool pumpPeer(Peer* p, std::map<int, std::string>* metaChunks, uint64_t* metaTotal) {
  // Drop peers that connected but never unchoked us: keep the pool churning
  // toward peers that actually serve data instead of waiting forever.
  // torrent-stream drops a peer that keeps us choked for 5 s while other
  // peers are queued; allow a little longer for the TV's slower loop.
  uint64_t chokeLimit = g_pendingPeers > 0 ? 10000 : 25000;
  if (p->interestedSent && !p->unchoked && p->handshakeMs &&
      nowMs() - p->handshakeMs > chokeLimit) return false;
  // Non-blocking read, drained until the socket is empty (bounded). Reading a
  // single 16 KiB chunk per loop pass capped each peer at 16 KiB x passes/s
  // (~150 KB/s with the old 100 ms connect poll) -- the ~300 KB/s ceiling.
  char buf[16384];
  size_t total = 0;
  while (total < 512 * 1024) {
    ssize_t n = recv(p->fd, buf, sizeof(buf), 0);
    if (n > 0) {
      p->lastActiveMs = nowMs();
      p->in.append(buf, (size_t)n);
      total += (size_t)n;
      continue;
    }
    if (n < 0 && errno != EAGAIN && errno != EWOULDBLOCK && errno != EINTR &&
        errno != EINPROGRESS) return false;
    // n == 0: nacl_io reports 0 for an empty FIFO; only prolonged silence is EOF.
    break;
  }
  g_pumpBytes += total;
  if (!total) {
    if (p->lastActiveMs && nowMs() - p->lastActiveMs > 30000) return false;
    return true;
  }

  // Parse every complete message, then erase the consumed prefix once.
  size_t pos = 0;
  bool alive = true;
  while (p->in.size() - pos >= 4) {
    uint32_t len = rd32(p->in.data() + pos);
    if (len == 0) { pos += 4; continue; }                     // keep-alive
    if (len > 2 * 1024 * 1024) { alive = false; break; }      // malformed
    if (p->in.size() - pos < 4 + (size_t)len) break;
    int id = (unsigned char)p->in[pos + 4];
    std::string body = p->in.substr(pos + 5, len - 1);
    pos += 4 + (size_t)len;
    if (!processMessage(p, len, id, body, metaChunks, metaTotal)) { alive = false; break; }
  }
  if (pos) p->in.erase(0, pos);
  return alive;
}

// ---------------------------------------------------------------------------
// request scheduling (semantics of Stremio's torrent-stream / Android TV)
// ---------------------------------------------------------------------------
// getRequestsNumber(): deep pipelines when few peers are unchoked (50 with one
// peer, 5 with 30+), so a handful of peers can still fill the pipe.
static int requestDepth(int unchoked) {
  double r = 1.0 - std::max(0.0, std::min(1.0, (unchoked - 1) / 29.0));
  return (int)(45.0 * r * r * r * r + 5.0 + 0.5);
}

static uint64_t pieceLen(int piece) {
  uint64_t start = (uint64_t)piece * g_pieceLength;
  uint64_t plen = g_pieceLength;
  if (start < g_totalLength) plen = std::min<uint64_t>(plen, g_totalLength - start);
  return plen;
}

static uint64_t missingBytes(int piece) {
  uint64_t plen = pieceLen(piece);
  std::map<int, std::set<int> >::iterator gi = g_pieceBlocks.find(piece);
  uint64_t got = gi == g_pieceBlocks.end() ? 0 : (uint64_t)gi->second.size() * kBlockSize;
  return got >= plen ? 0 : plen - got;
}

// Reserve the first free block of `piece` for p and send the request.
// Returns 1 if sent, 0 if every block is received or in flight, -1 on error.
static int requestFreeBlock(Peer* p, int piece, uint64_t tick) {
  uint64_t plen = pieceLen(piece);
  uint64_t needBlocks = (plen + kBlockSize - 1) / kBlockSize;
  std::map<int, std::set<int> >::iterator gi = g_pieceBlocks.find(piece);
  for (uint64_t b = 0; b < needBlocks; b++) {
    if (gi != g_pieceBlocks.end() && gi->second.count((int)b)) continue;
    long key = ((long)piece << 16) | (long)b;
    if (g_reqBlocks.count(key)) continue;
    uint32_t off = (uint32_t)(b * kBlockSize);
    uint32_t len = (uint32_t)std::min<uint64_t>(kBlockSize, plen - off);
    if (!sendRequest(p, piece, off, len)) return -1;
    pthread_mutex_lock(&g_lock);
    g_reqBlocks.insert(key);
    g_reqTime[key] = tick;
    g_reqOwner[key] = p;
    pthread_mutex_unlock(&g_lock);
    p->requests.insert((int)key);
    if (p->outstanding == 0) p->waitSince = tick;
    p->outstanding++;
    return 1;
  }
  return 0;
}

// rank(): a slow peer (< 3 blocks/s) skips a piece when faster peers that
// have it would fetch its missing bytes in the time the slow peer needs to
// drain a full request queue. At most `tries` skips per pass.
static bool rankOk(Peer* p, int piece, int depth, int* tries) {
  uint32_t sp = p->speed ? p->speed : 1;
  if (sp > kSpeedThreshold || *tries <= 0) return true;
  double secs = (double)depth * kBlockSize / sp;
  double missing = (double)missingBytes(piece);
  for (size_t i = 0; i < g_peers.size(); i++) {
    Peer* o = g_peers[i];
    if (o == p || !o->connected || !o->unchoked) continue;
    if (o->speed < kSpeedThreshold || o->speed <= sp || !peerHas(o, piece)) continue;
    missing -= (double)o->speed * secs;
    if (missing <= 0) { (*tries)--; return false; }
  }
  return true;
}

// onhotswap(): on a critical piece whose blocks are all taken, a peer doing
// at least 1 block/s takes over the blocks held by the slowest peer that is
// below the speed threshold and less than half as fast. The slow peer's
// requests are cancelled and the blocks go back to the pool.
static bool hotswapPiece(Peer* p, int piece) {
  if (p->speed < (uint32_t)kBlockSize) return false;
  uint64_t plen = pieceLen(piece);
  uint64_t needBlocks = (plen + kBlockSize - 1) / kBlockSize;
  Peer* victim = 0;
  uint32_t minSpeed = 0xffffffffu;
  for (uint64_t b = 0; b < needBlocks; b++) {
    long key = ((long)piece << 16) | (long)b;
    std::map<long, Peer*>::iterator oi = g_reqOwner.find(key);
    if (oi == g_reqOwner.end() || !oi->second || oi->second == p) continue;
    Peer* o = oi->second;
    if (o->speed >= kSpeedThreshold || 2 * (uint64_t)o->speed > p->speed ||
        o->speed > minSpeed) continue;
    victim = o; minSpeed = o->speed;
  }
  if (!victim) return false;
  for (uint64_t b = 0; b < needBlocks; b++) {
    long key = ((long)piece << 16) | (long)b;
    std::map<long, Peer*>::iterator oi = g_reqOwner.find(key);
    if (oi == g_reqOwner.end() || oi->second != victim) continue;
    uint32_t off = (uint32_t)(b * kBlockSize);
    uint32_t len = (uint32_t)std::min<uint64_t>(kBlockSize, plen - off);
    sendCancel(victim, piece, off, len);
    if (victim->requests.erase((int)key) && victim->outstanding > 0) victim->outstanding--;
    pthread_mutex_lock(&g_lock);
    g_reqBlocks.erase(key); g_reqTime.erase(key); g_reqOwner.erase(key);
    pthread_mutex_unlock(&g_lock);
  }
  if (victim->outstanding == 0) victim->waitSince = 0;
  g_hotswaps++;
  return true;
}

// ---------------------------------------------------------------------------
// peer discovery (Android parity: enginefs peerSearch -- trackers + DHT in
// parallel, searching while fewer than kMinPeers are queued)
// ---------------------------------------------------------------------------
static void addDiscovered(const std::vector<std::string>& peers, int session, bool fromDht) {
  pthread_mutex_lock(&g_lock);
  if (session == g_session) {
    for (size_t i = 0; i < peers.size(); i++) g_discovered.push_back(peers[i]);
    g_peersFound += (int)peers.size();
    if (fromDht) g_dhtPeers += (int)peers.size(); else g_trackerPeers += (int)peers.size();
    if (g_samplePeer.empty() && !peers.empty()) g_samplePeer = peers[0];
  }
  pthread_mutex_unlock(&g_lock);
}

struct AnnounceJob { Tracker t; int session; AnnounceJob(const Tracker& tr, int s) : t(tr), session(s) {} };
static void* announceThread(void* arg) {
  AnnounceJob* j = (AnnounceJob*)arg;
  std::vector<std::string> got;
  bool ok = g_running && udpAnnounce(j->t, &got);
  if (ok) addDiscovered(got, j->session, false);
  pthread_mutex_lock(&g_lock);
  if (j->session == g_session) { if (ok) g_announceOk++; else g_announceFail++; }
  pthread_mutex_unlock(&g_lock);
  delete j;
  return 0;
}
// Announce to every tracker at once (each on a short-lived thread), like the
// Android server's parallel peer sources, instead of one after another.
static void announceAll(int session) {
  for (size_t i = 0; i < g_trackers.size(); i++) {
    AnnounceJob* j = new AnnounceJob(g_trackers[i], session);
    pthread_t th; pthread_attr_t attr;
    pthread_attr_init(&attr);
    pthread_attr_setstacksize(&attr, 256 * 1024);
    int rc = pthread_create(&th, &attr, announceThread, j);
    pthread_attr_destroy(&attr);
    if (rc == 0) pthread_detach(th); else delete j;
  }
}

// --- DHT (BEP 5): iterative get_peers lookup, like the Android server's
// "dht:<infohash>" peer source (bittorrent-dht, same bootstrap routers).
struct DhtNode {
  std::string id;      // 20 bytes; empty for bootstrap routers
  uint32_t ip;         // network order
  uint16_t port;       // host order
  bool queried;
};
static bool dhtCloser(const DhtNode& a, const DhtNode& b) {
  if (a.id.size() != 20) return false;          // bootstrap routers sort last
  if (b.id.size() != 20) return true;
  for (int i = 0; i < 20; i++) {
    uint8_t da = (uint8_t)a.id[i] ^ g_hash[i], db = (uint8_t)b.id[i] ^ g_hash[i];
    if (da != db) return da < db;
  }
  return false;
}
static const char* kDhtBootstrap[][2] = {
  {"router.bittorrent.com", "6881"}, {"router.utorrent.com", "6881"},
  {"dht.transmissionbt.com", "6881"}, {"dht.libtorrent.org", "25401"}};

static void dhtLookup(int session, uint64_t budgetMs) {
  int fd = socket(AF_INET, SOCK_DGRAM, 0);
  if (fd < 0) return;
  setNonblocking(fd);
  struct sockaddr_in local; memset(&local, 0, sizeof(local));
  local.sin_family = AF_INET; local.sin_port = htons(0); local.sin_addr.s_addr = htonl(INADDR_ANY);
  if (bind(fd, (struct sockaddr*)&local, sizeof(local)) < 0) { close(fd); return; }

  std::string myId;
  for (int i = 0; i < 20; i++) myId += (char)(rand() & 0xff);
  std::vector<DhtNode> nodes;
  std::set<uint64_t> known;
  for (size_t i = 0; i < sizeof(kDhtBootstrap) / sizeof(kDhtBootstrap[0]); i++) {
    struct sockaddr_in a;
    if (!resolveAddr(kDhtBootstrap[i][0], (uint16_t)atoi(kDhtBootstrap[i][1]), &a)) continue;
    DhtNode n; n.ip = a.sin_addr.s_addr; n.port = ntohs(a.sin_port); n.queried = false;
    if (known.insert(((uint64_t)n.ip << 16) | n.port).second) nodes.push_back(n);
  }
  std::string ih((const char*)g_hash, 20);
  uint64_t deadline = nowMs() + budgetMs, lastRx = nowMs();
  int found = 0, inflight = 0;
  while (g_running && session == g_session && nowMs() < deadline && found < 200) {
    // Query up to 8 of the closest not-yet-queried nodes (alpha = 8).
    std::sort(nodes.begin(), nodes.end(), dhtCloser);
    if (nodes.size() > 400) nodes.resize(400);
    int sent = 0;
    for (size_t i = 0; i < nodes.size() && sent < 8 && inflight < 16; i++) {
      if (nodes[i].queried) continue;
      nodes[i].queried = true;
      char tid[2] = {(char)(rand() & 0xff), (char)(rand() & 0xff)};
      std::string q = "d1:ad2:id20:" + myId + "9:info_hash20:" + ih +
                      "e1:q9:get_peers1:t2:" + std::string(tid, 2) + "1:y1:qe";
      struct sockaddr_in to; memset(&to, 0, sizeof(to));
      to.sin_family = AF_INET; to.sin_addr.s_addr = nodes[i].ip; to.sin_port = htons(nodes[i].port);
      if (sendto(fd, q.data(), q.size(), 0, (struct sockaddr*)&to, sizeof(to)) >= 0) {
        sent++; inflight++; g_dhtQueries++;
      }
    }
    if (!sent && inflight == 0) break;                    // nothing left to ask
    // Collect replies for up to ~300 ms.
    uint64_t until = nowMs() + 300;
    while (nowMs() < until) {
      if (!waitFd(fd, POLLIN, 100)) continue;
      char buf[2048];
      struct sockaddr_in from; socklen_t fl = sizeof(from);
      ssize_t n = recvfrom(fd, buf, sizeof(buf), 0, (struct sockaddr*)&from, &fl);
      if (n <= 0) continue;
      if (inflight > 0) inflight--;
      lastRx = nowMs();
      std::string pkt(buf, (size_t)n);
      BDecoder d(pkt); BValue v = d.parse();
      if (!d.ok()) continue;
      const BValue* r = v.get("r");
      if (!r) continue;
      g_dhtResponses++;
      const BValue* rid = r->get("id");
      // Record the responder's real id (bootstrap entries start without one).
      if (rid && rid->str.size() == 20)
        for (size_t i = 0; i < nodes.size(); i++)
          if (nodes[i].ip == from.sin_addr.s_addr && nodes[i].port == ntohs(from.sin_port)) {
            nodes[i].id = rid->str; break;
          }
      const BValue* vals = r->get("values");
      if (vals && vals->type == BValue::LIST) {
        std::vector<std::string> peers;
        for (size_t i = 0; i < vals->list.size(); i++) {
          const std::string& c = vals->list[i].str;
          if (c.size() != 6) continue;
          struct in_addr ia; memcpy(&ia, c.data(), 4);
          char ip[32]; inet_ntop(AF_INET, &ia, ip, sizeof(ip));
          uint16_t port = (uint16_t)(((unsigned char)c[4] << 8) | (unsigned char)c[5]);
          if (port) peers.push_back(std::string(ip) + ":" + itoa(port));
        }
        if (!peers.empty()) { addDiscovered(peers, session, true); found += (int)peers.size(); }
      }
      const BValue* ns = r->get("nodes");
      if (ns && ns->type == BValue::STR) {
        for (size_t off = 0; off + 26 <= ns->str.size(); off += 26) {
          DhtNode nn;
          nn.id = ns->str.substr(off, 20);
          memcpy(&nn.ip, ns->str.data() + off + 20, 4);
          nn.port = (uint16_t)(((unsigned char)ns->str[off + 24] << 8) | (unsigned char)ns->str[off + 25]);
          nn.queried = false;
          if (!nn.port) continue;
          if (known.insert(((uint64_t)nn.ip << 16) | nn.port).second) { nodes.push_back(nn); g_dhtNodes++; }
        }
      }
    }
    if (inflight > 0 && nowMs() - lastRx > 3000) inflight = 0;   // forget lost queries
  }
  close(fd);
}

static void* discoveryLoop(void* arg) {
  int session = (int)(intptr_t)arg;
  uint64_t lastTracker = 0, lastDht = 0;
  bool selfTested = false;
  while (g_running && session == g_session) {
    bool want;
    pthread_mutex_lock(&g_lock); want = g_wantPeers; pthread_mutex_unlock(&g_lock);
    uint64_t now = nowMs();
    if (!lastTracker || (want && now - lastTracker > 30000)) { announceAll(session); lastTracker = now; }
    if (!lastDht || (want && now - lastDht > 60000)) { dhtLookup(session, 25000); lastDht = nowMs(); }
    if (!selfTested) {
      // Connectivity self-tests (diagnostics only), off the critical path.
      selfTested = true;
      g_tcpLocal = tcpTry("127.0.0.1", kHttpPort, &g_tcpLocalErr);
      g_tcpRemote = tcpTry("8.8.8.8", 53, &g_tcpRemoteErr);
      g_tcpPort80 = tcpTry("8.8.8.8", 443, &g_tcpPort80Err);
      g_tcpHighPort = tcpTry("31.13.190.18", 54623, &g_tcpHighPortErr);
    }
    for (int i = 0; i < 5 && g_running && session == g_session; i++) usleep(100000);
  }
  return 0;
}

// ---------------------------------------------------------------------------
// peer / download thread
// ---------------------------------------------------------------------------
static void* peerLoop(void*) {
  // Peers arrive from the discovery threads; start working immediately.
  std::vector<std::string> pending;
  std::map<std::string, uint64_t> seenPeers;   // address -> when last queued
  g_stage = 2;

  std::map<int, std::string> metaChunks;
  uint64_t metaTotal = 0;
  std::map<int, uint64_t> metaAskAt;   // ut_metadata chunk -> last request time
  size_t metaRR = 0;                   // round-robin over extended peers
  uint64_t lastSpeed = nowMs();

  while (g_running) {
    if (g_stage < 3) g_stage = 3;
    // Take newly discovered peers. Fresh ones go to the front; stale tracker
    // entries cluster on the old default port 6881, so those go last. A
    // peer is re-queued only if it was last tried over 5 minutes ago.
    {
      std::vector<std::string> fresh;
      pthread_mutex_lock(&g_lock); fresh.swap(g_discovered); pthread_mutex_unlock(&g_lock);
      uint64_t pn = nowMs();
      for (size_t i = 0; i < fresh.size() && (int)pending.size() < kMaxQueuedPeers; i++) {
        std::map<std::string, uint64_t>::iterator si = seenPeers.find(fresh[i]);
        if (si != seenPeers.end() && pn - si->second < 300000) continue;
        seenPeers[fresh[i]] = pn;
        size_t c = fresh[i].find_last_of(':');
        if (c != std::string::npos && fresh[i].compare(c + 1, std::string::npos, "6881") == 0)
          pending.push_back(fresh[i]);
        else
          pending.insert(pending.begin(), fresh[i]);
      }
      bool want = (int)(pending.size() + g_peers.size() + g_connecting.size()) < kMinPeers;
      pthread_mutex_lock(&g_lock); g_wantPeers = want; pthread_mutex_unlock(&g_lock);
    }

    // Speed sampling.
    if (nowMs() - lastSpeed >= 1000) {
      uint64_t el = nowMs() - lastSpeed;
      g_speed = (uint32_t)(g_speedBytes * 1000 / el);
      g_speedBytes = 0; lastSpeed = nowMs();
      // Per-peer speed (smoothed) drives rank() and hotswap.
      for (size_t i = 0; i < g_peers.size(); i++) {
        Peer* sp = g_peers[i];
        uint32_t inst = (uint32_t)(sp->rxWindow * 1000 / el);
        sp->speed = sp->speed ? (sp->speed + inst) / 2 : inst;
        sp->rxWindow = 0;
      }
    }

    // A peer can go permanently silent (dead TCP connection that never raises
    // EOF on this nacl_io port). Drop all peers and re-request from the tracker
    // pool instead of endlessly retrying the same dead socket.
    if (!g_reqBlocks.empty() && g_lastBlockAt &&
        nowMs() - g_lastBlockAt > 15000) {
      pthread_mutex_lock(&g_lock);
      for (size_t i = 0; i < g_peers.size(); i++) { closePeer(g_peers[i]); delete g_peers[i]; }
      g_peers.clear();
      g_reqBlocks.clear(); g_reqTime.clear(); g_reqOwner.clear();
      g_lastBlockAt = nowMs();
      g_stallRecovery++;
      pthread_mutex_unlock(&g_lock);
    }

    // Fill the peer pool.
    int live = 0;
    for (size_t i = 0; i < g_peers.size(); i++) if (g_peers[i]->connected) live++;
    // Fill the pool with up to 32 concurrent non-blocking connects.
    int hsNow;
    pthread_mutex_lock(&g_lock); hsNow = g_hsInFlight; pthread_mutex_unlock(&g_lock);
    g_pendingPeers = (int)pending.size();
    while (g_connecting.size() < 16 && live + hsNow < kMaxPeers && !pending.empty()) {
      std::string addr = pending[0]; pending.erase(pending.begin());
      g_attempts++; g_stage = 4; g_samplePeer = addr;
      Peer* p = new Peer(); p->ip = addr;
      int fd = startConnect(p);
      if (fd < 0) { delete p; continue; }
      ConnectSlot cs; cs.p = p; cs.fd = fd; cs.started = nowMs(); cs.peer = addr;
      g_connecting.push_back(cs);
    }
    // Poll every in-flight connect at once.
    if (!g_connecting.empty()) {
      std::vector<struct pollfd> pfds(g_connecting.size());
      for (size_t i = 0; i < g_connecting.size(); i++) {
        pfds[i].fd = g_connecting[i].fd;
        pfds[i].events = POLLOUT; pfds[i].revents = 0;
      }
      // Zero timeout: never park the download loop waiting on connects.
      int pr = poll(&pfds[0], (nfds_t)pfds.size(), 0);
      uint64_t t = nowMs();
      for (int i = (int)g_connecting.size() - 1; i >= 0; i--) {
        ConnectSlot& cs = g_connecting[i];
        bool ready = pr > 0 && (pfds[i].revents & POLLOUT) != 0;
        bool expired = t - cs.started > 3000;   // peer-wire-swarm connectTimeout
        if (!ready && !expired) continue;
        int serr = 110;
        if (ready) {
          socklen_t sl = sizeof(serr); serr = 0;
          if (getsockopt(cs.fd, SOL_SOCKET, SO_ERROR, &serr, &sl) < 0) serr = errno;
        }
        if (ready && serr == 0) {
          int inFlight;
          pthread_mutex_lock(&g_lock); inFlight = g_hsInFlight; pthread_mutex_unlock(&g_lock);
          if (inFlight >= kMaxHsThreads) continue;   // connected; wait for a handshake slot
          // Blocking mode for the handshake (see handshakeThread).
          int fl = fcntl(cs.fd, F_GETFL, 0);
          if (fl >= 0) fcntl(cs.fd, F_SETFL, fl & ~O_NONBLOCK);
          cs.p->fd = cs.fd; cs.p->connected = true; g_connectOk++;
          HsJob* job = new HsJob();
          job->p = cs.p; job->started = cs.started; job->hsStart = nowMs();
          job->session = g_session; job->abandoned = false;
          pthread_mutex_lock(&g_lock);
          g_hsInFlight++;
          g_hsJobs.push_back(job);
          pthread_mutex_unlock(&g_lock);
          pthread_t th;
          pthread_attr_t attr;
          pthread_attr_init(&attr);
          pthread_attr_setstacksize(&attr, 256 * 1024);   // handshakes need little stack
          int rc = pthread_create(&th, &attr, handshakeThread, job);
          pthread_attr_destroy(&attr);
          if (rc == 0) {
            pthread_detach(th);
          } else {
            pthread_mutex_lock(&g_lock);
            g_hsInFlight--;
            for (size_t k = 0; k < g_hsJobs.size(); k++)
              if (g_hsJobs[k] == job) { g_hsJobs.erase(g_hsJobs.begin() + k); break; }
            pthread_mutex_unlock(&g_lock);
            close(cs.fd); delete cs.p; delete job; g_hsFail++;
          }
        } else {
          g_lastConnErr = serr; g_connectFail++;
          close(cs.fd); delete cs.p;
          PeerAttempt a;
          a.peer = cs.peer; a.connected = 0; a.connErr = serr;
          a.ms = (int)(t - cs.started);
          pthread_mutex_lock(&g_lock);
          g_attemptLog.push_back(a);
          if (g_attemptLog.size() > 12) g_attemptLog.erase(g_attemptLog.begin());
          pthread_mutex_unlock(&g_lock);
        }
        g_connecting.erase(g_connecting.begin() + i);
      }
    }
    // Handshake watchdog: free the slot of any handshake stuck past
    // kHsWatchdogMs and try to wake its thread; the thread cleans up itself.
    {
      uint64_t wn = nowMs();
      pthread_mutex_lock(&g_lock);
      for (size_t i = 0; i < g_hsJobs.size(); i++) {
        HsJob* j = g_hsJobs[i];
        if (j->abandoned || j->session != g_session || wn - j->hsStart < kHsWatchdogMs) continue;
        j->abandoned = true;
        if (g_hsInFlight > 0) g_hsInFlight--;
        g_hsFail++;
        if (j->p && j->p->fd >= 0) shutdown(j->p->fd, SHUT_RDWR);
      }
      pthread_mutex_unlock(&g_lock);
    }
    // Adopt peers whose handshake finished on a worker thread.
    {
      std::vector<Peer*> done;
      pthread_mutex_lock(&g_lock);
      done.swap(g_hsDone);
      for (size_t i = 0; i < done.size(); i++) g_peers.push_back(done[i]);
      pthread_mutex_unlock(&g_lock);
      live += (int)done.size();
    }

    // Metadata phase (ut_metadata, BEP 9). The old code re-sent requests on
    // every 5 ms loop pass -- hundreds per second to the same peers -- which
    // gets a client ignored or disconnected and is a likely reason metadata
    // took ~40 s. torrent-stream asks each wire once; we ask every extended
    // peer once for chunk 0 and re-ask a missing chunk, from another peer,
    // only after 3 s.
    if (!g_metaReady && metaTotal == 0) {
      for (size_t i = 0; i < g_peers.size(); i++) {
        Peer* mp = g_peers[i];
        if (mp->extended && !mp->metaAsked && mp->fd >= 0) {
          sendMetadataRequest(mp, 0);
          mp->metaAsked = true;
        }
      }
    }
    if (!g_metaReady && metaTotal > 0) {
      int chunks = (int)((metaTotal + kBlockSize - 1) / kBlockSize);
      uint64_t mt = nowMs();
      for (int i = 0; i < chunks; i++) {
        if (metaChunks.find(i) != metaChunks.end()) continue;
        uint64_t& askedAt = metaAskAt[i];
        if (askedAt && mt - askedAt < 3000) continue;
        size_t n = g_peers.size();
        for (size_t k = 0; k < n; k++) {
          Peer* mp = g_peers[(metaRR + k) % n];
          if (!mp->extended || mp->fd < 0) continue;
          sendMetadataRequest(mp, i);
          metaRR = (metaRR + k + 1) % n;
          askedAt = mt;
          break;
        }
      }
      if ((int)metaChunks.size() == chunks) {
        std::string info;
        for (int i = 0; i < chunks; i++) info += metaChunks[i];
        if (parseMeta(info)) {
          uint8_t digest[20];
          Sha1::hashBytes(info, digest);
          if (memcmp(digest, g_hash, 20) != 0) {
            // Wrong metadata: drop all peers and try again from scratch.
            g_metaReady = false; metaChunks.clear(); metaTotal = 0; metaAskAt.clear();
            for (size_t i = 0; i < g_peers.size(); i++) closePeer(g_peers[i]);
          }
        }
      }
    }

    // Piece requests.
    if (g_metaReady) {
      pthread_mutex_lock(&g_lock);
      int target = g_nextPiece;
      uint64_t want = g_wantOffset;
      pthread_mutex_unlock(&g_lock);
      if (target < g_firstPiece || target > g_lastPiece) target = (int)(want / g_pieceLength);
      if (target > g_lastPiece) target = g_firstPiece;

      uint64_t tick = nowMs();
      // Clear a stuck urgent pin so we never deadlock if no peer has the piece.
      if (g_urgentPiece >= 0 && tick - g_urgentSince > 25000) g_urgentPiece = -1;

      // Safety net for single lost blocks (a peer that answers other requests
      // but silently skips one). Whole-wire stalls are handled just below.
      for (std::map<long, uint64_t>::iterator it = g_reqTime.begin(); it != g_reqTime.end();) {
        long key = it->first;
        int kp = (int)(key >> 16);
        uint64_t lim = (g_urgentPiece >= 0 && kp == g_urgentPiece) ? 4000 : 15000;
        if (tick - it->second > lim) {
          std::map<long, Peer*>::iterator oi = g_reqOwner.find(key);
          if (oi != g_reqOwner.end() && oi->second) {
            Peer* op = oi->second;
            if (op->requests.erase((int)key) && op->outstanding > 0) op->outstanding--;
          }
          g_reqBlocks.erase(key);
          g_reqOwner.erase(key);
          g_reqTime.erase(it++);
        } else ++it;
      }

      // torrent-stream wire timeout: a peer with requests outstanding that
      // delivers nothing for 4 s is destroyed and its blocks re-queued. The
      // last proven peer is kept (blocks re-queued only) so a tiny swarm can
      // never drop to zero.
      {
        int proven = 0;
        for (size_t i = 0; i < g_peers.size(); i++)
          if (g_peers[i]->connected && g_peers[i]->unchoked && g_peers[i]->rxBytes) proven++;
        for (size_t i = 0; i < g_peers.size(); i++) {
          Peer* p = g_peers[i];
          if (p->outstanding <= 0 || !p->waitSince || tick - p->waitSince <= kWireTimeoutMs)
            continue;
          g_wireTimeouts++;
          if (p->rxBytes && proven <= 1) { releaseRequests(p); continue; }
          if (p->rxBytes) proven--;
          pthread_mutex_lock(&g_lock); g_peers.erase(g_peers.begin() + i); pthread_mutex_unlock(&g_lock);
          closePeer(p); delete p;
          i--;
        }
      }

      // Selection: the next kSelectAhead missing pieces from the read head, in
      // order (torrent-stream selects the file from the stream's read piece
      // and walks it in order). The first ~1 MB of it is "critical": blocks
      // there may be hot-swapped from slow peers to fast ones.
      int head = (g_urgentPiece >= g_firstPiece && g_urgentPiece <= g_lastPiece)
                     ? g_urgentPiece : target;
      std::vector<int> sel;
      {
        int limit = std::min(g_lastPiece, head + kPiecesPerWindow - 8);
        pthread_mutex_lock(&g_lock);
        for (int j = head; j <= limit && (int)sel.size() < kSelectAhead; j++) {
          std::map<int, int>::iterator it = g_slotOf.find(j);
          bool have = it != g_slotOf.end() && g_window[it->second].have &&
                      g_window[it->second].index == j;
          if (have) { if (g_urgentPiece == j) g_urgentPiece = -1; continue; }
          sel.push_back(j);
        }
        pthread_mutex_unlock(&g_lock);
      }
      int curSel = (int)sel.size();
      if (g_prefFirst >= 0 && curSel < kSelectAhead) {
        // Spare capacity near the end of an episode: pre-load the next one.
        pthread_mutex_lock(&g_lock);
        for (int j = g_prefFirst; j <= g_prefLast + 1 && (int)sel.size() < kSelectAhead; j++) {
          int pj = (j <= g_prefLast) ? j : g_prefTail;
          if (pj < 0 || (j > g_prefLast && pj <= g_prefLast && pj >= g_prefFirst)) continue;
          std::map<int, int>::iterator it = g_slotOf.find(pj);
          bool have = it != g_slotOf.end() && g_window[it->second].have && g_window[it->second].index == pj;
          if (!have && std::find(sel.begin(), sel.end(), pj) == sel.end()) sel.push_back(pj);
        }
        pthread_mutex_unlock(&g_lock);
      }
      g_activePiece = sel.empty() ? -1 : sel[0];
      int critN = (int)std::max<uint64_t>(1, std::min<uint64_t>(4, (1024 * 1024) / g_pieceLength));

      int unchokedN = 0;
      for (size_t i = 0; i < g_peers.size(); i++)
        if (g_peers[i]->connected && g_peers[i]->unchoked) unchokedN++;
      int depth = requestDepth(unchokedN);
      g_depth = depth;

      int noBits = 0;
      for (size_t i = 0; i < g_peers.size(); i++) {
        Peer* p = g_peers[i];
        if (!p->connected) continue;
        if (!p->interestedSent) sendInterested(p);
        if (p->bits.empty()) noBits++;
        if (sel.empty() || !p->unchoked || p->outstanding >= depth) continue;
        if (!p->rxBytes) {
          // Unproven peer: a single request from the far end of the selection,
          // so a dud can't hold up the piece the player is waiting for.
          if (p->outstanding == 0)
            for (int k = (int)sel.size() - 1; k >= 0; k--)
              if (peerHas(p, sel[k]) && requestFreeBlock(p, sel[k], tick) != 0) break;
          continue;
        }
        int tries = 10;
        bool failed = false;
        for (size_t k = 0; k < sel.size() && !failed && p->outstanding < depth; k++) {
          int piece = sel[k];
          if (!peerHas(p, piece)) continue;
          if (!rankOk(p, piece, depth, &tries)) continue;
          bool critical = (int)k < critN && (int)k < curSel;
          int swaps = 0;
          while (p->outstanding < depth) {
            int r = requestFreeBlock(p, piece, tick);
            if (r < 0) { failed = true; break; }
            if (r > 0) continue;
            if (critical && swaps < 4 && hotswapPiece(p, piece)) { swaps++; continue; }
            break;
          }
        }
      }
      g_noHave = noBits;
    }

    // Pump all peers.
    for (size_t i = 0; i < g_peers.size(); i++) {
      if (!pumpPeer(g_peers[i], &metaChunks, &metaTotal)) {
        Peer* dp = g_peers[i];
        pthread_mutex_lock(&g_lock); g_peers.erase(g_peers.begin() + i); pthread_mutex_unlock(&g_lock);
        closePeer(dp);
        delete dp;
        i--;
      }
    }
    pthread_mutex_lock(&g_lock); g_peerCount = (int)g_peers.size(); pthread_mutex_unlock(&g_lock);
    // Only nap when no data moved; while data flows go straight back to
    // pumping (Node's event loop never sleeps while sockets are readable).
    usleep(g_pumpBytes ? 500 : 5000);
    g_pumpBytes = 0;
  }

  for (size_t i = 0; i < g_connecting.size(); i++) { close(g_connecting[i].fd); delete g_connecting[i].p; }
  g_connecting.clear();
  for (size_t i = 0; i < g_peers.size(); i++) { closePeer(g_peers[i]); delete g_peers[i]; }
  g_peers.clear();
  pthread_mutex_lock(&g_lock);
  for (size_t i = 0; i < g_hsDone.size(); i++) {
    if (g_hsDone[i]->fd >= 0) close(g_hsDone[i]->fd);
    delete g_hsDone[i];
  }
  g_hsDone.clear();
  pthread_mutex_unlock(&g_lock);
  return 0;
}

// ---------------------------------------------------------------------------
// local HTTP server with Range support
// ---------------------------------------------------------------------------
static std::string httpHeaders(int code, const std::string& reason, uint64_t length,
                               uint64_t start, uint64_t end, uint64_t total) {
  std::ostringstream h;
  h << "HTTP/1.1 " << code << " " << reason << "\r\n";
  h << "Content-Type: application/octet-stream\r\n";
  h << "Accept-Ranges: bytes\r\n";
  h << "Content-Length: " << length << "\r\n";
  if (code == 206)
    h << "Content-Range: bytes " << start << "-" << end << "/" << total << "\r\n";
  h << "Access-Control-Allow-Origin: *\r\n";
  h << "Connection: close\r\n\r\n";
  return h.str();
}

static void serveClient(int fd) {
  setNonblocking(fd);
  std::string req;
  char buf[4096];
  uint64_t dead = nowMs() + 5000;
  while (req.find("\r\n\r\n") == std::string::npos && nowMs() < dead) {
    if (!waitFd(fd, POLLIN, 1000)) continue;
    ssize_t n = recv(fd, buf, sizeof(buf), 0);
    if (n <= 0) { close(fd); return; }
    req.append(buf, (size_t)n);
  }
  if (req.find("\r\n\r\n") == std::string::npos) { close(fd); return; }

  std::string line = req.substr(0, req.find("\r\n"));
  std::istringstream ls(line);
  std::string method, path, proto;
  ls >> method >> path >> proto;
  if (method != "GET") { std::string s = "HTTP/1.1 405 Method Not Allowed\r\nContent-Length: 0\r\n\r\n"; sendAll(fd, s.data(), s.size()); close(fd); return; }

  // stats endpoint for the UI
  if (path.find("/stats/") == 0) {
    std::string body = statsJson();
    std::ostringstream h;
    h << "HTTP/1.1 200 OK\r\nContent-Type: application/json\r\nContent-Length: "
      << body.size() << "\r\nAccess-Control-Allow-Origin: *\r\nConnection: close\r\n\r\n";
    std::string out = h.str() + body;
    sendAll(fd, out.data(), out.size()); close(fd); return;
  }

  g_httpReqs++;

  // Expected path: /<infohash>/<fileIdx>
  size_t slash = path.find('/', 1);
  if (slash == std::string::npos) { close(fd); return; }
  std::string hash = path.substr(1, slash - 1);
  int idx = atoi(path.c_str() + slash + 1);
  if (hash != g_hashHex || idx != g_fileIdxReq) {
    std::string s = "HTTP/1.1 404 Not Found\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\n\r\n";
    sendAll(fd, s.data(), s.size()); close(fd); return;
  }
  // Metadata (ut_metadata) can take tens of seconds on this TV. The HTTP
  // server is multi-threaded, so it is safe to hold this request open and
  // wait rather than 404 it. The old 404-while-not-ready behavior made the
  // player give up after ~21 requests, long before metadata ever arrived
  // (signature: httpReqs frozen with httpLastCode==0 -- those requests never
  // reached the range-serving code below).
  {
    uint64_t metaDead = nowMs() + 120000;
    while (!g_metaReady && g_running && nowMs() < metaDead) usleep(50000);
  }
  if (!g_metaReady || g_fileEnd <= g_fileStart) {
    g_httpLastCode = 503;
    std::string s = "HTTP/1.1 503 Service Unavailable\r\nContent-Length: 0\r\nAccess-Control-Allow-Origin: *\r\n\r\n";
    sendAll(fd, s.data(), s.size()); close(fd); return;
  }

  uint64_t fileLen = g_fileEnd - g_fileStart;
  uint64_t start = 0, end = fileLen - 1;
  bool ranged = false;
  size_t rp = req.find("Range: bytes=");
  if (rp == std::string::npos) rp = req.find("range: bytes=");
  if (rp != std::string::npos) {
    rp += strlen("Range: bytes=");
    size_t dash = req.find('-', rp);
    if (dash != std::string::npos) {
      start = strtoull(req.c_str() + rp, 0, 10);
      if (dash + 1 < req.size() && req[dash + 1] != '\r' && req[dash + 1] != '\n')
        end = strtoull(req.c_str() + dash + 1, 0, 10);
      if (end >= fileLen) end = fileLen - 1;
      ranged = true;
    }
  }
  if (start > end || start >= fileLen) {
    std::ostringstream h;
    h << "HTTP/1.1 416 Requested Range Not Satisfiable\r\nContent-Range: bytes */"
      << fileLen << "\r\nContent-Length: 0\r\n\r\n";
    std::string s = h.str(); sendAll(fd, s.data(), s.size()); close(fd); return;
  }

  // Like the Android server, answer with the WHOLE requested range and pipe
  // it as pieces arrive (one long-lived response). The old 8 MB cap and the
  // 180 s total deadline cut long videos off mid-stream.
  uint64_t len = end - start + 1;
  g_httpLastStart = start; g_httpLastLen = len;
  int session = g_session, fileGen = g_fileGen;
  int seq;
  pthread_mutex_lock(&g_lock); seq = ++g_streamSeq; pthread_mutex_unlock(&g_lock);

  std::string header = httpHeaders(ranged ? 206 : 200,
                                   ranged ? "Partial Content" : "OK",
                                   len, start, end, fileLen);
  if (!sendAll(fd, header.data(), header.size())) { close(fd); return; }
  g_httpLastCode = ranged ? 206 : 200;

  uint64_t pos = g_fileStart + start;
  uint64_t endPos = pos + len;
  uint64_t idleDead = nowMs() + 120000;     // give up only after 120 s without progress
  while (pos < endPos && g_running && session == g_session && fileGen == g_fileGen && nowMs() < idleDead) {
    uint64_t avail = availableFrom(pos, endPos - pos, seq);
    if (avail == 0) { usleep(50000); continue; }
    if (avail > 512 * 1024) avail = 512 * 1024;   // keep send iterations short
    std::string chunk;
    if (!copyRange(pos, avail, &chunk)) { usleep(50000); continue; }
    // A paused player stops reading; allow a long send wait before giving up
    // (the player simply re-requests the range when it resumes).
    if (!sendAllFor(fd, chunk.data(), chunk.size(), 1800000)) break;   // paused player: keep up to 30 min
    pos += chunk.size();
    idleDead = nowMs() + 120000;
  }
  pthread_mutex_lock(&g_lock);
  if (g_headSeq == seq) g_headSeq = 0;      // let an older open stream take over
  pthread_mutex_unlock(&g_lock);
  close(fd);
}

// One thread per client: a stream request waiting for pieces must not block
// /stats polling or the player's other range requests.
static void* serveClientThread(void* arg) {
  int fd = (int)(intptr_t)arg;
  serveClient(fd);
  return 0;
}

static void* httpLoop(void*) {
  struct sockaddr_in addr;
  memset(&addr, 0, sizeof(addr));
  addr.sin_family = AF_INET;
  addr.sin_port = htons(kHttpPort);
  addr.sin_addr.s_addr = htonl(INADDR_ANY);
  int server = -1;
  // A previous engine instance may still hold the port briefly after relaunch.
  for (int attempt = 0; attempt < 20 && g_running; attempt++) {
    server = socket(AF_INET, SOCK_STREAM, 0);
    if (server < 0) { usleep(500000); continue; }
    int one = 1;
    setsockopt(server, SOL_SOCKET, SO_REUSEADDR, &one, sizeof(one));
    if (bind(server, (struct sockaddr*)&addr, sizeof(addr)) == 0) break;
    close(server); server = -1;
    usleep(500000);
  }
  if (server < 0) {
    g_httpBindFail = 1;
    // Let a retried start command rebuild everything. Otherwise g_running
    // stays true and start() returns immediately, leaving no HTTP server.
    g_running = false;
    return 0;
  }
  g_httpBindFail = 0;
  listen(server, 16);
  setNonblocking(server);
  while (g_running) {
    if (!waitFd(server, POLLIN, 500)) continue;
    struct sockaddr_in cli; socklen_t cl = sizeof(cli);
    int fd = accept(server, (struct sockaddr*)&cli, &cl);
    if (fd < 0) continue;
    pthread_t th;
    if (pthread_create(&th, 0, serveClientThread, (void*)(intptr_t)fd) == 0)
      pthread_detach(th);
    else
      close(fd);
  }
  close(server);
  return 0;
}

// ---------------------------------------------------------------------------
// public API
// ---------------------------------------------------------------------------
// Bytes cached contiguously from `start` (no side effects, unlike availableFrom).
static uint64_t cachedFrom(uint64_t start, uint64_t maxLen) {
  if (!g_metaReady || g_pieceLength == 0) return 0;
  uint64_t pos = start, end = start + maxLen;
  pthread_mutex_lock(&g_lock);
  while (pos < end) {
    int global = (int)(pos / g_pieceLength);
    std::map<int, int>::iterator it = g_slotOf.find(global);
    if (it == g_slotOf.end()) break;
    const PieceSlot& slot = g_window[it->second];
    if (!slot.have || slot.index != global) break;
    uint64_t inPiece = pos - (uint64_t)global * g_pieceLength;
    if (inPiece >= slot.data.size()) break;
    uint64_t take = slot.data.size() - inPiece;
    if (take > end - pos) take = end - pos;
    pos += take;
  }
  pthread_mutex_unlock(&g_lock);
  return pos - start;
}

std::string statsJson() {
  // % of the next 4 MB at the playing spot that has arrived (whole pieces +
  // blocks of the piece being assembled): shown inside the player's loader.
  int bufPct = 0;
  if (g_metaReady && g_pieceLength) {
    const uint64_t target = 4ull * 1048576;
    uint64_t want = g_wantOffset, have = cachedFrom(want, target);
    if (have < target) {
      int p = (int)((want + have) / g_pieceLength);
      pthread_mutex_lock(&g_lock);
      std::map<int, std::set<int> >::iterator gi = g_pieceBlocks.find(p);
      if (gi != g_pieceBlocks.end()) have += (uint64_t)gi->second.size() * kBlockSize;
      pthread_mutex_unlock(&g_lock);
      if (have > target) have = target;
    }
    bufPct = (int)(have * 100 / target);
  }
  int haveCount = 0, interestedCount = 0, unchokedCount = 0, outstandingCount = 0;
  pthread_mutex_lock(&g_lock);
  for (size_t i = 0; i < g_window.size(); i++) if (g_window[i].have) haveCount++;
  std::ostringstream peerSpeeds;
  for (size_t i = 0; i < g_peers.size(); i++) {
    if (i) peerSpeeds << ",";
    peerSpeeds << g_peers[i]->speed;
    if (g_peers[i]->interestedSent) interestedCount++;
    if (g_peers[i]->unchoked) unchokedCount++;
    outstandingCount += g_peers[i]->outstanding;
  }
  int assembling = (int)g_pieceBuf.size();
  int reqCount = (int)g_reqBlocks.size();
  pthread_mutex_unlock(&g_lock);
  std::ostringstream s;
  s << "{\"hash\":\"" << g_hashHex << "\",\"downloadSpeed\":" << g_speed
    << ",\"downloaded\":" << g_downloaded
    << ",\"peers\":" << g_peerCount
    << ",\"ready\":" << (g_metaReady ? "true" : "false")
    << ",\"announceOk\":" << g_announceOk
    << ",\"announceFail\":" << g_announceFail
    << ",\"found\":" << g_peersFound
    << ",\"connOk\":" << g_connectOk
    << ",\"connFail\":" << g_connectFail
    << ",\"connErr\":" << g_lastConnErr
    << ",\"hsOk\":" << g_hsOk << ",\"hsFail\":" << g_hsFail << ",\"hsErr\":" << g_lastHsErr
    << ",\"hsRx\":" << g_hsRecvBytes << ",\"hsZero\":" << g_hsZeroReads
    << ",\"tcpLocal\":" << g_tcpLocal << ",\"tcpLocalErr\":" << g_tcpLocalErr
    << ",\"tcpRemote\":" << g_tcpRemote << ",\"tcpRemoteErr\":" << g_tcpRemoteErr
    << ",\"tcp80\":" << g_tcpPort80 << ",\"tcp80Err\":" << g_tcpPort80Err
    << ",\"tcpHi\":" << g_tcpHighPort << ",\"tcpHiErr\":" << g_tcpHighPortErr
    << ",\"stage\":" << g_stage << ",\"attempts\":" << g_attempts
    << ",\"bindFail\":" << g_httpBindFail
    << ",\"sample\":\"" << g_samplePeer << "\""
    << ",\"streamName\":\"" << g_streamName << "\""
    << ",\"streamLen\":" << (g_metaReady ? g_fileEnd - g_fileStart : 0)
    << ",\"pieceLen\":" << g_pieceLength << ",\"have\":" << haveCount
    << ",\"urgent\":" << g_urgentPiece << ",\"firstPiece\":" << g_firstPiece
    << ",\"activePiece\":" << g_activePiece
    << ",\"assembling\":" << assembling << ",\"blocksRx\":" << g_blocksRx
    << ",\"verifyFail\":" << g_pieceVerifyFail << ",\"reqCount\":" << reqCount
    << ",\"stallRecovery\":" << g_stallRecovery
    << ",\"httpReqs\":" << g_httpReqs << ",\"httpLastCode\":" << g_httpLastCode
    << ",\"httpLastStart\":" << g_httpLastStart << ",\"httpLastLen\":" << g_httpLastLen
    << ",\"interested\":" << interestedCount
    << ",\"unchoked\":" << unchokedCount << ",\"outstanding\":" << outstandingCount
    << ",\"depth\":" << g_depth << ",\"hotswaps\":" << g_hotswaps
    << ",\"wireTimeouts\":" << g_wireTimeouts << ",\"noBitfield\":" << g_noHave
    << ",\"hsThreads\":" << g_hsInFlight << ",\"pending\":" << g_pendingPeers
    << ",\"peerSpeeds\":[" << peerSpeeds.str() << "]"
    << ",\"trackers\":" << g_trackers.size() << ",\"trackerPeers\":" << g_trackerPeers
    << ",\"dhtNodes\":" << g_dhtNodes << ",\"dhtQueries\":" << g_dhtQueries
    << ",\"dhtResponses\":" << g_dhtResponses << ",\"dhtPeers\":" << g_dhtPeers
    << ",\"bufPct\":" << bufPct << ",\"prefetchIdx\":" << g_prefetchIdx << ",\"fileIdx\":" << g_fileIdx
    << ",\"plog\":[";
  pthread_mutex_lock(&g_lock);
  for (size_t i = 0; i < g_attemptLog.size(); i++) {
    const PeerAttempt& a = g_attemptLog[i];
    if (i) s << ",";
    s << "{\"p\":\"" << a.peer << "\",\"c\":" << a.connected
      << ",\"ce\":" << a.connErr << ",\"h\":" << a.handshake
      << ",\"he\":" << a.hsErr << ",\"rx\":" << a.rx
      << ",\"z\":" << a.zero << ",\"ms\":" << a.ms
      << ",\"so\":" << a.sendOk << ",\"se\":" << a.sendErr
      << ",\"fr\":" << a.firstRecv << ",\"fe\":" << a.firstRecvErr
      << ",\"oe\":" << a.soErr << "}";
  }
  pthread_mutex_unlock(&g_lock);
  s << "]}";
  return s.str();
}

void stop();

void start(const std::string& hashHex, int fileIdx) {
  if (g_running) {
    // Same torrent and file (e.g. the page re-posting its start command): keep going.
    if (hashHex == g_hashHex && fileIdx == g_fileIdxReq) return;
    // Same torrent, another file (next episode of a season pack): switch in
    // place -- keep peers, metadata and the pre-loaded pieces -- no restart.
    if (hashHex == g_hashHex && g_metaReady) {
      pthread_mutex_lock(&g_lock);
      g_fileIdxReq = fileIdx;
      g_fileNameHint = g_nextFileName;
      selectFile();
      g_nextPiece = g_firstPiece; g_wantOffset = g_fileStart;
      g_urgentPiece = -1; g_headSeq = 0; g_fileGen++;
      g_prefetchIdx = g_prefFirst = g_prefLast = g_prefTail = -1;
      pthread_mutex_unlock(&g_lock);
      return;
    }
    // A different torrent or episode: restart. The old code silently kept the
    // previous torrent, so the new stream's requests got 404 ("cannot play").
    stop();
  }
  if (!hexBytes(hashHex, g_hash)) return;
  g_hashHex = hashHex;
  g_fileIdxReq = fileIdx;
  g_fileIdx = fileIdx < 0 ? 0 : fileIdx;
  g_fileNameHint = g_nextFileName;
  g_streamTrackers.clear();
  {
    const std::string& csv = g_nextTrackersCsv;
    size_t st = 0;
    while (st < csv.size()) {
      size_t c = csv.find(',', st);
      if (c == std::string::npos) c = csv.size();
      if (c > st) g_streamTrackers.push_back(csv.substr(st, c - st));
      st = c + 1;
    }
  }
  {
    static const char kAlnum[] = "abcdefghijklmnopqrstuvwxyz0123456789";
    srand((unsigned)(nowMs() ^ (uint64_t)(uintptr_t)&g_peerId));
    g_peerId = "-TS0008-";
    for (int i = 0; i < 12; i++) g_peerId += kAlnum[rand() % 36];
  }
  g_headSeq = 0; g_fileGen++;
  g_prefetchIdx = g_prefFirst = g_prefLast = g_prefTail = -1;
  g_metaReady = false; g_downloaded = 0; g_speed = 0; g_speedBytes = 0;
  g_speedAt = nowMs(); g_peerCount = 0;
  g_announceOk = g_announceFail = g_peersFound = 0;
  g_connectOk = g_connectFail = g_lastConnErr = 0;
  g_hsOk = g_hsFail = g_lastHsErr = 0;
  g_tcpLocal = g_tcpRemote = g_tcpPort80 = g_tcpHighPort = -1;
  g_tcpLocalErr = g_tcpRemoteErr = g_tcpPort80Err = g_tcpHighPortErr = 0;
  g_stage = 0; g_attempts = 0; g_samplePeer.clear(); g_httpBindFail = 0;
  g_attemptLog.clear(); g_hsRecvBytes = 0; g_hsZeroReads = 0;
  for (size_t i = 0; i < g_connecting.size(); i++) { close(g_connecting[i].fd); delete g_connecting[i].p; }
  g_connecting.clear();
  g_files.clear(); g_window.clear(); g_slotOf.clear(); g_pieceBuf.clear();
  g_pieceBlocks.clear(); g_reqBlocks.clear(); g_reqTime.clear(); g_reqOwner.clear();
  g_activePiece = -1; g_blocksRx = 0; g_pieceVerifyFail = 0;
  g_urgentPiece = -1; g_urgentSince = 0;
  g_lastBlockAt = 0; g_stallRecovery = 0;
  g_depth = g_hotswaps = g_wireTimeouts = g_noHave = 0;
  g_pendingPeers = 0; g_pumpBytes = 0;
  pthread_mutex_lock(&g_lock);
  g_session++; g_hsInFlight = 0;
  g_discovered.clear(); g_wantPeers = true;
  g_dhtNodes = g_dhtQueries = g_dhtResponses = g_dhtPeers = g_trackerPeers = 0;
  for (size_t i = 0; i < g_hsDone.size(); i++) {
    if (g_hsDone[i]->fd >= 0) close(g_hsDone[i]->fd);
    delete g_hsDone[i];
  }
  g_hsDone.clear();
  pthread_mutex_unlock(&g_lock);
  g_trackers.clear(); initTrackers();
  g_running = true;
  pthread_create(&g_httpThread, 0, httpLoop, 0);
  pthread_create(&g_peerThread, 0, peerLoop, 0);
  pthread_create(&g_discThread, 0, discoveryLoop, (void*)(intptr_t)g_session);
}

// Peer sources and file-name hint for the NEXT start() (may be called while a
// previous torrent is still running).
void setTrackers(const std::string& csv) { g_nextTrackersCsv = csv; }
void setFileName(const std::string& name) { g_nextFileName = name; }

// Pre-load the start (16 MB) and the last piece of another file of the running
// torrent, at low priority, so switching to it starts at once.
void prefetch(int fileIdx) {
  if (!g_running || !g_metaReady || g_pieceLength == 0) return;
  pthread_mutex_lock(&g_lock);
  if (fileIdx >= 0 && fileIdx < (int)g_files.size() && fileIdx != g_fileIdx && g_files[fileIdx].length > 0) {
    uint64_t fs = g_files[fileIdx].offset, fe = fs + g_files[fileIdx].length;
    uint64_t headEnd = std::min<uint64_t>(fe, fs + 16ull * 1048576);
    g_prefFirst = (int)(fs / g_pieceLength);
    g_prefLast = (int)((headEnd - 1) / g_pieceLength);
    g_prefTail = (int)((fe - 1) / g_pieceLength);
    g_prefetchIdx = fileIdx;
  }
  pthread_mutex_unlock(&g_lock);
}

void stop() {
  if (!g_running) return;
  g_running = false;
  pthread_join(g_peerThread, 0);
  pthread_join(g_httpThread, 0);
  pthread_join(g_discThread, 0);
}

}  // namespace engine
}  // namespace stremio

#ifndef STREMIO_ENGINE_API_H
#define STREMIO_ENGINE_API_H
#include <string>
namespace stremio { namespace engine {
void start(const std::string& hashHex, int fileIdx);
// Comma-separated Stremio peer sources for the next start() ("tracker:udp://...").
void setTrackers(const std::string& csv);
// Addon behaviorHints.filename for the next start() (used when fileIdx is -1).
void setFileName(const std::string& name);
// Pre-load the start + last piece of another file of the running torrent.
void prefetch(int fileIdx);
void stop();
std::string statsJson();
}}
#endif

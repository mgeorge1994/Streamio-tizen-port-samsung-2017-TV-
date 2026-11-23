// Compact public-domain SHA-1 implementation (no OpenSSL dependency in NaCl).
#ifndef STREMIO_SHA1_H
#define STREMIO_SHA1_H

#include <string>
#include <cstring>
#include <cstdint>

namespace stremio {

class Sha1 {
 public:
  Sha1() { reset(); }
  void reset() {
    h_[0] = 0x67452301; h_[1] = 0xEFCDAB89; h_[2] = 0x98BADCFE;
    h_[3] = 0x10325476; h_[4] = 0xC3D2E1F0;
    total_ = 0; bufLen_ = 0;
  }
  void update(const void* data, size_t len) {
    const uint8_t* p = (const uint8_t*)data;
    total_ += len;
    while (len) {
      size_t n = 64 - bufLen_;
      if (n > len) n = len;
      memcpy(buf_ + bufLen_, p, n);
      bufLen_ += n; p += n; len -= n;
      if (bufLen_ == 64) { transform(buf_); bufLen_ = 0; }
    }
  }
  void finish(uint8_t out[20]) {
    uint64_t bits = total_ * 8;
    uint8_t pad = 0x80;
    update(&pad, 1);
    pad = 0;
    while (bufLen_ != 56) update(&pad, 1);
    uint8_t tail[8];
    for (int i = 7; i >= 0; i--) { tail[i] = (uint8_t)(bits & 0xff); bits >>= 8; }
    update(tail, 8);
    for (int i = 0; i < 5; i++)
      for (int j = 3; j >= 0; j--) out[i * 4 + j] = (uint8_t)(h_[i] >> (8 * (3 - j)));
  }
  std::string hex() {
    uint8_t d[20]; finish(d);
    static const char* chars = "0123456789abcdef";
    std::string s; s.reserve(40);
    for (int i = 0; i < 20; i++) { s += chars[d[i] >> 4]; s += chars[d[i] & 15]; }
    return s;
  }
  static std::string hashHex(const std::string& data) {
    Sha1 s; s.update(data.data(), data.size()); return s.hex();
  }
  static void hashBytes(const std::string& data, uint8_t out[20]) {
    Sha1 s; s.update(data.data(), data.size()); s.finish(out);
  }

 private:
  static uint32_t rol(uint32_t v, int n) { return (v << n) | (v >> (32 - n)); }
  void transform(const uint8_t block[64]) {
    uint32_t w[80];
    for (int i = 0; i < 16; i++)
      w[i] = ((uint32_t)block[i*4] << 24) | ((uint32_t)block[i*4+1] << 16) |
             ((uint32_t)block[i*4+2] << 8) | block[i*4+3];
    for (int i = 16; i < 80; i++) w[i] = rol(w[i-3] ^ w[i-8] ^ w[i-14] ^ w[i-16], 1);
    uint32_t a=h_[0], b=h_[1], c=h_[2], d=h_[3], e=h_[4];
    for (int i = 0; i < 80; i++) {
      uint32_t f, k;
      if (i < 20) { f = (b & c) | ((~b) & d); k = 0x5A827999; }
      else if (i < 40) { f = b ^ c ^ d; k = 0x6ED9EBA1; }
      else if (i < 60) { f = (b & c) | (b & d) | (c & d); k = 0x8F1BBCDC; }
      else { f = b ^ c ^ d; k = 0xCA62C1D6; }
      uint32_t t = rol(a,5) + f + e + k + w[i];
      e=d; d=c; c=rol(b,30); b=a; a=t;
    }
    h_[0]+=a; h_[1]+=b; h_[2]+=c; h_[3]+=d; h_[4]+=e;
  }
  uint32_t h_[5];
  uint64_t total_;
  uint8_t buf_[64];
  size_t bufLen_;
};

}  // namespace stremio

#endif

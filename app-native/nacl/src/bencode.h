// Minimal bencode decoder for the on-device torrent engine.
// Kept header-only so the NaCl build stays a single translation unit set.
#ifndef STREMIO_BENCODE_H
#define STREMIO_BENCODE_H

#include <string>
#include <vector>
#include <map>
#include <cstdlib>
#include <cstdio>

namespace stremio {

struct BValue {
  enum Type { NONE, INT, STR, LIST, DICT } type;
  long long integer;
  std::string str;
  std::vector<BValue> list;
  std::map<std::string, BValue> dict;

  BValue() : type(NONE), integer(0) {}

  const BValue* get(const char* key) const {
    if (type != DICT) return 0;
    std::map<std::string, BValue>::const_iterator it = dict.find(key);
    return it == dict.end() ? 0 : &it->second;
  }
};

class BDecoder {
 public:
  explicit BDecoder(const std::string& data) : data_(data), pos_(0), ok_(true) {}

  bool ok() const { return ok_; }
  size_t pos() const { return pos_; }

  BValue parse() {
    BValue v = parseValue(0);
    return v;
  }

  // Parse the info dictionary from a metainfo file, returning the exact raw
  // byte range so the info-hash can be verified with SHA1.
  BValue parseInfoRaw(std::string* raw) {
    BValue top = parse();
    if (!ok_ || top.type != BValue::DICT || raw == 0) return BValue();
    std::map<std::string, BValue>::iterator it = top.dict.find("info");
    if (it == top.dict.end()) return BValue();
    // Re-scan the original buffer to find the raw info value boundaries.
    BDecoder scan(data_);
    BValue t = scan.parse();
    (void)t;
    size_t start = findKeySpan("info", &start_, &end_);
    if (start == std::string::npos) return BValue();
    *raw = data_.substr(start_, end_ - start_);
    return it->second;
  }

 private:
  const std::string& data_;
  size_t pos_;
  bool ok_;
  size_t start_, end_;

  bool atEnd() const { return pos_ >= data_.size(); }
  char peek() const { return atEnd() ? 0 : data_[pos_]; }

  // Locate the raw bytes of a top-level dictionary key's value.
  size_t findKeySpan(const char* key, size_t* outStart, size_t* outEnd) {
    BDecoder d(data_);
    if (!d.consumeDictSpan(key, outStart, outEnd)) return std::string::npos;
    return *outStart;
  }

  bool consumeDictSpan(const char* key, size_t* outStart, size_t* outEnd) {
    if (peek() != 'd') return false;
    pos_++;
    while (!atEnd() && peek() != 'e') {
      std::string k = parseString();
      if (!ok_) return false;
      size_t s = pos_;
      skipValue();
      if (!ok_) return false;
      size_t e = pos_;
      if (k == key) { *outStart = s; *outEnd = e; return true; }
    }
    return false;
  }

  void skipValue() {
    if (atEnd()) { ok_ = false; return; }
    char c = peek();
    if (c == 'i') {
      while (!atEnd() && peek() != 'e') pos_++;
      if (atEnd()) { ok_ = false; return; }
      pos_++;
    } else if (c >= '0' && c <= '9') {
      std::string s = parseString();
      (void)s;
    } else if (c == 'l') {
      pos_++;
      while (!atEnd() && peek() != 'e') skipValue();
      if (atEnd()) { ok_ = false; return; }
      pos_++;
    } else if (c == 'd') {
      pos_++;
      while (!atEnd() && peek() != 'e') { parseString(); skipValue(); }
      if (atEnd()) { ok_ = false; return; }
      pos_++;
    } else {
      ok_ = false;
    }
  }

  std::string parseString() {
    if (atEnd() || peek() < '0' || peek() > '9') { ok_ = false; return std::string(); }
    size_t len = 0;
    while (!atEnd() && peek() >= '0' && peek() <= '9') {
      len = len * 10 + (size_t)(peek() - '0');
      pos_++;
    }
    if (atEnd() || peek() != ':') { ok_ = false; return std::string(); }
    pos_++;
    if (pos_ + len > data_.size()) { ok_ = false; return std::string(); }
    std::string s = data_.substr(pos_, len);
    pos_ += len;
    return s;
  }

  BValue parseValue(int depth) {
    BValue v;
    if (depth > 64 || atEnd()) { ok_ = false; return v; }
    char c = peek();
    if (c == 'i') {
      pos_++;
      size_t s = pos_;
      while (!atEnd() && peek() != 'e') pos_++;
      if (atEnd()) { ok_ = false; return v; }
      std::string n = data_.substr(s, pos_ - s);
      pos_++;
      v.type = BValue::INT;
      v.integer = strtoll(n.c_str(), 0, 10);
    } else if (c >= '0' && c <= '9') {
      v.type = BValue::STR;
      v.str = parseString();
    } else if (c == 'l') {
      pos_++;
      v.type = BValue::LIST;
      while (!atEnd() && peek() != 'e') v.list.push_back(parseValue(depth + 1));
      if (atEnd() || peek() != 'e') { ok_ = false; return v; }
      pos_++;
    } else if (c == 'd') {
      pos_++;
      v.type = BValue::DICT;
      while (!atEnd() && peek() != 'e') {
        std::string k = parseString();
        BValue child = parseValue(depth + 1);
        if (!ok_) return v;
        v.dict[k] = child;
      }
      if (atEnd() || peek() != 'e') { ok_ = false; return v; }
      pos_++;
    } else {
      ok_ = false;
    }
    return v;
  }
};

inline std::string bencodeString(const std::string& s) {
  char buf[32];
  snprintf(buf, sizeof(buf), "%d:", (int)s.size());
  return std::string(buf) + s;
}

}  // namespace stremio

#endif

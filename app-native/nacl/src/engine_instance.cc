// PPAPI instance: bridge between the Tizen web widget and the native engine.
#include "engine_api.h"

#include <nacl_io/nacl_io.h>
#include <ppapi/c/ppb.h>
#include <ppapi/cpp/instance.h>
#include <ppapi/cpp/module.h>
#include <ppapi/cpp/var.h>
#include <ppapi/cpp/var_dictionary.h>

#include <deque>
#include <pthread.h>
#include <string>

namespace {

struct LifeCmd {
  bool isStart;
  std::string hash;
  int fileIdx;
  std::string trackers;
  std::string fileName;
};

pthread_mutex_t g_qLock = PTHREAD_MUTEX_INITIALIZER;
pthread_cond_t g_qCond = PTHREAD_COND_INITIALIZER;
std::deque<LifeCmd> g_queue;
bool g_quit = false;
bool g_workerOk = false;
pthread_t g_worker;

}  // namespace

class StremioEngineInstance : public pp::Instance {
 public:
  explicit StremioEngineInstance(PP_Instance instance) : pp::Instance(instance) {}

  virtual bool Init(uint32_t argc, const char* argn[], const char* argv[]) {
    // Report that the module itself loaded BEFORE nacl_io runs. If nacl_io
    // blocks or crashes on a given firmware, we can still see how far it got.
    PostMessage(pp::Var(std::string("{\"event\":\"init\",\"ok\":true,\"stage\":\"loaded\"}")));
    // nacl_io gives the engine POSIX sockets (TCP/UDP) and pthreads.
    int r = nacl_io_init_ppapi(pp_instance(), pp::Module::Get()->get_browser_interface());
    PostMessage(pp::Var(std::string("{\"event\":\"stage\",\"name\":\"nacl_io\",\"ok\":") +
                        (r == 0 ? "true" : "false") + "}"));

    // start()/stop() join the engine's worker threads. Running them inside
    // HandleMessage used to block the PPAPI message thread, so every later
    // ping/stats/start reply was stuck behind a blocked lifecycle command.
    pthread_mutex_lock(&g_qLock);
    while (!g_queue.empty()) g_queue.pop_front();
    g_quit = false;
    pthread_mutex_unlock(&g_qLock);
    g_workerOk = (pthread_create(&g_worker, 0, lifecycleWorker, this) == 0);
    return true;
  }

  virtual void HandleMessage(const pp::Var& message) {
    if (!message.is_dictionary()) return;
    pp::VarDictionary d(message);
    pp::Var cmdVar = d.Get("cmd");
    if (!cmdVar.is_string()) return;
    std::string cmd = cmdVar.AsString();

    if (cmd == "start") {
      pp::Var h = d.Get("hash");
      pp::Var i = d.Get("fileIdx");
      if (!h.is_string()) {
        postEvent("error", "missing hash");
        return;
      }
      LifeCmd c;
      c.isStart = true;
      c.hash = h.AsString();
      c.fileIdx = i.is_number() ? (int)i.AsInt() : 0;
      pp::Var tr = d.Get("trackers");
      pp::Var fn = d.Get("fileName");
      c.trackers = tr.is_string() ? tr.AsString() : std::string();
      c.fileName = fn.is_string() ? fn.AsString() : std::string();
      queueLife(c);
    } else if (cmd == "stop") {
      LifeCmd c;
      c.isStart = false;
      c.fileIdx = 0;
      queueLife(c);
    } else if (cmd == "prefetch") {
      pp::Var i = d.Get("fileIdx");
      if (i.is_number()) stremio::engine::prefetch((int)i.AsInt());
    } else if (cmd == "stats") {
      std::string s = stremio::engine::statsJson();
      PostMessage(pp::Var(std::string("{\"event\":\"stats\",\"data\":") + s + "}"));
    } else if (cmd == "ping") {
      PostMessage(pp::Var("{\"event\":\"pong\"}"));
    }
  }

  virtual ~StremioEngineInstance() {
    pthread_mutex_lock(&g_qLock);
    g_quit = true;
    pthread_cond_broadcast(&g_qCond);
    pthread_mutex_unlock(&g_qLock);
    if (g_workerOk) pthread_join(g_worker, 0);
    stremio::engine::stop();
  }

 private:
  void postEvent(const char* name, const char* message = 0) {
    std::string s = std::string("{\"event\":\"") + name + "\"";
    if (message) s += std::string(",\"message\":\"") + message + "\"";
    s += "}";
    PostMessage(pp::Var(s));
  }

  void runLife(const LifeCmd& c) {
    if (c.isStart) {
      stremio::engine::setTrackers(c.trackers);
      stremio::engine::setFileName(c.fileName);
      stremio::engine::start(c.hash, c.fileIdx);
      postEvent("started");
    } else {
      stremio::engine::stop();
      postEvent("stopped");
    }
  }

  void queueLife(const LifeCmd& c) {
    if (!g_workerOk) { runLife(c); return; }   // fallback: pthread_create failed
    pthread_mutex_lock(&g_qLock);
    g_queue.push_back(c);
    pthread_cond_signal(&g_qCond);
    pthread_mutex_unlock(&g_qLock);
  }

  static void* lifecycleWorker(void* arg) {
    StremioEngineInstance* self = static_cast<StremioEngineInstance*>(arg);
    for (;;) {
      pthread_mutex_lock(&g_qLock);
      while (g_queue.empty() && !g_quit) pthread_cond_wait(&g_qCond, &g_qLock);
      if (g_queue.empty() && g_quit) { pthread_mutex_unlock(&g_qLock); break; }
      LifeCmd c = g_queue.front();
      g_queue.pop_front();
      pthread_mutex_unlock(&g_qLock);
      self->runLife(c);
    }
    return 0;
  }
};

class StremioEngineModule : public pp::Module {
 public:
  virtual pp::Instance* CreateInstance(PP_Instance instance) {
    return new StremioEngineInstance(instance);
  }
};

namespace pp {
Module* CreateModule() { return new StremioEngineModule(); }
}

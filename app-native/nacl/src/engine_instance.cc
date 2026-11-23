// PPAPI instance: bridge between the Tizen web widget and the native engine.
#include "engine_api.h"

#include <nacl_io/nacl_io.h>
#include <ppapi/c/ppb.h>
#include <ppapi/cpp/instance.h>
#include <ppapi/cpp/module.h>
#include <ppapi/cpp/var.h>
#include <ppapi/cpp/var_dictionary.h>

#include <string>

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
    // Always accept the instance so diagnostics keep flowing even if nacl_io
    // could not initialise.
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
      if (!h.is_string()) { PostMessage(pp::Var("{\"event\":\"error\",\"message\":\"missing hash\"}")); return; }
      int idx = i.is_number() ? (int)i.AsInt() : 0;
      pp::Var tr = d.Get("trackers");
      stremio::engine::setTrackers(tr.is_string() ? tr.AsString() : std::string());
      pp::Var fn = d.Get("fileName");
      stremio::engine::setFileName(fn.is_string() ? fn.AsString() : std::string());
      stremio::engine::start(h.AsString(), idx);
      PostMessage(pp::Var("{\"event\":\"started\"}"));
    } else if (cmd == "prefetch") {
      pp::Var i = d.Get("fileIdx");
      if (i.is_number()) stremio::engine::prefetch((int)i.AsInt());
    } else if (cmd == "stop") {
      stremio::engine::stop();
      PostMessage(pp::Var("{\"event\":\"stopped\"}"));
    } else if (cmd == "stats") {
      std::string s = stremio::engine::statsJson();
      PostMessage(pp::Var(std::string("{\"event\":\"stats\",\"data\":") + s + "}"));
    } else if (cmd == "ping") {
      PostMessage(pp::Var("{\"event\":\"pong\"}"));
    }
  }

  virtual ~StremioEngineInstance() { stremio::engine::stop(); }
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

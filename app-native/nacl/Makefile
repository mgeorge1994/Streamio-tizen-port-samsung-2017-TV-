# Build the on-device NaCl torrent engine with Samsung's Pepper 63 SDK.
# PNaCl produces a portable .pexe, which is what Tizen TVs load.
NACL_SDK_ROOT ?= $(abspath $(CURDIR)/../../nacl-toolchain/pepper_63)

TARGET = stremio_engine
VALID_TOOLCHAINS := pnacl glibc clang-newlib

include $(NACL_SDK_ROOT)/tools/common.mk

LIBS = ppapi_cpp ppapi pthread nacl_io
CFLAGS = -Wall -O2 -std=gnu++11 -I$(NACL_SDK_ROOT)/include/pnacl
SOURCES = src/engine_instance.cc \
          src/torrent_engine.cc

$(foreach src,$(SOURCES),$(eval $(call COMPILE_RULE,$(src),$(CFLAGS))))

$(eval $(call LINK_RULE,$(TARGET)_unstripped,$(SOURCES),$(LIBS),$(DEPS)))
$(eval $(call STRIP_RULE,$(TARGET),$(TARGET)_unstripped))
$(eval $(call NMF_RULE,$(TARGET),))

#include "../src/drm.h"
#include <xf86drm.h>
#include <drm.h>
#include <fcntl.h>
#include <sys/mman.h>
#include <unistd.h>
#include <algorithm>
#include <cstdio>
#include <cstdlib>
#include <cstring>
#include <string>
#include <vector>

// All libdrm symbols are provided here, without linking libdrm. Linker wrappers
// also intercept open/close/mmap/munmap/ioctl, so no DRM device can be touched.
#define CHECK(expr) do { if (!(expr)) { \
  std::fprintf(stderr, "%s:%d: %s\n", __FILE__, __LINE__, #expr); \
  std::abort(); \
} } while (false)

namespace {
constexpr int fd = 12345;
constexpr uint32_t connector_id = 11, crtc_id = 22, encoder_id = 33;
constexpr uint32_t handle = 44, fb_id = 55, property_id = 66;
std::string driver = "adp", failure;
uint16_t width = 60, height = 2008;
uint32_t pitch = 256, allocation_height = 2048;
uint64_t allocation_size = uint64_t(pitch) * allocation_height;
bool master = true, orientation = false, no_modes = false;
bool no_crtc = false, cleanup_failure = false, dirty_failure = false;
uint64_t orientation_value = 3;
int activations = 0, disables = 0, creates = 0, masters = 0, property_reads = 0;
int versions = 0, resources = 0, connectors = 0, encoders = 0, properties = 0;
int mapped = 0, registered = 0, allocated = 0, opened = 0;
std::vector<uint8_t> memory;
std::vector<std::string> events;

bool black() {
  return std::all_of(memory.begin(), memory.end(), [](uint8_t b) { return b == 0; });
}

void check_released() {
  CHECK(versions == 0 && resources == 0 && connectors == 0 && encoders == 0 && properties == 0);
  CHECK(mapped == 0 && registered == 0 && allocated == 0 && opened == 0);
  CHECK(!events.empty() && events.back() == "close");
}
}

extern "C" {
int __wrap_open(const char* path, int flags, ...) {
  CHECK(std::string(path) == "/mock/drm-only");
  CHECK(flags == (O_RDWR | O_CLOEXEC));
  ++opened;
  return fd;
}

int __wrap_close(int device) {
  CHECK(device == fd);
  --opened;
  events.push_back("close");
  return 0;
}

int __wrap_ioctl(int, unsigned long, ...) {
  CHECK(false); // No unexpected raw ioctls may reach the kernel.
  return -1;
}

void* __wrap_mmap(void* addr, size_t size, int prot, int flags, int device, off_t offset) {
  CHECK(addr == nullptr && size == allocation_size);
  CHECK(prot == (PROT_READ | PROT_WRITE) && flags == MAP_SHARED);
  CHECK(device == fd && offset == 4096);
  if (failure == "mmap") return MAP_FAILED;
  memory.assign(size, 0xa5);
  ++mapped;
  return memory.data();
}

int __wrap_munmap(void* addr, size_t size) {
  CHECK(addr == memory.data() && size == allocation_size);
  if (driver == "adp") CHECK(black());
  --mapped;
  events.push_back("unmap");
  return 0;
}

drmVersionPtr drmGetVersion(int device) {
  CHECK(device == fd);
  if (failure == "version") return nullptr;
  auto* v = new drmVersion{};
  v->name = driver.data();
  v->name_len = driver.size();
  ++versions;
  return v;
}

void drmFreeVersion(drmVersionPtr v) { --versions; delete v; }

drmModeResPtr drmModeGetResources(int device) {
  CHECK(device == fd);
  if (failure == "resources") return nullptr;
  auto* r = new drmModeRes{};
  r->count_connectors = 1;
  r->connectors = new uint32_t[1]{connector_id};
  r->count_crtcs = no_crtc ? 0 : 1;
  r->crtcs = new uint32_t[1]{crtc_id};
  ++resources;
  return r;
}

void drmModeFreeResources(drmModeResPtr r) {
  --resources;
  delete[] r->connectors;
  delete[] r->crtcs;
  delete r;
}

drmModeConnectorPtr drmModeGetConnector(int device, uint32_t id) {
  CHECK(device == fd && id == connector_id);
  auto* c = new drmModeConnector{};
  c->connector_id = connector_id;
  c->connection = DRM_MODE_CONNECTED;
  c->count_modes = no_modes ? 0 : 1;
  c->modes = new drmModeModeInfo[1]{};
  c->modes[0].hdisplay = width;
  c->modes[0].vdisplay = height;
  c->encoder_id = encoder_id;
  c->count_encoders = 1;
  c->encoders = new uint32_t[1]{encoder_id};
  c->count_props = orientation ? 1 : 0;
  c->props = new uint32_t[1]{property_id};
  c->prop_values = new uint64_t[1]{orientation_value};
  ++connectors;
  return c;
}

void drmModeFreeConnector(drmModeConnectorPtr c) {
  if (!c) return;
  --connectors;
  delete[] c->modes;
  delete[] c->encoders;
  delete[] c->props;
  delete[] c->prop_values;
  delete c;
}

drmModeEncoderPtr drmModeGetEncoder(int device, uint32_t id) {
  CHECK(device == fd && id == encoder_id);
  auto* e = new drmModeEncoder{};
  e->crtc_id = no_crtc ? 0 : crtc_id;
  e->possible_crtcs = no_crtc ? 0 : 1;
  ++encoders;
  return e;
}

void drmModeFreeEncoder(drmModeEncoderPtr e) { --encoders; delete e; }

drmModePropertyPtr drmModeGetProperty(int device, uint32_t id) {
  CHECK(device == fd && id == property_id);
  auto* p = new drmModePropertyRes{};
  std::strcpy(p->name, "panel orientation");
  p->count_enums = 4;
  ++properties;
  ++property_reads;
  return p;
}

void drmModeFreeProperty(drmModePropertyPtr p) { --properties; delete p; }

int drmIsMaster(int device) {
  CHECK(device == fd && driver == "adp");
  return master ? 1 : 0;
}

int drmSetMaster(int device) {
  CHECK(device == fd && driver == "adp" && !master);
  ++masters;
  if (failure == "master") return -1;
  master = true;
  return 0;
}

int drmIoctl(int device, unsigned long request, void* arg) {
  CHECK(device == fd);
  if (request == DRM_IOCTL_MODE_CREATE_DUMB) {
    ++creates;
    auto* c = static_cast<drm_mode_create_dumb*>(arg);
    CHECK(c->width == (driver == "adp" ? 64u : width));
    CHECK(c->height == height && c->bpp == 32 && c->flags == 0);
    CHECK(driver != "adp" || master);
    if (failure == "create") return -1;
    c->handle = handle;
    c->pitch = pitch;
    c->height = allocation_height;
    c->size = allocation_size;
    ++allocated;
    return 0;
  }
  if (request == DRM_IOCTL_MODE_MAP_DUMB) {
    auto* m = static_cast<drm_mode_map_dumb*>(arg);
    CHECK(m->handle == handle);
    if (failure == "map") return -1;
    m->offset = 4096;
    return 0;
  }
  CHECK(request == DRM_IOCTL_MODE_DESTROY_DUMB);
  CHECK(static_cast<drm_mode_destroy_dumb*>(arg)->handle == handle);
  --allocated;
  events.push_back("destroy");
  return cleanup_failure ? -1 : 0;
}

int drmModeAddFB(int device, uint32_t w, uint32_t h, uint8_t depth,
                 uint8_t bpp, uint32_t stride, uint32_t buffer, uint32_t* id) {
  CHECK(device == fd && w == width && h == height);
  CHECK(depth == 24 && bpp == 32 && stride == pitch && buffer == handle);
  if (failure == "addfb") return -1;
  *id = fb_id;
  ++registered;
  return 0;
}

int drmModeRmFB(int device, uint32_t id) {
  CHECK(device == fd && id == fb_id);
  --registered;
  events.push_back("rmfb");
  return cleanup_failure ? -1 : 0;
}

int drmModeSetCrtc(int device, uint32_t crtc, uint32_t buffer, uint32_t x,
                   uint32_t y, uint32_t* connectors, int count, drmModeModeInfoPtr mode) {
  CHECK(device == fd && crtc == crtc_id && x == 0 && y == 0);
  if (!buffer) {
    CHECK(driver == "adp" && black());
    CHECK(connectors == nullptr && count == 0 && mode == nullptr);
    ++disables;
    events.push_back("disable");
    return cleanup_failure ? -1 : 0;
  }
  CHECK(buffer == fb_id && count == 1 && *connectors == connector_id);
  CHECK(mode->hdisplay == width && mode->vdisplay == height);
  if (!activations) CHECK(black()); // Includes all returned row/height padding.
  ++activations;
  events.push_back("activate");
  return failure == "activate" || cleanup_failure ? -1 : 0;
}

int drmModeDirtyFB(int device, uint32_t id, drmModeClipPtr clips, uint32_t count) {
  CHECK(device == fd && id == fb_id);
  if (count) {
    CHECK(count == 1 && clips != nullptr);
    CHECK(clips[0].x1 == 0 && clips[0].y1 == 0);
    CHECK(clips[0].x2 == width && clips[0].y2 == height);
    events.push_back("damage");
  } else {
    CHECK(clips == nullptr && black());
    events.push_back("blank");
  }
  return dirty_failure ? -1 : 0;
}
}

int main(int argc, char** argv) {
  CHECK(argc == 2);
  const std::string scenario = argv[1];
  std::string expected_error;
  bool acquire = false;
  if (scenario == "adp-master" || scenario == "fail-master") {
    master = false;
    acquire = true;
  }
  if (scenario == "adp-pitch") pitch = 512;
  if (scenario == "adp-property") { orientation = true; orientation_value = 0; }
  if (scenario == "adp-unpadded-height") allocation_height = 2008;
  if (scenario == "adp-wrong-width") { width = 64; expected_error = "Unsupported adp mode 64x2008"; }
  if (scenario == "adp-wrong-height") { height = 2048; expected_error = "Unsupported adp mode 60x2048"; }
  if (scenario == "adp-landscape") { width = 2008; height = 60; expected_error = "Unsupported adp mode 2008x60"; }
  if (scenario == "adp-no-mode") { no_modes = true; expected_error = "No connected display"; }
  if (scenario == "adp-no-crtc") { no_crtc = true; expected_error = "No suitable CRTC"; }
  if (scenario == "adp-short-pitch") { pitch = 252; expected_error = "Invalid adp dumb buffer"; }
  if (scenario == "adp-unaligned-pitch") { pitch = 257; expected_error = "Invalid adp dumb buffer"; }
  if (scenario == "adp-short-height") { allocation_height = 2007; expected_error = "Invalid adp dumb buffer"; }
  if (scenario.rfind("t2-", 0) == 0) {
    driver = "appletbdrm";
    orientation = scenario != "t2-no-property";
    orientation_value = scenario == "t2-left" ? 2 : scenario == "t2-normal" ? 0 : 3;
    if (scenario == "t2-normal") { width = 2008; height = 60; pitch = width * 4; }
    allocation_height = height;
  }
  if (scenario == "unknown-portrait") driver = "other";
  if (scenario == "adp-prefix") driver = "adp-other";
  allocation_size = uint64_t(pitch) * allocation_height;
  // Some drivers report padded size without changing the requested height.
  if (scenario == "adp-size-only-padding") allocation_height = 2008;
  if (scenario == "adp-short-size") { --allocation_size; expected_error = "Invalid adp dumb buffer"; }
  if (scenario.rfind("fail-", 0) == 0) {
    failure = scenario.substr(5);
    if (failure == "version") expected_error = "drmGetVersion failed";
    if (failure == "resources") expected_error = "drmModeGetResources failed";
    if (failure == "master") expected_error = "Cannot acquire DRM master";
    if (failure == "create") expected_error = "DRM_IOCTL_MODE_CREATE_DUMB failed";
    if (failure == "addfb") expected_error = "drmModeAddFB failed";
    if (failure == "map") expected_error = "DRM_IOCTL_MODE_MAP_DUMB failed";
    if (failure == "mmap") expected_error = "mmap of dumb buffer failed";
    if (failure == "activate") expected_error = "drmModeSetCrtc failed";
    CHECK(!expected_error.empty());
  }
  if (scenario == "close-unconfigured") {
    { DrmDevice device("/mock/drm-only"); }
    check_released();
    CHECK(events == std::vector<std::string>{"close"});
    return 0;
  }

  std::string error;
  try {
    DrmDevice device("/mock/drm-only");
    device.setup();
    CHECK(expected_error.empty());
    CHECK(device.fb_width() == width && device.fb_height() == height);
    const bool rotated = driver == "adp" || (orientation && (orientation_value == 2 || orientation_value == 3));
    CHECK(device.rotate90() == rotated);
    CHECK(device.width() == (rotated ? height : width));
    CHECK(device.height() == (rotated ? width : height));
    CHECK(device.stride() == pitch && device.buffer() == memory.data());
    CHECK(black());
    if (driver == "adp") {
      CHECK(device.width() == 2008 && device.height() == 60);
      CHECK(property_reads == 0);
    } else CHECK(property_reads == (orientation ? 1 : 0));
    // Private pixels and padding must all be erased during ADP shutdown.
    std::memset(device.buffer(), 0x5a, memory.size());
    drmModeClip clip{0, 0, width, height};
    dirty_failure = scenario == "adp-dirty-fallback";
    device.dirty(&clip, 1);
    CHECK(activations == (dirty_failure ? 2 : 1));
    // Even failed flush/disable/removal must not prevent remaining cleanup.
    cleanup_failure = scenario == "adp-cleanup-errors";
    if (cleanup_failure) dirty_failure = true;
  } catch (const std::exception& e) {
    error = e.what();
  }
  CHECK(expected_error.empty() ? error.empty() : error.find(expected_error) != std::string::npos);
  check_released();
  CHECK(masters == (acquire ? 1 : 0));
  if (expected_error.empty()) {
    std::vector<std::string> suffix;
    if (driver == "adp") {
      CHECK(disables == 1 && black());
      suffix.push_back("blank");
      if (dirty_failure) suffix.push_back("activate");
      suffix.push_back("disable");
    } else CHECK(disables == 0 && !black());
    suffix.insert(suffix.end(), {"unmap", "rmfb", "destroy", "close"});
    CHECK(events.size() >= suffix.size());
    CHECK(std::equal(suffix.begin(), suffix.end(), events.end() - suffix.size()));
  } else {
    CHECK(disables == 0);
    CHECK(activations == (failure == "activate" ? 1 : 0));
    if (expected_error.find("Unsupported") == 0 || no_modes || no_crtc ||
        failure == "master" || failure == "version" || failure == "resources")
      CHECK(creates == 0);
  }
  return 0;
}

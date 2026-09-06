#include "drm.h"
#include <xf86drm.h>
#include <xf86drmMode.h>
#include <drm.h>
#include <fcntl.h>
#include <unistd.h>
#include <sys/mman.h>
#include <cstring>
#include <limits>
#include <stdexcept>

DrmDevice::DrmDevice(const std::string& path) {
  fd_ = open(path.c_str(), O_RDWR | O_CLOEXEC);
  if (fd_ < 0)
    throw std::runtime_error("Cannot open DRM device " + path +
                             " — the device lease could not grant access");
}

DrmDevice::~DrmDevice() {
  if (is_adp_) {
    // Erase private content, including padding, before releasing scanout.
    if (map_) memset(map_, 0, map_size_);
    if (active_) {
      dirty();
      drmModeSetCrtc(fd_, crtc_id_, 0, 0, 0, nullptr, 0, nullptr);
    }
  }
  if (map_ && map_ != MAP_FAILED) munmap(map_, map_size_);
  if (fb_id_)   drmModeRmFB(fd_, fb_id_);
  if (handle_) {
    drm_mode_destroy_dumb dreq{};
    dreq.handle = handle_;
    drmIoctl(fd_, DRM_IOCTL_MODE_DESTROY_DUMB, &dreq);
  }
  if (fd_ >= 0) close(fd_);
}

void DrmDevice::setup() {
  drmVersion* version = drmGetVersion(fd_);
  if (!version) throw std::runtime_error("drmGetVersion failed");
  is_adp_ = version->name && version->name_len == 3 &&
            std::memcmp(version->name, "adp", 3) == 0;
  drmFreeVersion(version);

  drmModeRes* res = drmModeGetResources(fd_);
  if (!res) throw std::runtime_error("drmModeGetResources failed");

  // --- Find a connected connector with at least one mode ---
  drmModeConnector* conn = nullptr;
  for (int i = 0; i < res->count_connectors; ++i) {
    auto* c = drmModeGetConnector(fd_, res->connectors[i]);
    if (c && c->connection == DRM_MODE_CONNECTED && c->count_modes > 0) {
      conn = c;
      break;
    }
    drmModeFreeConnector(c);
  }
  if (!conn) {
    drmModeFreeResources(res);
    throw std::runtime_error("No connected display found on " + std::to_string(fd_));
  }

  conn_id_   = conn->connector_id;
  mode_      = conn->modes[0];
  fb_width_  = mode_.hdisplay;
  fb_height_ = mode_.vdisplay;

  if (is_adp_ && (fb_width_ != 60 || fb_height_ != 2008)) {
    drmModeFreeConnector(conn);
    drmModeFreeResources(res);
    throw std::runtime_error("Unsupported adp mode " + std::to_string(fb_width_) +
                             "x" + std::to_string(fb_height_) + "; expected 60x2008");
  }
  // ADP has no orientation property. Match tiny-dfr's +90 degree rotation:
  // pixel (logical_x, logical_y) maps to (59 - logical_y, logical_x).
  rotate90_ = is_adp_;

  // Detect panel orientation: values 2 (Left Side Up) and 3 (Right Side Up)
  // mean the panel is physically rotated 90°; swap logical width/height.
  for (int i = 0; !is_adp_ && i < conn->count_props; ++i) {
    drmModePropertyRes* prop = drmModeGetProperty(fd_, conn->props[i]);
    if (!prop) continue;
    if (std::string(prop->name) == "panel orientation" && prop->count_enums > 0) {
      uint64_t val = conn->prop_values[i];
      rotate90_ = (val == 2 || val == 3);
    }
    drmModeFreeProperty(prop);
  }

  // --- Find a usable CRTC ---
  // Prefer the one already attached to this connector's encoder.
  if (conn->encoder_id) {
    auto* enc = drmModeGetEncoder(fd_, conn->encoder_id);
    if (enc) {
      crtc_id_ = enc->crtc_id;
      drmModeFreeEncoder(enc);
    }
  }

  // Otherwise scan all encoders for a CRTC that can drive this connector.
  if (!crtc_id_) {
    for (int i = 0; i < conn->count_encoders && !crtc_id_; ++i) {
      auto* enc = drmModeGetEncoder(fd_, conn->encoders[i]);
      if (!enc) continue;
      for (int j = 0; j < res->count_crtcs && !crtc_id_; ++j) {
        if (enc->possible_crtcs & (1u << j))
          crtc_id_ = res->crtcs[j];
      }
      drmModeFreeEncoder(enc);
    }
  }

  drmModeFreeConnector(conn);
  drmModeFreeResources(res);

  if (!crtc_id_)
    throw std::runtime_error("No suitable CRTC found");

  if (is_adp_ && drmIsMaster(fd_) != 1 && drmSetMaster(fd_) < 0)
    throw std::runtime_error("Cannot acquire DRM master for adp");

  // --- Allocate a dumb buffer (CPU-accessible, no GBM needed) ---
  drm_mode_create_dumb creq{};
  creq.width  = is_adp_ ? 64 : fb_width_;
  creq.height = fb_height_;
  creq.bpp    = 32;
  if (drmIoctl(fd_, DRM_IOCTL_MODE_CREATE_DUMB, &creq) < 0)
    throw std::runtime_error("DRM_IOCTL_MODE_CREATE_DUMB failed");

  handle_   = creq.handle;
  stride_   = creq.pitch;
  map_size_ = creq.size;

  // ADP may return a 2048-row allocation. Use its pitch and full size, while
  // keeping KMS and the renderer at the visible 60x2008 dimensions.
  if (is_adp_ && (stride_ < 64 * 4 || stride_ % 4 != 0 ||
                 creq.height < fb_height_ ||
                 map_size_ < uint64_t(stride_) * creq.height ||
                 map_size_ > std::numeric_limits<size_t>::max()))
    throw std::runtime_error("Invalid adp dumb buffer allocation");

  // --- Register it as a KMS framebuffer (XRGB8888) ---
  if (drmModeAddFB(fd_, fb_width_, fb_height_, 24, 32, stride_, handle_, &fb_id_) < 0)
    throw std::runtime_error("drmModeAddFB failed");

  // --- Map into user-space for CPU access ---
  drm_mode_map_dumb mreq{};
  mreq.handle = handle_;
  if (drmIoctl(fd_, DRM_IOCTL_MODE_MAP_DUMB, &mreq) < 0)
    throw std::runtime_error("DRM_IOCTL_MODE_MAP_DUMB failed");

  map_ = static_cast<uint8_t*>(
    mmap(nullptr, map_size_, PROT_READ | PROT_WRITE, MAP_SHARED, fd_, mreq.offset));
  if (map_ == MAP_FAILED) {
    map_ = nullptr;
    throw std::runtime_error("mmap of dumb buffer failed");
  }

  // Clear to black before first scanout
  memset(map_, 0, map_size_);

  // --- Activate the display ---
  // ADP's atomic helpers may support legacy KMS. Visible AddFB dimensions and
  // SetCrtc/dirty/disable still need validation on physical ADP hardware.
  if (drmModeSetCrtc(fd_, crtc_id_, fb_id_, 0, 0, &conn_id_, 1, &mode_) < 0)
    throw std::runtime_error("drmModeSetCrtc failed — display may be in use by a compositor");
  active_ = true;
}

void DrmDevice::dirty(const drmModeClip* clips, uint32_t count) {
  // Lightweight dirty-FB path. With clips, only those FB rects are flushed
  // (count==0 = whole FB). drmModeDirtyFB takes a non-const ptr but doesn't
  // modify the clips.
  if (drmModeDirtyFB(fd_, fb_id_, const_cast<drmModeClip*>(clips), count) == 0)
    return;

  // Fallback: re-issue SetCrtc, which forces the driver's update callback.
  // Required for drivers whose FB lacks a dirty hook (full-frame only).
  drmModeSetCrtc(fd_, crtc_id_, fb_id_, 0, 0, &conn_id_, 1, &mode_);
}

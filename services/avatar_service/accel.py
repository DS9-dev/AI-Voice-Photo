"""Ditto on Windows + RTX 50 (sm_120): run-time patches proven in AVP-03.

  - motion diffusion (LMDM) and decoder: ONNX -> TensorRT 10 (engines cached per GPU)
  - warp network: PyTorch fp16, source feature volume kept on the GPU
    (its 5-D GridSample has no ONNX Runtime/TensorRT path on Windows)
  - put-back: paste only inside the face box, warped mask computed once
  - lip gate (AVP-04): Ditto's own per-frame `vad_alpha` control, fixed to act on the
    lip keypoints only (the released ctrl_vad builds a lip mask and then ignores it)
"""
import glob
import os
import sys

import cv2
import numpy as np

LIP = [6, 12, 14, 17, 19, 20]


def _dll_paths():
    venv = os.path.dirname(os.path.dirname(sys.executable))
    for d in glob.glob(os.path.join(venv, "Lib", "site-packages", "tensorrt_libs")) + \
            glob.glob(os.path.join(venv, "Lib", "site-packages", "torch", "lib")):
        try:
            os.add_dll_directory(d)
        except (OSError, AttributeError):
            pass
        os.environ["PATH"] = d + os.pathsep + os.environ.get("PATH", "")


def trt_available():
    try:
        import tensorrt  # noqa: F401
        return True
    except Exception:
        return False


def ctrl_vad_lips(x_d_info, dst, alpha):
    """Blend only the lip keypoints of the expression towards the source photo (alpha=1: unchanged)."""
    exp = x_d_info["exp"].reshape(-1, 21, 3)
    dst_exp = dst["exp"].reshape(-1, 21, 3)
    m = np.ones((1, 21, 1), dtype=np.float32)
    m[0, LIP, 0] = alpha
    x_d_info["exp"] = (exp * m + dst_exp * (1 - m)).reshape(x_d_info["exp"].shape)
    return x_d_info


# AVP-04 fix 1 (full-screen quality): how the 512x512 face render is scaled back into the photo.
# Changed at run time by LiveAvatar from the configuration.
PUTBACK = {"interp": cv2.INTER_CUBIC, "sharpen": 0.5}
# LMDM (motion diffusion) precision (see AVP-04 report; AVP_LMDM_FP16=0 switches back to fp32)
LMDM_FP16 = os.environ.get("AVP_LMDM_FP16", "1") == "1"   # fp16: same lip sync and mouth range as fp32 (AVP-04), 127 -> 46 ms


_WEIGHT = {}


def _sharpen(img, amount):
    """Mild unsharp mask on the 512 render (not AI), strongest on the face in the centre of
    Ditto's crop and fading out towards hair and background (which would otherwise get
    sharper than the source photo, with halos)."""
    if amount <= 0:
        return img
    h, w = img.shape[:2]
    wmap = _WEIGHT.get((h, w))
    if wmap is None:
        yy, xx = np.mgrid[0:h, 0:w].astype(np.float32)
        r2 = ((xx - w / 2) / (0.30 * w)) ** 2 + ((yy - h * 0.48) / (0.32 * h)) ** 2
        wmap = _WEIGHT[(h, w)] = np.exp(-r2)[..., None].astype(np.float32)
    img = img.astype(np.float32)
    blur = cv2.GaussianBlur(img, (0, 0), 1.2)
    return np.clip(img + amount * wmap * (img - blur), 0, 255)


def apply(models_dir, use_trt=True, log=print):
    """Patch Ditto classes before StreamSDK is created. Returns what is in effect."""
    _dll_paths()
    import torch
    import onnxruntime as ort
    from core.models import decoder as dec_mod, warp_network as warp_mod, lmdm as lmdm_mod
    from core.atomic_components import putback as pb_mod, motion_stitch as ms_mod

    torch.backends.cudnn.benchmark = True
    ms_mod.ctrl_vad = ctrl_vad_lips
    onnx_dir = os.path.join(models_dir, "ditto_onnx")
    cache = os.path.join(models_dir, "trt_cache")
    os.makedirs(cache, exist_ok=True)
    use_trt = use_trt and trt_available() and "TensorrtExecutionProvider" in ort.get_available_providers()

    def providers(fp16):
        if not use_trt:
            return ["CUDAExecutionProvider"]
        return [("TensorrtExecutionProvider", {"trt_fp16_enable": fp16, "trt_engine_cache_enable": True,
                                               "trt_engine_cache_path": cache, "trt_timing_cache_enable": True,
                                               "trt_builder_optimization_level": 3}),
                "CUDAExecutionProvider"]

    def lmdm_init(self, model_path, device="cuda", **kwargs):
        self.model = ort.InferenceSession(os.path.join(onnx_dir, "lmdm_v0.4_hubert.onnx"), providers=providers(LMDM_FP16))
        self.model_type = "onnx"
        self.device = device
        self.motion_feat_dim = kwargs.get("motion_feat_dim", 265)
        self.audio_feat_dim = kwargs.get("audio_feat_dim", 1024 + 35)
        self.seq_frames = kwargs.get("seq_frames", 80)
        self._init_np()
    lmdm_mod.LMDM.__init__ = lmdm_init

    # HuBERT audio features (streaming ONNX): TensorRT instead of the CUDA provider. Same fp32
    # numerics; it ran every 200 ms at ~57 ms and was the second-largest GPU load (AVP-04 fix 1).
    from core.aux_models import hubert_stream as hub_mod

    def hub_init(self, model_path, device="cuda", **kwargs):
        self.model = ort.InferenceSession(model_path, providers=providers(False))
        self.model_type = "onnx"
        self.device = device
    hub_mod.HubertStreaming.__init__ = hub_init

    def dec_init(self, model_path, device="cuda"):
        self.session = ort.InferenceSession(os.path.join(onnx_dir, "decoder.onnx"), providers=providers(True))
        self.model_type = "onnx-trt"

    def dec_call(self, feature):
        pred = self.session.run(None, {"feature": np.ascontiguousarray(feature, dtype=np.float32)})[0]
        return np.transpose(pred[0], [1, 2, 0]).clip(0, 1) * 255
    dec_mod.Decoder.__init__ = dec_init
    dec_mod.Decoder.__call__ = dec_call

    orig_warp_init = warp_mod.WarpNetwork.__init__

    def warp_init(self, model_path, device="cuda"):
        orig_warp_init(self, model_path, device)
        self.model = self.model.half().eval()
        self._fs_key = None

    def warp_call(self, feature_3d, kp_source, kp_driving):
        with torch.no_grad():
            key = (feature_3d.__array_interface__["data"][0], feature_3d.shape)
            if key != self._fs_key:
                self._fs = torch.from_numpy(feature_3d).to(self.device).half()
                self._fs_key = key
            out = self.model(self._fs, torch.from_numpy(kp_source).to(self.device).half(),
                             torch.from_numpy(kp_driving).to(self.device).half())
            return out.float().cpu().numpy()
    warp_mod.WarpNetwork.__init__ = warp_init
    warp_mod.WarpNetwork.__call__ = warp_call

    orig_pb_init = pb_mod.PutBack.__init__

    def pb_init(self, mask_template_path=None):
        orig_pb_init(self, mask_template_path)
        self._cache_key = None

    def pb_call(self, frame_rgb, render_image, M_c2o):
        """AVP-04 fix 1: put-back on the GPU (bicubic, radial sharpening). At native photo
        resolution the CPU version cost ~33 ms per frame and pulled Ditto below 25 fps."""
        h, w = frame_rgb.shape[:2]
        key = (h, w, M_c2o.tobytes())
        if key != self._cache_key:
            full = cv2.warpAffine(self.mask_ori_float, M_c2o[:2, :], dsize=(w, h), flags=cv2.INTER_LINEAR).clip(0, 1)
            ys, xs = np.nonzero(full > 1e-4)
            y0, y1, x0, x1 = ys.min(), ys.max() + 1, xs.min(), xs.max() + 1
            self._box = (y0, y1, x0, x1)
            dev = "cuda"
            # sampling grid: output pixel (x, y) of the box -> position in the 512 render (inverse affine)
            Minv = cv2.invertAffineTransform(M_c2o[:2, :].astype(np.float64))
            yy, xx = np.mgrid[y0:y1, x0:x1].astype(np.float64)
            sx = Minv[0, 0] * xx + Minv[0, 1] * yy + Minv[0, 2]
            sy = Minv[1, 0] * xx + Minv[1, 1] * yy + Minv[1, 2]
            rh, rw = render_image.shape[:2]
            grid = np.stack([(sx + 0.5) / rw * 2 - 1, (sy + 0.5) / rh * 2 - 1], -1)[None].astype(np.float32)
            self._grid = torch.from_numpy(grid).to(dev)
            self._mask_t = torch.from_numpy(full[y0:y1, x0:x1][None, None].astype(np.float32)).to(dev)
            self._region_t = torch.from_numpy(np.ascontiguousarray(frame_rgb[y0:y1, x0:x1].transpose(2, 0, 1))[None].astype(np.float32)).to(dev)
            ky = np.arange(-3, 4, dtype=np.float32)
            g = np.exp(-ky ** 2 / (2 * 1.2 ** 2)); g /= g.sum()
            self._gk = torch.from_numpy(g).to(dev)
            yy2, xx2 = np.mgrid[0:rh, 0:rw].astype(np.float32)
            r2 = ((xx2 - rw / 2) / (0.30 * rw)) ** 2 + ((yy2 - rh * 0.48) / (0.32 * rh)) ** 2
            self._wmap_t = torch.from_numpy(np.exp(-r2)[None, None].astype(np.float32)).to(dev)
            self._frame = frame_rgb
            self._cache_key = key
        y0, y1, x0, x1 = self._box
        with torch.no_grad():
            r = torch.from_numpy(np.ascontiguousarray(render_image.transpose(2, 0, 1), dtype=np.float32))[None].to("cuda", non_blocking=True)
            amount = PUTBACK["sharpen"]
            if amount > 0:
                k = self._gk
                blur = torch.nn.functional.conv2d(torch.nn.functional.pad(r, (3, 3, 0, 0), mode="replicate"), k.view(1, 1, 1, 7).expand(3, 1, 1, 7), groups=3)
                blur = torch.nn.functional.conv2d(torch.nn.functional.pad(blur, (0, 0, 3, 3), mode="replicate"), k.view(1, 1, 7, 1).expand(3, 1, 7, 1), groups=3)
                r = r + amount * self._wmap_t * (r - blur)
            mode = "bicubic" if PUTBACK["interp"] == cv2.INTER_CUBIC else "bilinear"
            warped = torch.nn.functional.grid_sample(r, self._grid, mode=mode, padding_mode="border", align_corners=False)
            out_t = (self._mask_t * warped + (1 - self._mask_t) * self._region_t).clamp_(0, 255).to(torch.uint8)
            region = out_t[0].permute(1, 2, 0).contiguous().cpu().numpy()
        out = frame_rgb.copy()
        out[y0:y1, x0:x1] = region
        return out
    pb_mod.PutBack.__init__ = pb_init
    pb_mod.PutBack.__call__ = pb_call

    log(f"Ditto acceleration: LMDM+decoder {'TensorRT ' + _trt_version() if use_trt else 'ONNX Runtime CUDA'}, warp PyTorch fp16, lip gate on")
    return {"tensorrt": use_trt}


def _trt_version():
    try:
        import tensorrt
        return tensorrt.__version__
    except Exception:
        return "?"

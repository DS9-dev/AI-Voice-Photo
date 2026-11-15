# AVP-03 (Windows): the Cython blend needs a C compiler at run time (pyximport).
# Fall back to an equivalent NumPy implementation when it cannot be built.
try:
    import pyximport
    pyximport.install()
    from .blend import blend_images_cy
except Exception:  # no compiler / build failure
    import numpy as np

    def blend_images_cy(mask_warped, frame_warped, frame_rgb, result):
        m = mask_warped[..., None].astype(np.float32)
        out = m * frame_warped + (1.0 - m) * frame_rgb.astype(np.float32)
        np.clip(out, 0, 255, out=out)
        result[...] = out.astype(np.uint8)  # truncation, like the C cast

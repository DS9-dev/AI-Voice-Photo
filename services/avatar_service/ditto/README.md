# Vendored Ditto (antgroup/ditto-talkinghead)

Source: https://github.com/antgroup/ditto-talkinghead @ c3e47eee2e626500017a0556b470d6d4182f85e8
Licence: Apache-2.0 (see LICENSE). Model weights are not part of this repository
(downloaded into `models/ditto` by `setup_avatar.bat`).

Changes made for AI Voice Photo (AVP-04):
- `core/__init__.py` added (regular package, so it cannot be confused with the app's Node `core/` folder);
- `core/utils/blend/__init__.py`: NumPy fallback when the Cython blend cannot be compiled;
- everything else is patched at run time by `services/avatar_service/accel.py` and
  `services/avatar_service/live.py` (TensorRT 10 / fp16 paths for RTX 50 GPUs, bounded
  buffers for an endless stream, lip-only voice-activity gate); the files here are unchanged.
Unused here: `stream_pipeline_offline.py`, `inference.py`, training code.

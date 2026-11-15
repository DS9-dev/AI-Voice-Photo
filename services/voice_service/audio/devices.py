"""Audio device enumeration and resolution (sounddevice / PortAudio).

Devices are identified by name in the configuration because PortAudio
indices change between runs. On Windows the same physical device shows up
once per host API; one host API is chosen so the lists are not duplicated.
"""
from typing import Any, Dict, List, Optional, Tuple

PREFERRED_HOST_APIS = ["Windows WASAPI", "Windows DirectSound", "MME"]


def _sd():
    import sounddevice as sd
    return sd


def choose_host_api(preference: str = "auto") -> Tuple[Optional[int], str]:
    """Return (hostapi index, name). preference: auto | wasapi | directsound | mme | default."""
    sd = _sd()
    apis = sd.query_hostapis()
    names = [a["name"] for a in apis]
    pref = (preference or "auto").lower()
    if pref == "default":
        idx = sd.default.hostapi
        return idx, names[idx] if 0 <= idx < len(names) else "default"
    wanted: List[str]
    if pref == "wasapi":
        wanted = ["Windows WASAPI"]
    elif pref == "directsound":
        wanted = ["Windows DirectSound"]
    elif pref == "mme":
        wanted = ["MME"]
    else:
        wanted = PREFERRED_HOST_APIS
    for w in wanted:
        if w in names:
            return names.index(w), w
    idx = sd.default.hostapi
    return idx, names[idx] if 0 <= idx < len(names) else "default"


def list_devices(host_api_pref: str = "auto") -> Dict[str, Any]:
    sd = _sd()
    api_idx, api_name = choose_host_api(host_api_pref)
    apis = sd.query_hostapis()
    api = apis[api_idx] if api_idx is not None and 0 <= api_idx < len(apis) else None
    default_in = api.get("default_input_device", -1) if api else -1
    default_out = api.get("default_output_device", -1) if api else -1
    inputs: List[Dict[str, Any]] = []
    outputs: List[Dict[str, Any]] = []
    for idx, dev in enumerate(sd.query_devices()):
        if api_idx is not None and dev["hostapi"] != api_idx:
            continue
        entry = {
            "index": idx,
            "name": dev["name"],
            "default_samplerate": dev["default_samplerate"],
        }
        if dev["max_input_channels"] > 0:
            inputs.append({**entry, "channels": dev["max_input_channels"], "is_default": idx == default_in})
        if dev["max_output_channels"] > 0:
            outputs.append({**entry, "channels": dev["max_output_channels"], "is_default": idx == default_out})
    return {"host_api": api_name, "inputs": inputs, "outputs": outputs}


def resolve_device(name: str, kind: str, host_api_pref: str = "auto") -> Tuple[Optional[int], str, str]:
    """Map a configured device name to (index, resolved name, host api name).

    Empty name -> the host API's default device. A configured name that no
    longer exists also falls back to the default (the caller reports this).
    """
    listing = list_devices(host_api_pref)
    devices = listing["inputs" if kind == "input" else "outputs"]
    if name:
        for d in devices:
            if d["name"] == name:
                return d["index"], d["name"], listing["host_api"]
        for d in devices:  # MME truncates names to 31 chars: allow prefix match
            if d["name"].startswith(name) or name.startswith(d["name"]):
                return d["index"], d["name"], listing["host_api"]
    for d in devices:
        if d["is_default"]:
            return d["index"], d["name"], listing["host_api"]
    if devices:
        return devices[0]["index"], devices[0]["name"], listing["host_api"]
    return None, "", listing["host_api"]


def stream_extra_settings(host_api_name: str):
    """WASAPI shared mode only accepts the device mix rate unless auto-convert is on."""
    if host_api_name == "Windows WASAPI":
        sd = _sd()
        try:
            return sd.WasapiSettings(auto_convert=True)
        except Exception:  # very old sounddevice / PortAudio
            return None
    return None

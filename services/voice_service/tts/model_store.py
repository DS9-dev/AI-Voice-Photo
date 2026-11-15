"""Local installation of TTS model files.

The model is installed ONCE into models/silero/ and then only ever read from
disk; a conversation never needs the network.

Download security
  * TLS is always verified (certificate chain and host name). There is no
    code path that disables verification for a download.
  * Trust anchors: the `certifi` CA bundle first (the same bundle the Hugging
    Face downloads of this application use), then the operating system
    store. Python's default on Windows is the Windows certificate store only,
    and with it chain building can end at an expired CA certificate even
    though the server's own certificate is valid ("certificate has expired").
  * After download the file must have the announced length and be a readable
    zip archive (torch.package format). Its SHA-256 is recorded next to it
    (`<file>.sha256`) and re-checked on every later start, so a file that is
    damaged or replaced afterwards is detected. A known-good digest can be
    pinned in KNOWN_SHA256.

Offline / manual installation
  `install_local()` (python -m services.voice_service.prefetch --tts-file F)
  copies a model file obtained by other means into place under the same checks.
"""
import hashlib
import os
import shutil
import socket
import ssl
import sys
import tempfile
import time
import urllib.error
import urllib.request
import zipfile
from typing import Any, Callable, Dict, List, Optional, Tuple

MODEL_HOST = "models.silero.ai"
MODEL_URL = "https://" + MODEL_HOST + "/models/tts/{language}/{model_id}.pt"
MIN_MODEL_BYTES = 1_000_000

# SHA-256 of model files verified on a trusted installation. A file whose id
# is listed here must match exactly. (Filled in once a verified install exists.)
KNOWN_SHA256: Dict[str, str] = {}


class ModelInstallError(RuntimeError):
    pass


# ------------------------------------------------------------------ TLS --

def trust_contexts() -> List[Tuple[str, ssl.SSLContext]]:
    """Verified TLS contexts to try, in order. Never an unverified one."""
    contexts: List[Tuple[str, ssl.SSLContext]] = []
    try:
        import certifi
        contexts.append((f"certifi {getattr(certifi, '__version__', '')}".strip(),
                         ssl.create_default_context(cafile=certifi.where())))
    except Exception:
        pass
    contexts.append(("operating system store", ssl.create_default_context()))
    for _, ctx in contexts:
        # explicit, so a future edit cannot silently relax it
        ctx.check_hostname = True
        ctx.verify_mode = ssl.CERT_REQUIRED
    return contexts


def _open_verified(url: str, timeout: float = 60.0):
    """Open `url` over verified TLS. Returns (response, trust_store_name)."""
    if not url.lower().startswith("https://"):
        raise ModelInstallError(f"Refusing to download a model over a non-HTTPS URL: {url}")
    errors: List[str] = []
    for name, ctx in trust_contexts():
        opener = urllib.request.build_opener(urllib.request.HTTPSHandler(context=ctx))
        request = urllib.request.Request(url, headers={"User-Agent": "torch.hub"})
        try:
            return opener.open(request, timeout=timeout), name
        except urllib.error.URLError as exc:
            reason = getattr(exc, "reason", exc)
            errors.append(f"{name}: {reason}")
            if not isinstance(reason, ssl.SSLError):
                break  # not a trust problem: another trust store will not help
    raise ModelInstallError("Could not download " + url + " over verified TLS (" + "; ".join(errors) + "). "
                            "TLS verification was NOT disabled. Run tts_smoke.bat for a certificate diagnosis, "
                            "or install the file manually (see README, 'TTS model installation').")


# ---------------------------------------------------------------- files --

def sha256_of(path: str) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as fh:
        for block in iter(lambda: fh.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def inspect_file(path: str) -> Dict[str, Any]:
    """Structural facts about a model file (no code from it is executed)."""
    info: Dict[str, Any] = {"path": path, "bytes": os.path.getsize(path), "is_zip": False, "has_model_pickle": False}
    try:
        if zipfile.is_zipfile(path):
            info["is_zip"] = True
            with zipfile.ZipFile(path) as archive:
                info["has_model_pickle"] = any(n.endswith("tts_models/model.pkl") for n in archive.namelist())
    except (OSError, zipfile.BadZipFile):
        info["is_zip"] = False
    return info


def _check_installed(path: str, model_id: str) -> Dict[str, Any]:
    """Validate a model file and its recorded digest. Raises ModelInstallError."""
    info = inspect_file(path)
    if info["bytes"] < MIN_MODEL_BYTES or not info["is_zip"]:
        raise ModelInstallError(f"{path} is not a complete model file ({info['bytes']} bytes, zip archive: {info['is_zip']}). "
                                "Delete it to download it again.")
    info["sha256"] = sha256_of(path)
    pinned = KNOWN_SHA256.get(model_id)
    if pinned and pinned != info["sha256"]:
        raise ModelInstallError(f"{path} does not match the known SHA-256 for {model_id}.")
    info["pinned"] = bool(pinned)
    lock = path + ".sha256"
    if os.path.isfile(lock):
        with open(lock, "r", encoding="ascii") as fh:
            recorded = fh.read().split()[0].strip() if os.path.getsize(lock) else ""
        if recorded and recorded != info["sha256"]:
            raise ModelInstallError(f"{path} changed since it was installed (SHA-256 differs from {lock}). "
                                    "Delete both files to install the model again.")
        info["lock"] = "verified"
    else:
        with open(lock, "w", encoding="ascii") as fh:
            fh.write(f"{info['sha256']}  {os.path.basename(path)}\n")
        info["lock"] = "recorded"
    return info


def download(url: str, dest: str, opener: Optional[Callable[[str], Tuple[Any, str]]] = None,
             log: Callable[[str], None] = lambda m: print(m, file=sys.stderr, flush=True)) -> Dict[str, Any]:
    """Download to `dest` atomically. Returns facts about the transfer."""
    open_url = opener or _open_verified
    os.makedirs(os.path.dirname(dest) or ".", exist_ok=True)
    tmp = dest + ".part"
    started = time.perf_counter()
    response, trust = open_url(url)
    log(f"[tts] downloading {url} (TLS verified against: {trust})")
    expected = None
    try:
        with response:
            length = response.headers.get("Content-Length") if getattr(response, "headers", None) is not None else None
            expected = int(length) if length and str(length).isdigit() else None
            received = 0
            with open(tmp, "wb") as fh:
                while True:
                    block = response.read(1 << 20)
                    if not block:
                        break
                    fh.write(block)
                    received += len(block)
        if expected is not None and received != expected:
            raise ModelInstallError(f"Download of {url} was cut off: {received} of {expected} bytes.")
        if received < MIN_MODEL_BYTES or not zipfile.is_zipfile(tmp):
            raise ModelInstallError(f"Download of {url} did not produce a model file ({received} bytes).")
        os.replace(tmp, dest)
    finally:
        if os.path.exists(tmp):
            try:
                os.remove(tmp)
            except OSError:
                pass
    return {"url": url, "bytes": received, "trust_store": trust,
            "seconds": round(time.perf_counter() - started, 2)}


def ensure_model(model_id: str, language: str, models_dir: str,
                 opener: Optional[Callable[[str], Tuple[Any, str]]] = None) -> Dict[str, Any]:
    """Make sure the model file is installed locally. Returns facts incl. 'path'."""
    path = os.path.join(models_dir, "silero", f"{model_id}.pt")
    facts: Dict[str, Any] = {"model_id": model_id, "language": language, "downloaded": False}
    if not os.path.isfile(path):
        url = MODEL_URL.format(language=language, model_id=model_id)
        facts["download"] = download(url, path, opener=opener)
        facts["downloaded"] = True
        lock = path + ".sha256"
        if os.path.exists(lock):       # a stale record from an earlier file
            os.remove(lock)
    facts.update(_check_installed(path, model_id))
    return facts


def install_local(source: str, model_id: str, models_dir: str) -> Dict[str, Any]:
    """Install a model file that was obtained manually (offline installation)."""
    if not os.path.isfile(source):
        raise ModelInstallError(f"No such file: {source}")
    probe = inspect_file(source)
    if probe["bytes"] < MIN_MODEL_BYTES or not probe["is_zip"]:
        raise ModelInstallError(f"{source} is not a Silero model file (expected a torch.package zip archive).")
    path = os.path.join(models_dir, "silero", f"{model_id}.pt")
    os.makedirs(os.path.dirname(path), exist_ok=True)
    tmp = path + ".part"
    shutil.copyfile(source, tmp)
    os.replace(tmp, path)
    lock = path + ".sha256"
    if os.path.exists(lock):
        os.remove(lock)
    facts = {"model_id": model_id, "downloaded": False, "installed_from": os.path.abspath(source)}
    facts.update(_check_installed(path, model_id))
    return facts


# ----------------------------------------------------------- diagnosis --

def _decode_der(der: bytes) -> Dict[str, Any]:
    """Subject / issuer / validity of a DER certificate (stdlib only)."""
    pem = ssl.DER_cert_to_PEM_cert(der)
    fd, name = tempfile.mkstemp(suffix=".pem")
    try:
        with os.fdopen(fd, "w", encoding="ascii") as fh:
            fh.write(pem)
        return ssl._ssl._test_decode_cert(name)  # type: ignore[attr-defined]
    finally:
        try:
            os.remove(name)
        except OSError:
            pass


def _name(rdns: Any) -> str:
    parts = []
    for rdn in rdns or ():
        for key, value in rdn:
            parts.append(f"{key}={value}")
    return ", ".join(parts)


def _summarize(info: Dict[str, Any], now: float) -> Dict[str, Any]:
    out = {"subject": _name(info.get("subject")), "issuer": _name(info.get("issuer")),
           "not_before": info.get("notBefore"), "not_after": info.get("notAfter")}
    try:
        out["expired"] = ssl.cert_time_to_seconds(info["notAfter"]) < now
        out["not_yet_valid"] = ssl.cert_time_to_seconds(info["notBefore"]) > now
    except Exception:
        out["expired"] = None
    return out


def tls_diagnostics(host: str = MODEL_HOST, port: int = 443, timeout: float = 15.0) -> Dict[str, Any]:
    """Why does (or doesn't) certificate verification succeed for `host`?

    Read-only: performs TLS handshakes and reads certificates. The one
    handshake made without verification exists only to LOOK at the chain the
    server presents; no data is requested or trusted over it.
    Never raises; problems are reported in the returned dict.
    """
    now = time.time()
    report: Dict[str, Any] = {
        "host": host, "port": port,
        "local_time_utc": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime(now)),
        "python": sys.version.split()[0], "openssl": ssl.OPENSSL_VERSION, "platform": sys.platform,
        "verification": [], "presented_chain": [], "system_store_matches": [], "notes": [],
    }

    # 1. verified handshakes, one per trust store
    for name, ctx in trust_contexts():
        entry: Dict[str, Any] = {"trust_store": name}
        try:
            with socket.create_connection((host, port), timeout=timeout) as raw:
                with ctx.wrap_socket(raw, server_hostname=host) as tls:
                    entry.update(ok=True, protocol=tls.version(), leaf=_summarize(tls.getpeercert() or {}, now))
        except ssl.SSLCertVerificationError as exc:
            entry.update(ok=False, error=str(exc), verify_code=exc.verify_code, verify_message=exc.verify_message)
        except Exception as exc:
            entry.update(ok=False, error=f"{type(exc).__name__}: {exc}")
        report["verification"].append(entry)

    # 2. the chain exactly as the server presents it (inspection only)
    try:
        look = ssl.SSLContext(ssl.PROTOCOL_TLS_CLIENT)
        look.check_hostname = False
        look.verify_mode = ssl.CERT_NONE
        with socket.create_connection((host, port), timeout=timeout) as raw:
            with look.wrap_socket(raw, server_hostname=host) as tls:
                ders: List[bytes] = []
                if hasattr(tls, "get_unverified_chain"):                      # Python 3.13+
                    ders = [bytes(c) for c in tls.get_unverified_chain()]
                elif hasattr(tls._sslobj, "get_unverified_chain"):            # Python 3.10-3.12 (private)
                    for cert in tls._sslobj.get_unverified_chain():
                        ders.append(cert.public_bytes(ssl._ssl.ENCODING_DER))  # type: ignore[attr-defined]
                else:
                    ders = [tls.getpeercert(binary_form=True)]
                    report["notes"].append("This Python can only show the leaf certificate, not the whole chain.")
        for der in ders:
            if der:
                report["presented_chain"].append(_summarize(_decode_der(der), now))
    except Exception as exc:
        report["notes"].append(f"Could not read the presented chain: {type(exc).__name__}: {exc}")

    # 3. Windows certificate store entries for the CAs named in that chain
    if sys.platform == "win32" and report["presented_chain"]:
        wanted = {c["issuer"] for c in report["presented_chain"]} | {c["subject"] for c in report["presented_chain"][1:]}
        try:
            for store in ("ROOT", "CA"):
                for der, encoding, _trust in ssl.enum_certificates(store):  # type: ignore[attr-defined]
                    if encoding != "x509_asn":
                        continue
                    try:
                        info = _summarize(_decode_der(der), now)
                    except Exception:
                        continue
                    if info["subject"] in wanted:
                        info["store"] = store
                        report["system_store_matches"].append(info)
        except Exception as exc:
            report["notes"].append(f"Could not read the Windows certificate store: {type(exc).__name__}: {exc}")

    # 4. clock check against the server (over a verified connection, if one works)
    try:
        origin = host if port == 443 else f"{host}:{port}"
        response, trust = _open_verified(f"https://{origin}/", timeout=timeout)
        with response:
            date = response.headers.get("Date")
        if date:
            from email.utils import parsedate_to_datetime
            report["clock_skew_seconds"] = round(time.time() - parsedate_to_datetime(date).timestamp(), 1)
    except Exception as exc:
        report["notes"].append("Clock check skipped: no verified connection could be opened.")
        report["clock_check_error"] = str(exc)

    # 5. conclusion from the facts above
    by_store = {v["trust_store"]: v for v in report["verification"]}
    system = by_store.get("operating system store", {})
    certifi_entry = next((v for k, v in by_store.items() if k.startswith("certifi")), None)
    expired_presented = [c for c in report["presented_chain"] if c.get("expired")]
    expired_in_store = [c for c in report["system_store_matches"] if c.get("expired")]
    leaf = report["presented_chain"][0] if report["presented_chain"] else None
    if leaf and leaf.get("expired"):
        conclusion = "The server's own certificate has expired (remote problem)."
    elif abs(report.get("clock_skew_seconds", 0)) > 300:
        conclusion = "The system clock differs from the server's by more than five minutes."
    elif system.get("ok") is False and certifi_entry and certifi_entry.get("ok"):
        why = []
        if expired_presented:
            why.append("the server also sends an expired CA certificate: " + "; ".join(c["subject"] for c in expired_presented))
        if expired_in_store:
            why.append("the Windows store holds an expired CA certificate for this chain: " + "; ".join(c["subject"] for c in expired_in_store))
        conclusion = ("The server certificate is valid. Verification fails only with the operating system store "
                      "and succeeds with the certifi CA bundle" + (" (" + "; ".join(why) + ")" if why else "") + ".")
    else:
        good = [v["trust_store"] for v in report["verification"] if v.get("ok")]
        bad = [v["trust_store"] for v in report["verification"] if not v.get("ok")]
        if good and not bad:
            conclusion = "Verification succeeds with every trust store."
        elif good:
            conclusion = f"Verification succeeds with: {', '.join(good)}; fails with: {', '.join(bad)}."
        else:
            conclusion = "Verification fails with every available trust store; see the entries above."
    report["conclusion"] = conclusion
    return report

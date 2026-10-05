# SPDX-License-Identifier: MIT
"""Collect Windows CP312 lock metadata without downloading executable archives.

The reviewed Mac code/model hashes remain shared. Official PyPI JSON, PyTorch
CPU index and Python release Sigstore metadata bind the Windows binary wheels
and optional embedded interpreter. No package, executable or model is fetched.
"""
from __future__ import annotations

import base64
from copy import deepcopy
from html.parser import HTMLParser
import json
from pathlib import Path
import urllib.parse
import urllib.request

ROOT = Path(__file__).absolute().parents[1]


def fetch_json(url):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(url, timeout=45) as response:
        data = response.read(8 * 1024 * 1024 + 1)
    if len(data) > 8 * 1024 * 1024:
        raise ValueError("Official metadata exceeds its bound")
    return json.loads(data)


def head_size(url):
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(urllib.request.Request(url, method="HEAD"), timeout=45) as response:
        return int(response.headers["Content-Length"])


class CpuLinks(HTMLParser):
    def __init__(self):
        super().__init__()
        self.links = []

    def handle_starttag(self, tag, attrs):
        if tag == "a":
            values = dict(attrs)
            if "href" in values:
                self.links.append(values["href"])


def cpu_torch_entry():
    index = "https://download.pytorch.org/whl/cpu/torch/"
    opener = urllib.request.build_opener(urllib.request.ProxyHandler({}))
    with opener.open(index, timeout=45) as response:
        data = response.read(4 * 1024 * 1024 + 1)
    if len(data) > 4 * 1024 * 1024:
        raise ValueError("CPU index exceeds its bound")
    parser = CpuLinks()
    parser.feed(data.decode("utf-8"))
    filename = "torch-2.2.2+cpu-cp312-cp312-win_amd64.whl"
    matches = [link for link in parser.links if urllib.parse.unquote(urllib.parse.urlparse(link).path).endswith("/" + filename)]
    if len(matches) != 1:
        raise ValueError("Expected one official Windows CPU PyTorch wheel")
    parsed = urllib.parse.urlparse(matches[0])
    digest = urllib.parse.parse_qs(parsed.fragment).get("sha256", [])
    if len(digest) != 1 or len(digest[0]) != 64:
        raise ValueError("CPU index lacks one SHA-256 digest")
    # The official index moved to an R2 hostname whose HEAD rejects some clients.
    # The long-standing official download hostname serves identical pinned bytes.
    url = "https://download.pytorch.org" + parsed.path
    return {"filename": filename, "url": url, "sha256": digest[0], "bytes": head_size(url)}, index


def windows_wheel(filename):
    if not filename.endswith(".whl"):
        return False
    _, py, abi, target = filename[:-4].rsplit("-", 3)
    if target == "any" and abi == "none":
        return True
    if target != "win_amd64":
        return False
    return "cp312" in py.split(".") or (abi == "abi3" and any(tag.startswith("cp3") and int(tag[2:]) <= 312 for tag in py.split(".")))


def main():
    mac = json.loads((ROOT / "runtime-lock.json").read_text(encoding="utf-8"))
    lock = deepcopy(mac)
    lock["target"] = {"system": "Windows", "machine": "AMD64", "pythonMajorMinor": [3, 12], "device": "cpu"}
    # Windows uses tokenizers 0.15.2. Its license bytes are identical to the
    # preserved Mac supplemental text, with the source bound to the new release.
    lock["bundledLicenseSources"]["Tokenizers-Apache-2.0.txt"]["url"] = "https://raw.githubusercontent.com/huggingface/tokenizers/701a73b869602b5639589d197e805349cdba3223/LICENSE"
    versions = {name: entry["version"] for name, entry in mac["packages"].items()}
    versions.update({"torch": "2.2.2+cpu", "transformers": "4.35.2", "tokenizers": "0.15.2"})
    lock["packages"] = {}
    for name, version in versions.items():
        # PyPI carries metadata for the base Torch release; CPU bytes are pinned
        # separately against the official PyTorch CPU index and HEAD size.
        metadata_url = "https://pypi.org/pypi/" + name + "/" + version.split("+")[0] + "/json"
        metadata = fetch_json(metadata_url)
        license_text = metadata["info"].get("license") or ""
        license_label = license_text.splitlines()[0][:100] if license_text else "; ".join(
            item.split(" :: ")[-1] for item in metadata["info"]["classifiers"] if item.startswith("License ::"))
        entry = {"version": version, "requiresPython": metadata["info"].get("requires_python"),
                 "license": license_label, "metadataUrl": metadata_url, "wheels": []}
        for item in metadata["urls"]:
            record = {"filename": item["filename"], "url": item["url"], "bytes": item["size"], "sha256": item["digests"]["sha256"]}
            if windows_wheel(item["filename"]):
                entry["wheels"].append(record)
            if name == "antlr4-python3-runtime" and item["packagetype"] == "sdist":
                entry["source"] = record
        if name == "torch":
            cpu, index = cpu_torch_entry()
            entry["wheels"] = [cpu]
            entry["binaryMetadataUrl"] = index
        if not entry["wheels"] and "source" not in entry:
            raise ValueError("No CP312 Windows binary wheel: " + name)
        lock["packages"][name] = entry
        print(name, version, "wheels", len(entry["wheels"]), flush=True)
    python_url = "https://www.python.org/ftp/python/3.12.10/python-3.12.10-embed-amd64.zip"
    sigstore = fetch_json(python_url + ".sigstore")
    message = sigstore["messageSignature"]["messageDigest"]
    if message["algorithm"] != "SHA2_256":
        raise ValueError("Unexpected Python release digest algorithm")
    lock["embeddedPython"] = {"filename": "python-3.12.10-embed-amd64.zip", "url": python_url,
                              "version": "3.12.10", "license": "PSF-2.0", "bytes": head_size(python_url),
                              "sha256": base64.b64decode(message["digest"]).hex(),
                              "digestMetadataUrl": python_url + ".sigstore"}
    destination = ROOT / "runtime-lock-windows.json"
    destination.write_text(json.dumps(lock, indent=2, sort_keys=True) + "\n", encoding="utf-8")
    print("Written", destination)


if __name__ == "__main__":
    main()

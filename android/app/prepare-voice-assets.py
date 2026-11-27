"""Prepare pinned offline voice assets for the Android build using Python 3."""

import hashlib
from pathlib import Path
import shutil
import sys
import tarfile
import tempfile
from urllib.request import urlopen


RELEASES = "https://github.com/k2-fsa/sherpa-onnx/releases/download"
SHERPA_AAR = "sherpa-onnx-2.0.2.aar"
X_ASR = "sherpa-onnx-x-asr-480ms-streaming-zipformer-transducer-zh-en-punct-int8-2026-06-05"
KOKORO = "kokoro-int8-multi-lang-v1_1"
X_ASR_SOURCE = "https://github.com/Gilgamesh-J/X-ASR"
X_ASR_CARD = "https://huggingface.co/GilgameshWind/X-ASR-zh-en"
X_ASR_PIN = "838297cd47fed858e6cf72eaf5a52f948a3edd73"
BUF_SIZE = 1024 * 1024


def digest(path):
    sha256 = hashlib.sha256()
    with path.open("rb") as source:
        for chunk in iter(lambda: source.read(BUF_SIZE), b""):
            sha256.update(chunk)
    return sha256.hexdigest()


def fetch(cache, url, sha256):
    target = cache / sha256 / url.rsplit("/", 1)[-1]
    if target.is_file() and digest(target) == sha256:
        return target

    print(f"Downloading {url}", flush=True)
    target.parent.mkdir(parents=True, exist_ok=True)
    with tempfile.TemporaryDirectory(dir=target.parent) as staging:
        pending = Path(staging) / target.name
        with urlopen(url, timeout=60) as source, pending.open("wb") as output:
            shutil.copyfileobj(source, output, BUF_SIZE)
        actual = digest(pending)
        if actual != sha256:
            raise ValueError(f"SHA-256 mismatch for {url}: expected {sha256}, got {actual}")
        pending.replace(target)
    return target


def extract(archive, source_dir, destination, files):
    destination.mkdir(parents=True)
    missing = {f"{source_dir}/{name}": name for name in files}
    with tarfile.open(archive, "r|bz2") as bundle:
        for member in bundle:
            name = missing.pop(member.name, None)
            if name is not None:
                if not member.isfile() or member.size == 0:
                    raise ValueError(f"Invalid {member.name} in {archive.name}")
                with bundle.extractfile(member) as source, (destination / name).open("wb") as output:
                    shutil.copyfileobj(source, output, BUF_SIZE)
                if not missing:
                    return
    raise ValueError(f"Missing from {archive.name}: {', '.join(sorted(missing))}")


def prepare_models(cache, voice):
    asr = fetch(cache, f"{RELEASES}/asr-models/{X_ASR}.tar.bz2",
                "fa5f63d618e5a01526e275a358bb7772e403f84808a4769fba52cffd8160bf74")
    vad = fetch(cache, f"{RELEASES}/asr-models/silero_vad_v5.onnx",
                "6b99cbfd39246b6706f98ec13c7c50c6b299181f2474fa05cbc8046acc274396")
    tts = fetch(cache, f"{RELEASES}/tts-models/{KOKORO}.tar.bz2",
                "259c9c8bc906d6078e4e0570421885dabb68b539c2f970fcbb890a58eeaf3e9c")
    sherpa_license = fetch(cache, "https://raw.githubusercontent.com/k2-fsa/sherpa-onnx/v2.0.2/LICENSE",
                           "cfc7749b96f63bd31c3c42b5c471bf756814053e847c10f3eb003417bc523d30")
    silero_license = fetch(cache, "https://raw.githubusercontent.com/snakers4/silero-vad/v5.0/LICENSE",
                           "2e63e9a38b6e8fc0c7bc37ce174caca1862870856c6daf5697cfb785e925520b")
    x_asr_readme = fetch(cache, f"https://raw.githubusercontent.com/Gilgamesh-J/X-ASR/{X_ASR_PIN}/README.md",
                         "7f0696b142da714d0dff5441cbcdf17a92a404fb7300bc05f867cf0056972154")
    x_asr_license = fetch(cache, f"https://raw.githubusercontent.com/Gilgamesh-J/X-ASR/{X_ASR_PIN}/LICENSE",
                          "c71d239df91726fc519c6eb72d318ec65820627232b2f796219e87dcf35d0ab4")

    extract(asr, X_ASR, voice / "zipformer", [
        "encoder.int8.onnx", "decoder.onnx", "joiner.int8.onnx", "tokens.txt",
    ])
    # The v2.0.2 asset frontend uses lexicons and FSTs for Kokoro.
    extract(tts, KOKORO, voice / "kokoro", [
        "model.int8.onnx", "voices.bin", "tokens.txt", "lexicon-us-en.txt", "lexicon-zh.txt",
        "date-zh.fst", "number-zh.fst", "phone-zh.fst", "LICENSE", "README.md",
    ])
    shutil.copyfile(x_asr_readme, voice / "zipformer" / "README.md")
    shutil.copyfile(x_asr_license, voice / "zipformer" / "LICENSE")
    shutil.copyfile(sherpa_license, voice / "sherpa-onnx-LICENSE")
    shutil.copyfile(silero_license, voice / "silero-LICENSE")
    shutil.copyfile(vad, voice / vad.name)
    (voice / "ATTRIBUTION.txt").write_text(
        "sherpa-onnx v2.0.2 (Apache-2.0)\nhttps://github.com/k2-fsa/sherpa-onnx/releases/tag/v2.0.2\n\n"
        f"X-ASR zh-en 480 ms, Gilgamesh-J (Apache-2.0)\n{X_ASR_SOURCE}\n{X_ASR_CARD}\n"
        f"{RELEASES}/asr-models/{X_ASR}.tar.bz2\n\n"
        "Silero VAD v5, Silero Team (MIT)\nhttps://github.com/snakers4/silero-vad/releases/tag/v5.0\n\n"
        "Kokoro v1.1-zh by Hexgrad (Apache-2.0)\nhttps://huggingface.co/hexgrad/Kokoro-82M-v1.1-zh\n"
        f"{RELEASES}/tts-models/{KOKORO}.tar.bz2\n",
        encoding="utf-8",
    )


def prepare(cache, assets, aar):
    sherpa = fetch(cache, f"{RELEASES}/v2.0.2/{SHERPA_AAR}",
                   "6420cfb86c2ef8462dadd77b2202b7430487bdfb2bc715e9ce2864871209a80e")
    # The script checksum also covers the source pins and the asset selection.
    bundle = cache / "prepared" / digest(Path(__file__))
    if not bundle.is_dir():
        bundle.parent.mkdir(parents=True, exist_ok=True)
        with tempfile.TemporaryDirectory(dir=bundle.parent) as staging:
            pending = Path(staging) / "assets"
            prepare_models(cache, pending / "voice")
            try:
                pending.rename(bundle)
            except OSError:
                if not bundle.is_dir():
                    raise

    if assets.exists():
        shutil.rmtree(assets)
    shutil.copytree(bundle, assets)
    aar.parent.mkdir(parents=True, exist_ok=True)
    shutil.copyfile(sherpa, aar)


if __name__ == "__main__":
    prepare(*(Path(arg) for arg in sys.argv[1:]))

"""PDF.js·OCR 도구와 학습 자료를 고정된 버전으로 내려받아 검증합니다."""

import base64
import hashlib
import io
from pathlib import Path
import tarfile
from urllib.request import urlopen


ROOT = Path(__file__).resolve().parents[1] / "vendor"
PDFJS = {
    "version": "6.4.299",
    "integrity": "AVl138zALtfaAPvADulE0PZThbYzCBS79nL4pOSL/6Sm/4AH5A21BD9VHt97OlCuzJuCpmeZtAtkinisF4Vb1g==",
    "files": {"build/pdf.mjs", "build/pdf.worker.mjs", "LICENSE", "package.json"},
    "folders": ("cmaps/", "standard_fonts/", "wasm/", "iccs/"),
}
TESSERACT = {
    "version": "6.0.1",
    "integrity": "/sPvMvrCtgxnNRCjbTYbr7BRu0yfWDsMZQ2a/T5aN/L1t8wUQN6tTWv6p6FwzpoEBA0jrN2UD2SX4QQFRdoDbA==",
    "files": {
        "dist/tesseract.min.js", "dist/worker.min.js", "LICENSE",
        "dist/tesseract.min.js.LICENSE.txt", "dist/worker.min.js.LICENSE.txt",
    },
}
TESSERACT_CORE = {
    "version": "6.1.2",
    "integrity": "pv4GjmramjdObhDyR1q85Td8X60Puu/lGQn7Kw2id05LLgHhAcWgnz6xSdMCSxBMWjQDmMyDXPTC2aqADdpiow==",
    "files": {
        "LICENSE", "tesseract-core-lstm.wasm.js", "tesseract-core-simd-lstm.wasm.js",
    },
}
TESSDATA_REVISION = "87416418657359cb625c412a48b6e1d6d41c29bd"
TESSDATA = {
    "kor": "60986d44497689f3abace0b148199476d93292e1",
    "eng": "bbef4675053b5b468cdb477053e28b1c698ba08e",
}


def download(url):
    with urlopen(url, timeout=180) as response:
        return response.read()


def extract_verified(name, package, output, asset_folders=()):
    destination = ROOT / output
    expected = [
        destination / relative for relative in package["files"]
    ]
    if all(path.is_file() for path in expected):
        print(f"{name} {package['version']} 이미 준비되어 있어 건너뜁니다.")
        return
    archive = download(
        f"https://registry.npmjs.org/{name}/-/{name}-{package['version']}.tgz"
    )
    actual = base64.b64encode(hashlib.sha512(archive).digest()).decode("ascii")
    if actual != package["integrity"]:
        raise RuntimeError(f"{name} {package['version']}의 무결성 확인에 실패했습니다.")
    destination.mkdir(parents=True, exist_ok=True)
    extracted = set()
    with tarfile.open(fileobj=io.BytesIO(archive), mode="r:gz") as archive_file:
        for member in archive_file.getmembers():
            path = Path(member.name)
            if not member.isfile() or path.parts[0] != "package":
                continue
            relative = Path(*path.parts[1:])
            if ".." in relative.parts or relative.is_absolute():
                raise RuntimeError("의존성 압축 파일에 잘못된 경로가 있습니다.")
            if (str(relative) not in package["files"]
                    and not str(relative).startswith(asset_folders)):
                continue
            target = destination / relative
            target.parent.mkdir(parents=True, exist_ok=True)
            with archive_file.extractfile(member) as source:
                target.write_bytes(source.read())
            extracted.add(str(relative))
    missing = package["files"] - extracted
    if missing:
        raise RuntimeError(f"{name}에서 필요한 파일을 찾지 못했습니다: {', '.join(sorted(missing))}")
    print(f"{name} {package['version']} 준비 완료")


def download_tessdata():
    destination = ROOT / "tesseract" / "lang"
    destination.mkdir(parents=True, exist_ok=True)
    for language, expected_sha in TESSDATA.items():
        url = (
            "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/"
            f"{TESSDATA_REVISION}/{language}.traineddata"
        )
        data = download(url)
        git_blob = hashlib.sha1(f"blob {len(data)}\0".encode("ascii") + data).hexdigest()
        if git_blob != expected_sha:
            raise RuntimeError(f"{language} OCR 학습 자료의 무결성 확인에 실패했습니다.")
        (destination / f"{language}.traineddata").write_bytes(data)
        print(f"{language} OCR 학습 자료 준비 완료 ({len(data) // 1024} KiB)")

    license_url = (
        "https://raw.githubusercontent.com/tesseract-ocr/tessdata_fast/"
        f"{TESSDATA_REVISION}/LICENSE"
    )
    (destination / "LICENSE").write_bytes(download(license_url))


def main():
    print("PDF 및 OCR 도구를 고정 버전으로 준비합니다.")
    extract_verified("pdfjs-dist", PDFJS, Path("pdfjs"), PDFJS["folders"])
    extract_verified("tesseract.js", TESSERACT, Path("tesseract"))
    extract_verified("tesseract.js-core", TESSERACT_CORE, Path("tesseract/core"))
    download_tessdata()
    print("준비 완료: vendor/pdfjs/ 및 vendor/tesseract/ (라이선스 포함)")


if __name__ == "__main__":
    main()

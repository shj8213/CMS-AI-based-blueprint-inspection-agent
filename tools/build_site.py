from pathlib import Path
import json
import shutil
import tempfile

ROOT = Path(__file__).resolve().parents[1]
OUTPUT = ROOT / "dist"
MANIFEST = ".blueprint-site-manifest.json"
PUBLIC_FIXTURES = (
    "agent-result.json",
    "broken.pdf",
    "mixed.pdf",
    "paths.pdf",
    "review-a.dxf",
    "review-b.dxf",
    "review-c.dxf",
    "reviewer-result-v2.json",
    "scan-only.pdf",
    "scan.pdf",
    "simple.dxf",
    "simple.pdf",
    "shaft-practice-challenge.pdf",
    "shaft-practice-reference.pdf",
)


def copy_tree(source: Path, destination: Path) -> None:
    if not source.is_dir():
        raise FileNotFoundError(f"{source.relative_to(ROOT)}가 없어요. 먼저 PDF 읽기 도구를 준비해 주세요.")
    shutil.copytree(source, destination, dirs_exist_ok=True)


def build() -> None:
    with tempfile.TemporaryDirectory(dir=ROOT, prefix=".site-build-") as temporary:
        staged = Path(temporary) / "dist"
        staged.mkdir()
        shutil.copy2(ROOT / "index.html", staged / "index.html")
        copy_tree(ROOT / "src", staged / "src")
        copy_tree(ROOT / "vendor", staged / "vendor")

        fixture_source = ROOT / "tests" / "fixtures"
        fixture_output = staged / "tests" / "fixtures"
        fixture_output.mkdir(parents=True)
        for filename in PUBLIC_FIXTURES:
            shutil.copy2(fixture_source / filename, fixture_output / filename)
        files = sorted(path.relative_to(staged).as_posix() for path in staged.rglob("*") if path.is_file())
        (staged / MANIFEST).write_text(json.dumps(files, ensure_ascii=False), encoding="utf-8")

        if OUTPUT.exists():
            if OUTPUT.is_symlink():
                raise RuntimeError("dist 경로가 심볼릭 링크라 내용을 바꾸지 않았어요.")
            manifest_path = OUTPUT / MANIFEST
            if not manifest_path.is_file():
                raise RuntimeError("dist 폴더에 이 도구가 만든 표식이 없어요. 기존 파일을 보존했으니 먼저 내용을 확인해 주세요.")
            previous_files = json.loads(manifest_path.read_text(encoding="utf-8"))
            actual = {
                path.relative_to(OUTPUT).as_posix()
                for path in OUTPUT.rglob("*")
                if path.is_file() and path.name != MANIFEST
            }
            if actual != set(previous_files):
                raise RuntimeError("dist 폴더에 이전 빌드 외 파일이 있어요. 내용을 확인한 뒤 다시 실행해 주세요.")
            for filename in previous_files:
                path = Path(filename)
                if path.is_absolute() or ".." in path.parts:
                    raise RuntimeError("dist 빌드 표식의 경로가 올바르지 않아요.")
                target = OUTPUT / path
                if target.is_symlink() or not target.is_file():
                    raise RuntimeError("dist 폴더의 기존 파일이 예상과 달라요.")
                target.unlink()
            manifest_path.unlink()
            for directory in sorted((path for path in OUTPUT.rglob("*") if path.is_dir()), reverse=True):
                directory.rmdir()
            OUTPUT.rmdir()
        staged.replace(OUTPUT)
    print(f"정적 홈페이지 준비 완료: {OUTPUT.relative_to(ROOT)}")


if __name__ == "__main__":
    build()

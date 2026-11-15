"""기능사 양식 축 연습 도면 HTML을 Chrome으로 벡터 PDF 두 장(기준·비교)으로 만들어요.

사용법: python3 tools/make_exam_style_drawings.py
Chrome 위치가 다르면 환경 변수 CHROME에 실행 파일 경로를 넣어 주세요. 외부 패키지는 필요 없어요.
"""

from pathlib import Path
import os
import subprocess
import tempfile

ROOT = Path(__file__).resolve().parents[1]
SOURCE = ROOT / "tools" / "practice-drawings" / "shaft-exam-style.html"
DESTINATION = ROOT / "tests" / "fixtures"
CHROME = os.environ.get("CHROME", "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome")
VARIANTS = {
    "reference": "shaft-exam-style-reference.pdf",
    "challenge": "shaft-exam-style-challenge.pdf",
}


def main() -> None:
    for variant, name in VARIANTS.items():
        with tempfile.TemporaryDirectory() as profile:
            subprocess.run([
                CHROME, "--headless=new", "--disable-gpu", "--no-pdf-header-footer",
                f"--user-data-dir={profile}", f"--print-to-pdf={DESTINATION / name}",
                f"{SOURCE.as_uri()}?variant={variant}",
            ], check=True, stdout=subprocess.DEVNULL, stderr=subprocess.DEVNULL, timeout=120)
        print(f"만들었어요: tests/fixtures/{name}")


if __name__ == "__main__":
    main()

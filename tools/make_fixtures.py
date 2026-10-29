"""개인정보 없는 PDF 검사 예제를 직접 생성합니다. 외부 패키지는 필요 없어요."""

from pathlib import Path
import math
import zlib


DESTINATION = Path(__file__).resolve().parents[1] / "tests" / "fixtures"


def stream(content, attributes=b""):
    return b"<< /Length " + str(len(content)).encode() + b" " + attributes + b" >>\nstream\n" + content + b"\nendstream"


def write_pdf(name, objects):
    content = bytearray(b"%PDF-1.7\n%\xe2\xe3\xcf\xd3\n")
    offsets = [0]
    for index, value in enumerate(objects, 1):
        offsets.append(len(content))
        content.extend(f"{index} 0 obj\n".encode() + value + b"\nendobj\n")
    start_xref = len(content)
    content.extend(f"xref\n0 {len(objects) + 1}\n0000000000 65535 f \n".encode())
    for offset in offsets[1:]:
        content.extend(f"{offset:010d} 00000 n \n".encode())
    content.extend(f"trailer\n<< /Size {len(objects) + 1} /Root 1 0 R >>\nstartxref\n{start_xref}\n%%EOF\n".encode())
    (DESTINATION / name).write_bytes(content)


def scan_image():
    width, height = 600, 400
    pixels = bytearray([255]) * (width * height)

    def point(x, y, thickness=1):
        radius = thickness // 2
        for py in range(y - radius, y + radius + 1):
            for px in range(x - radius, x + radius + 1):
                if 0 <= px < width and 0 <= py < height:
                    pixels[py * width + px] = 0

    for x in range(50, 301):
        point(x, 140, 3)

    for step in range(1440):
        angle = step * math.pi / 720
        point(round(460 + 55 * math.cos(angle)), round(240 + 55 * math.sin(angle)), 3)

    glyphs = {
        "2": ("11111", "00001", "00001", "11111", "10000", "10000", "11111"),
        "5": ("11111", "10000", "10000", "11111", "00001", "00001", "11111"),
        "m": ("00000", "00000", "11010", "10101", "10101", "10101", "10101"),
        " ": ("000", "000", "000", "000", "000", "000", "000"),
    }
    x_start, y_start, scale = 55, 40, 8
    for character in "5 mm":
        glyph = glyphs[character]
        for row, bits in enumerate(glyph):
            for column, bit in enumerate(bits):
                if bit == "1":
                    for dy in range(scale):
                        for dx in range(scale):
                            point(x_start + column * scale + dx, y_start + row * scale + dy)
        x_start += (len(glyph[0]) + 2) * scale

    return stream(zlib.compress(pixels), b"/Type /XObject /Subtype /Image /Width 600 /Height 400 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode")


def main():
    DESTINATION.mkdir(parents=True, exist_ok=True)
    scanned = scan_image()
    scan_content = stream(b"q 300 0 0 200 0 0 cm /Scan Do Q\n")
    scan_page = b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /XObject << /Scan 4 0 R >> >> /Contents 5 0 R >>"
    write_pdf("scan.pdf", [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        scan_page, scanned, scan_content,
    ])
    vector = b"""0.1 0.3 0.8 RG
20 30 m 140 30 l S
225 130 m
225 143.807119 213.807119 155 200 155 c
186.192881 155 175 143.807119 175 130 c
175 116.192881 186.192881 105 200 105 c
213.807119 105 225 116.192881 225 130 c h S
BT /F1 12 Tf 20 190 Td (Hello blueprint) Tj ET
"""
    write_pdf("fit.pdf", [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 240] /Resources << /Font << /F1 5 0 R >> >> /Contents 4 0 R >>",
        stream(b"BT /F1 12 Tf 20 190 Td (H7/g6) Tj ET\n"),
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
    ])
    second = b"""q 2 0 0 2 30 40 cm
5 10 m 15 10 l S
/Shape Do Q
q 2 0 0 1 0 0 cm
110 100 m
110 105.522847 105.522847 110 100 110 c
94.477153 110 90 105.522847 90 100 c
90 94.477153 94.477153 90 100 90 c
105.522847 90 110 94.477153 110 100 c h S Q
BT /F1 12 Tf 20 190 Td (Page two) Tj ET
"""
    write_pdf("simple.pdf", [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 240] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 240] /CropBox [10 20 290 220] /Rotate 90 /Resources << /Font << /F1 5 0 R >> /XObject << /Shape 8 0 R >> >> /Contents 7 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        stream(vector),
        stream(second),
        stream(b"10 10 m 20 10 l S\n", b"/Type /XObject /Subtype /Form /BBox [0 0 100 100] /Matrix [1 0 0 1 5 7] /Resources << >>"),
    ])
    image = stream(bytes([0, 0, 0, 255, 255, 255, 255, 255, 255, 0, 0, 0]),
                   b"/Type /XObject /Subtype /Image /Width 2 /Height 2 /ColorSpace /DeviceRGB /BitsPerComponent 8")
    image_page = b"q 120 0 0 120 20 20 cm /Scan Do Q\n"
    write_pdf("scan-only.pdf", [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 200 200] /Resources << /XObject << /Scan 4 0 R >> >> /Contents 5 0 R >>",
        stream(zlib.compress(bytes([255]) * 64), b"/Type /XObject /Subtype /Image /Width 8 /Height 8 /ColorSpace /DeviceGray /BitsPerComponent 8 /Filter /FlateDecode"),
        stream(image_page),
    ])
    write_pdf("mixed.pdf", [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R 4 0 R] /Count 2 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 240] /Resources << /Font << /F1 5 0 R >> >> /Contents 6 0 R >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 200] /Resources << /XObject << /Scan 7 0 R >> >> /Contents 8 0 R >>",
        b"<< /Type /Font /Subtype /Type1 /BaseFont /Helvetica >>",
        stream(vector), scanned, scan_content,
    ])
    write_pdf("paths.pdf", [
        b"<< /Type /Catalog /Pages 2 0 R >>",
        b"<< /Type /Pages /Kids [3 0 R] /Count 1 >>",
        b"<< /Type /Page /Parent 2 0 R /MediaBox [0 0 300 240] /Resources << >> /Contents 4 0 R >>",
        stream(b"20 30 40 50 re S\n100 100 m 120 100 l 120 120 l f\n200 200 m 210 210 l n\n"),
    ])
    (DESTINATION / "broken.pdf").write_bytes(b"PDF example: not a real PDF\n")
    print("PDF 예제 7개 생성 완료: simple, fit, scan, scan-only, mixed, paths, broken")


if __name__ == "__main__":
    main()

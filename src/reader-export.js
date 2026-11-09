export function coordinateNote({ format, unit }) {
  return format === "PDF"
    ? `PDF 좌표는 각 페이지 왼쪽 위가 (0, 0)이며 오른쪽·아래쪽이 +방향인 페이지 좌표예요. 단위는 ${unit}이며 실제 부품의 mm 치수가 아니에요. 글자는 시작 기준점이에요.`
    : `DXF 좌표와 단위(${unit})는 원본 값 그대로예요. 오른쪽·위쪽이 +방향이며 단위를 추정하거나 mm로 변환하지 않아요. 글자는 삽입점이에요.`;
}

export function serializeReaderResult(result) {
  if (!result) throw new Error("복사할 읽기 결과가 없어요. 도면을 다시 읽어 주세요.");
  const { format, unit, pages, elements, warnings } = result;
  return JSON.stringify({
    schema_version: "homepage-reader-v1",
    format,
    unit,
    pages,
    elements,
    warnings,
    coordinate_note: coordinateNote(result),
    reading_note: "로컬 도면 판독 결과이며 설계 적합성 판정이 아니에요. 읽지 못한 요소는 warnings에 안내하며, OCR 글자와 이미지 도형은 원본과 비교해야 해요. confidence와 uncertain을 그대로 확인하고 후보를 확정하지 마세요.",
  }, null, 2);
}

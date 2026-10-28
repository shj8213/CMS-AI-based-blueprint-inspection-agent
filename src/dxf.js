const UNIT_NAMES = {
  0: "단위 미지정", 1: "인치", 2: "피트", 4: "mm", 5: "cm", 6: "m",
};

function decodeDxf(buffer) {
  const bytes = new Uint8Array(buffer);
  const header = new TextDecoder("ascii").decode(bytes.subarray(0, 4096));
  if (header.startsWith("AutoCAD Binary DXF")) {
    throw new Error("바이너리 DXF는 아직 읽지 못해요. 문자 형식(ASCII) DXF로 내보내 주세요.");
  }
  try {
    return new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch (error) {
    if (!(error instanceof TypeError)) throw error;
    const codepage = header.match(/\$DWGCODEPAGE\s*\r?\n\s*3\s*\r?\n\s*ANSI_(\d+)/)?.[1];
    const encoding = { 949: "euc-kr", 1252: "windows-1252", 932: "shift_jis", 936: "gbk", 950: "big5" }[codepage];
    if (!encoding) {
      throw new Error("DXF의 글자 인코딩을 알 수 없어요. UTF-8 DXF로 다시 저장해 주세요.");
    }
    try {
      return new TextDecoder(encoding, { fatal: true }).decode(bytes);
    } catch (decodingError) {
      if (!(decodingError instanceof TypeError)) throw decodingError;
      throw new Error("DXF의 글자가 손상되었거나 지원하지 않는 인코딩이에요.");
    }
  }
}

function pairsFrom(text) {
  const lines = text.replace(/^\uFEFF/, "").replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && lines.at(-1).trim() === "") lines.pop();
  if (lines.length % 2 !== 0 || !lines.length) {
    throw new Error("DXF의 코드와 값이 짝을 이루지 않아요. 파일이 잘렸는지 확인해 주세요.");
  }
  const pairs = [];
  for (let index = 0; index < lines.length; index += 2) {
    const code = lines[index].trim();
    if (!/^\d+$/.test(code) || Number(code) > 1071) {
      throw new Error(`DXF ${index + 1}번째 줄의 코드가 올바르지 않아요.`);
    }
    pairs.push({ code: Number(code), value: lines[index + 1].trim() });
  }
  if (pairs.at(-1).code !== 0 || pairs.at(-1).value !== "EOF") {
    throw new Error("DXF의 끝 표시가 없어요. 파일이 잘렸는지 확인해 주세요.");
  }
  return pairs;
}

function numberOf(groups, code, fallback) {
  const value = groups.find((group) => group.code === code)?.value;
  if (value === undefined && fallback !== undefined) return fallback;
  const number = value === undefined || value === "" ? NaN : Number(value);
  if (!Number.isFinite(number)) throw new Error(`좌표 또는 숫자(코드 ${code})가 올바르지 않아요.`);
  return number;
}

function pointOf(groups, xCode, yCode) {
  return { x: numberOf(groups, xCode), y: numberOf(groups, yCode) };
}

function decodeText(value, multiline) {
  const text = value
    .replace(/\\U\+([0-9a-f]{4})/gi, (_, hex) => String.fromCharCode(parseInt(hex, 16)))
    .replace(/%%d/gi, "°").replace(/%%p/gi, "±").replace(/%%c/gi, "Ø");
  if (!multiline) return text;
  return text
    .replace(/\\P/g, "\n").replace(/\\~/g, " ")
    .replace(/\\[ACFHQTW][^;]*;/gi, "")
    .replace(/\\[LlOoKk]/g, "")
    .replace(/[{}]/g, "");
}

export function readDxf(buffer) {
  const pairs = pairsFrom(decodeDxf(buffer));
  const elements = [];
  const warnings = new Set();
  const unsupported = new Set();
  let section = null;
  let foundEntities = false;
  let unit = "단위 미지정";
  for (let index = 0; index < pairs.length;) {
    const pair = pairs[index];
    if (pair.code !== 0) throw new Error("DXF 구역의 시작 표시가 올바르지 않아요.");
    let end = index + 1;
    while (end < pairs.length && pairs[end].code !== 0) end += 1;
    const groups = pairs.slice(index + 1, end);
    index = end;
    if (pair.value === "SECTION") {
      if (section || groups[0]?.code !== 2) throw new Error("DXF 구역 구성이 올바르지 않아요.");
      section = groups[0].value;
      if (section === "ENTITIES") foundEntities = true;
      if (section === "HEADER") {
        const unitIndex = groups.findIndex((group) => group.code === 9 && group.value === "$INSUNITS");
        if (unitIndex >= 0) {
          const code = numberOf(groups.slice(unitIndex + 1, unitIndex + 2), 70);
          unit = UNIT_NAMES[code] ?? `DXF 단위 코드 ${code}`;
        }
      }
      continue;
    }
    if (pair.value === "ENDSEC") {
      if (!section) throw new Error("DXF 구역의 끝 표시가 올바르지 않아요.");
      section = null;
      continue;
    }
    if (pair.value === "EOF") {
      if (section) throw new Error("DXF 구역이 끝나기 전에 파일이 끝났어요.");
      continue;
    }
    if (!section) throw new Error("DXF 요소가 구역 밖에 있어요.");
    if (section !== "ENTITIES") continue;
    if (!["LINE", "CIRCLE", "TEXT", "MTEXT", "LWPOLYLINE"].includes(pair.value)) {
      unsupported.add(pair.value);
      continue;
    }
    try {
      if (numberOf(groups, 210, 0) !== 0 || numberOf(groups, 220, 0) !== 0 ||
          numberOf(groups, 230, 1) !== 1 || numberOf(groups, 30, 0) !== 0 ||
          numberOf(groups, 31, 0) !== 0 || numberOf(groups, 38, 0) !== 0) {
        warnings.add("확인 필요: 3차원 또는 기울어진 좌표계의 요소는 제외했어요.");
        continue;
      }
      if (numberOf(groups, 67, 0) !== 0) {
        warnings.add("확인 필요: 배치 공간의 요소는 제외하고 모형 공간만 읽었어요.");
        continue;
      }
      if (pair.value === "LINE") {
        elements.push({ kind: "line", start: pointOf(groups, 10, 20), end: pointOf(groups, 11, 21) });
      } else if (pair.value === "CIRCLE") {
        const radius = numberOf(groups, 40);
        if (radius <= 0) throw new Error("원의 반지름은 0보다 커야 해요.");
        elements.push({ kind: "circle", center: pointOf(groups, 10, 20), radius });
      } else if (pair.value === "LWPOLYLINE") {
        const vertices = [];
        for (const group of groups) {
          if (group.code === 10) vertices.push([group]);
          else if ([20, 42].includes(group.code)) {
            if (!vertices.length) throw new Error("연결선의 꼭짓점 순서가 올바르지 않아요.");
            vertices.at(-1).push(group);
          }
        }
        if (vertices.length < 2 || numberOf(groups, 90) !== vertices.length) {
          throw new Error("연결선의 꼭짓점 개수가 올바르지 않아요.");
        }
        const points = vertices.map((vertex) => pointOf(vertex, 10, 20));
        const closed = (numberOf(groups, 70, 0) & 1) !== 0;
        const count = closed ? points.length : points.length - 1;
        for (let vertex = 0; vertex < count; vertex += 1) {
          if (numberOf(vertices[vertex], 42, 0) !== 0) {
            warnings.add("확인 필요: 연결선 안의 원호는 아직 읽지 못해 제외했어요.");
          } else {
            elements.push({ kind: "line", start: points[vertex], end: points[(vertex + 1) % points.length] });
          }
        }
      } else {
        const content = groups.filter((group) => group.code === 1 || (pair.value === "MTEXT" && group.code === 3));
        if (!content.length) throw new Error("글자 내용이 없어요.");
        const raw = content.map((group) => group.value).join("");
        const height = numberOf(groups, 40);
        if (height <= 0) throw new Error("글자 높이는 0보다 커야 해요.");
        const text = decodeText(raw, pair.value === "MTEXT");
        if (!text.trim()) {
          warnings.add("확인 필요: 내용 없는 글자 요소는 제외했어요.");
          continue;
        }
        elements.push({
          kind: "text", position: pointOf(groups, 10, 20), text, height,
          rotation: numberOf(groups, 50, 0),
        });
        if (raw !== text || pair.value === "MTEXT" || numberOf(groups, 72, 0) !== 0 || numberOf(groups, 73, 0) !== 0) {
          warnings.add("확인 필요: 글자의 서식·정렬은 미리보기와 다를 수 있어요. 위치는 DXF 삽입점이에요.");
        }
      }
    } catch (error) {
      throw new Error(`DXF ${pair.value} 요소를 읽지 못했어요. ${error.message}`);
    }
  }
  if (!foundEntities) throw new Error("DXF에서 도면 요소 구역(ENTITIES)을 찾지 못했어요.");
  if (unsupported.size) warnings.add(`확인 필요: 아직 읽지 못하는 요소는 제외했어요: ${[...unsupported].join(", ")}.`);
  if (!elements.length) throw new Error(`읽을 수 있는 선·원·글자가 없어요. ${[...warnings].join(" ")}`);
  return { format: "DXF", unit, elements, pages: [{ number: 1 }], warnings: [...warnings] };
}

import { IDENTITY, inferCircle, multiply, transform } from "./geometry.js";
import { detectScanGeometry, pageScaleForScan } from "./scan.js";

const PDFJS_VERSION = "6.4.299";
const TESSERACT_VERSION = "6.0.1";
const OCR_CONFIDENCE_THRESHOLD = 80;
let libraryPromise;
let tesseractPromise;

async function loadLibrary() {
  const moduleUrl = new URL(`../vendor/pdfjs/build/pdf.mjs?v=${PDFJS_VERSION}`, import.meta.url);
  libraryPromise ??= import(moduleUrl.href).catch((error) => {
    libraryPromise = undefined;
    throw new Error("PDF 읽기 도구를 불러오지 못했어요. README의 준비 명령을 실행한 뒤 다시 시도해 주세요.", { cause: error });
  });
  const library = await libraryPromise;
  library.GlobalWorkerOptions.workerSrc = new URL(`../vendor/pdfjs/build/pdf.worker.mjs?v=${PDFJS_VERSION}`, import.meta.url).href;
  return library;
}

async function loadOcr() {
  if (!tesseractPromise) {
    tesseractPromise = new Promise((resolve, reject) => {
      if (window.Tesseract?.createWorker) {
        resolve(window.Tesseract);
        return;
      }
      const script = document.createElement("script");
      script.src = new URL(`../vendor/tesseract/dist/tesseract.min.js?v=${TESSERACT_VERSION}`, import.meta.url).href;
      script.onload = () => window.Tesseract?.createWorker
        ? resolve(window.Tesseract)
        : reject(new Error("OCR 실행 파일에 필요한 기능이 없어요."));
      script.onerror = () => reject(new Error("OCR 실행 파일을 불러오지 못했어요. README의 준비 명령을 실행해 주세요."));
      document.head.append(script);
    }).catch((error) => {
      tesseractPromise = undefined;
      throw error;
    });
  }
  return tesseractPromise;
}

async function createOcrWorker(onProgress) {
  const tesseract = await loadOcr();
  try {
    return await tesseract.createWorker("kor+eng", tesseract.OEM.LSTM_ONLY, {
      workerPath: new URL(`../vendor/tesseract/dist/worker.min.js?v=${TESSERACT_VERSION}`, import.meta.url).href,
      corePath: new URL("../vendor/tesseract/core/", import.meta.url).href,
      langPath: new URL("../vendor/tesseract/lang", import.meta.url).href,
      gzip: false,
      cacheMethod: "write",
      cachePath: "blueprint-ocr-kor-eng-6.0.1",
      logger: (event) => {
        if (event.status === "loading tesseract core" || event.status === "loading language traineddata") {
          onProgress("한국어·영어 스캔 글자 읽기 준비 중…");
        } else if (event.status) {
          const percentage = Number.isFinite(event.progress) ? ` ${Math.round(event.progress * 100)}%` : "";
          onProgress(`스캔 글자 읽기 ${event.status}${percentage}`);
        }
      },
    });
  } catch (error) {
    throw new Error(`OCR 실행 도구를 시작하지 못했어요. ${error.message}`, { cause: error });
  }
}

function pathElements(buffer, matrix, page, warnings, closeSubpaths) {
  if (!buffer) return [];
  const elements = [];
  let current = null;
  let first = null;
  let lines = [];
  let curves = [];
  function finish() {
    if (closeSubpaths && (lines.length || curves.length) && current && first &&
        Math.hypot(current.x - first.x, current.y - first.y) > 1e-5) {
      lines.push({ kind: "line", start: current, end: first });
    }
    const circle = lines.length === 0 ? inferCircle(curves) : null;
    if (circle) elements.push({ ...circle, page });
    else {
      for (const line of lines) elements.push({ ...line, page });
      if (curves.length) warnings.add(`${page}페이지 확인 필요: 원으로 판단하지 못한 곡선은 제외했어요.`);
    }
    lines = [];
    curves = [];
  }
  let index = 0;
  function point() {
    const x = buffer[index++];
    const y = buffer[index++];
    if (!Number.isFinite(x) || !Number.isFinite(y)) throw new Error("PDF 도형의 좌표가 올바르지 않아요.");
    return transform(matrix, x, y);
  }
  while (index < buffer.length) {
    // PDF.js 6.4.299의 DrawOPS 값이며 버전 변경 시 예제 검사를 함께 실행합니다.
    const operation = buffer[index++];
    if (operation === 0) {
      finish();
      current = first = point();
    } else if (operation === 1) {
      const end = point();
      if (!current) throw new Error("PDF 선의 시작점이 없어요.");
      lines.push({ kind: "line", start: current, end });
      current = end;
    } else if (operation === 2) {
      const control1 = point();
      const control2 = point();
      const end = point();
      if (!current) throw new Error("PDF 곡선의 시작점이 없어요.");
      curves.push({ start: current, control1, control2, end });
      current = end;
    } else if (operation === 3) {
      point();
      current = point();
      warnings.add(`${page}페이지 확인 필요: 이차 곡선은 아직 읽지 못해 제외했어요.`);
      curves.push({ unsupported: true });
    } else if (operation === 4) {
      if (current && first && Math.hypot(current.x - first.x, current.y - first.y) > 1e-5) {
        lines.push({ kind: "line", start: current, end: first });
      }
      current = first;
    } else {
      throw new Error("PDF에서 지원하지 않는 도형 명령을 만났어요.");
    }
  }
  finish();
  return elements;
}

function readPaths(operatorList, viewport, page, OPS, warnings) {
  const elements = [];
  let hasImage = false;
  const stack = [];
  let matrix = IDENTITY;
  let annotationDepth = 0;
  const fillOperations = new Set([
    OPS.fill, OPS.eoFill, OPS.fillStroke, OPS.eoFillStroke,
    OPS.closeFillStroke, OPS.closeEOFillStroke,
  ]);
  const imageOperations = new Set([
    OPS.paintImageXObject, OPS.paintInlineImageXObject, OPS.paintImageXObjectRepeat,
    OPS.paintImageMaskXObject, OPS.paintImageMaskXObjectGroup,
    OPS.paintInlineImageXObjectGroup, OPS.paintImageMaskXObjectRepeat,
    OPS.paintSolidColorImageMask,
  ]);
  for (let index = 0; index < operatorList.fnArray.length; index += 1) {
    const operation = operatorList.fnArray[index];
    const args = operatorList.argsArray[index];
    if (operation === OPS.beginAnnotation) {
      annotationDepth += 1;
      warnings.add(`${page}페이지 확인 필요: 주석에 포함된 도형은 제외했어요.`);
      continue;
    }
    if (operation === OPS.endAnnotation) {
      annotationDepth -= 1;
      continue;
    }
    if (annotationDepth > 0) continue;
    if (operation === OPS.save) stack.push(matrix);
    else if (operation === OPS.restore || operation === OPS.paintFormXObjectEnd || operation === OPS.endGroup) {
      if (!stack.length) throw new Error("PDF 좌표 변환의 구성이 올바르지 않아요.");
      matrix = stack.pop();
    } else if (operation === OPS.transform) matrix = multiply(matrix, args);
    else if (operation === OPS.paintFormXObjectBegin || operation === OPS.beginGroup) {
      stack.push(matrix);
      const local = operation === OPS.beginGroup ? args[0].matrix : args[0];
      if (local) matrix = multiply(matrix, local);
    } else if (operation === OPS.constructPath) {
      if (args[0] === OPS.endPath) continue;
      const paths = pathElements(args[1][0], multiply(viewport.transform, matrix), page, warnings, fillOperations.has(args[0]));
      for (const path of paths) elements.push(path);
    } else if (imageOperations.has(operation)) {
      hasImage = true;
    } else if (operation === OPS.rawFillPath || operation === OPS.shadingFill) {
      warnings.add(`${page}페이지 확인 필요: 일부 복잡한 채움 도형은 제외했어요.`);
    }
  }
  return { elements, hasImage };
}

function collectOcrWords(blocks, page, scale, warnings) {
  const words = [];
  for (const block of blocks ?? []) {
    for (const paragraph of block.paragraphs ?? []) {
      for (const line of paragraph.lines ?? []) {
        for (const word of line.words ?? []) {
          const text = word.text?.trim();
          const box = word.bbox;
          if (!text || !box || ![box.x0, box.y0, box.x1, box.y1].every(Number.isFinite) ||
              box.x1 <= box.x0 || box.y1 <= box.y0) continue;
          const confidence = Number.isFinite(word.confidence) ? word.confidence : 0;
          const uncertain = confidence < OCR_CONFIDENCE_THRESHOLD;
          words.push({
            kind: "text",
            text,
            position: { x: box.x0 / scale, y: box.y1 / scale },
            height: (box.y1 - box.y0) / scale,
            width: (box.x1 - box.x0) / scale,
            rotation: 0,
            page,
            source: "ocr",
            confidence,
            uncertain,
            scanBox: box,
          });
          if (uncertain) {
            warnings.add(`${page}페이지 확인 필요: 스캔 글자 ‘${text}’의 인식 신뢰도가 낮아요 (${Math.round(confidence)}%).`);
          }
        }
      }
    }
  }
  return words;
}

function renderPageToCanvas(page, viewport, scale) {
  const scaledViewport = page.getViewport({ scale });
  const canvas = document.createElement("canvas");
  canvas.width = Math.ceil(scaledViewport.width);
  canvas.height = Math.ceil(scaledViewport.height);
  const context = canvas.getContext("2d", { alpha: false, willReadFrequently: true });
  if (!context) throw new Error("이 브라우저에서 스캔 PDF 이미지를 처리할 수 없어요.");
  context.fillStyle = "#fff";
  context.fillRect(0, 0, canvas.width, canvas.height);
  return page.render({ canvasContext: context, viewport: scaledViewport }).promise
    .then(() => ({ canvas, viewport }));
}

function hasSelectableTextInBox(texts, box, scale) {
  return texts.some((text) => {
    const x = text.position.x * scale;
    const y = text.position.y * scale;
    return x >= box.x0 - 20 && x <= box.x1 + 20 &&
      y >= box.y0 - 30 && y <= box.y1 + 30;
  });
}

export async function readPdf(buffer, onProgress = () => {}) {
  const { getDocument, OPS } = await loadLibrary();
  const assetUrl = (directory) => new URL(`../vendor/pdfjs/${directory}/`, import.meta.url).href;
  const task = getDocument({
    data: new Uint8Array(buffer),
    cMapUrl: assetUrl("cmaps"),
    cMapPacked: true,
    standardFontDataUrl: assetUrl("standard_fonts"),
    wasmUrl: assetUrl("wasm"),
    iccUrl: assetUrl("iccs"),
    isEvalSupported: false,
    useSystemFonts: false,
    stopAtErrors: true,
    enableXfa: false,
  });
  let ocrWorker = null;
  try {
    const document = await task.promise;
    const elements = [];
    const pages = [];
    const warnings = new Set();
    const textCoverageReasons = [];
    for (let number = 1; number <= document.numPages; number += 1) {
      onProgress(`${number}/${document.numPages}페이지 읽는 중…`);
      const page = await document.getPage(number);
      const viewport = page.getViewport({ scale: 1 });
      const operators = await page.getOperatorList();
      const pathResult = readPaths(operators, viewport, number, OPS, warnings);
      if (operators.fnArray.includes(OPS.beginAnnotation)) {
        textCoverageReasons.push(`${number}페이지 주석의 글자는 검사 범위에 포함되지 않을 수 있어요.`);
      }
      const paths = pathResult.elements;
      const texts = [];
      // Safari에서도 읽을 수 있도록 스트림의 비동기 반복 대신 표준 reader를 사용합니다.
      const reader = page.streamTextContent().getReader();
      try {
        while (true) {
          const { value, done } = await reader.read();
          if (done) break;
          for (const item of value.items) {
            if (!("str" in item) || !item.str.trim()) continue;
            const matrix = multiply(viewport.transform, item.transform);
            const uncertain = /[\uFFFD\u0000-\u0008]/.test(item.str);
            texts.push({
              kind: "text", text: item.str, position: { x: matrix[4], y: matrix[5] },
              height: Math.hypot(matrix[2], matrix[3]), rotation: Math.atan2(matrix[1], matrix[0]) * 180 / Math.PI,
              width: item.width,
              page: number, uncertain,
            });
            if (uncertain) warnings.add(`${number}페이지 확인 필요: 일부 글자가 깨져 있어 원본과 비교해야 해요.`);
          }
        }
      } finally {
        reader.releaseLock();
      }
      let scanElements = [];
      if (pathResult.hasImage) {
        textCoverageReasons.push(`${number}페이지에 이미지가 있어요. OCR 신뢰도가 높아도 놓친 글자가 없다고 보장할 수 없어요.`);
        if (!ocrWorker) {
          onProgress("한국어·영어 스캔 글자 읽기 준비 중…");
          ocrWorker = await createOcrWorker(onProgress);
        }
        const scale = pageScaleForScan(viewport.width, viewport.height);
        onProgress(`${number}/${document.numPages}페이지 이미지 준비 중…`);
        const { canvas } = await renderPageToCanvas(page, viewport, scale);
        onProgress(`${number}/${document.numPages}페이지 스캔 글자 읽는 중…`);
        const recognized = await ocrWorker.recognize(canvas, {}, { blocks: true });
        const ocrWords = collectOcrWords(recognized.data.blocks, number, scale, warnings);
        const textBoxes = ocrWords.map(({ scanBox, confidence }) => ({
          left: scanBox.x0,
          top: scanBox.y0,
          right: scanBox.x1,
          bottom: scanBox.y1,
          confidence,
        }));
        scanElements = detectScanGeometry(canvas.getContext("2d", { willReadFrequently: true }).getImageData(
          0, 0, canvas.width, canvas.height
        ), textBoxes).map((element) => ({
          ...element,
          source: "image",
          page: number,
          start: element.start && { x: element.start.x / scale, y: element.start.y / scale },
          end: element.end && { x: element.end.x / scale, y: element.end.y / scale },
          center: element.center && { x: element.center.x / scale, y: element.center.y / scale },
          ...(element.radius !== undefined ? { radius: element.radius / scale } : {}),
          uncertain: true,
        }));
        for (const word of ocrWords) {
          if (hasSelectableTextInBox(texts, word.scanBox, scale)) continue;
          delete word.scanBox;
          scanElements.push(word);
        }
        if (!ocrWords.length) {
          warnings.add(`${number}페이지 확인 필요: 스캔에서 글자를 찾지 못했어요. 흐림·기울기·낮은 해상도를 확인해 주세요.`);
        }
        if (!scanElements.some((element) => element.kind === "line" || element.kind === "circle")) {
          warnings.add(`${number}페이지 확인 필요: 스캔 이미지에서 선·원을 확실히 찾지 못했어요. 원본과 비교해 주세요.`);
        }
        if (scanElements.length) {
          warnings.add(`${number}페이지 확인 필요: 스캔 이미지에서 찾은 선·원은 후보이므로 원본과 비교해 주세요.`);
        }
        canvas.width = 0;
        canvas.height = 0;
      }
      if (!paths.length && !texts.length && !scanElements.length) {
        warnings.add(`${number}페이지 확인 필요: 읽을 수 있는 선·원·글자가 없어요.`);
      }
      for (const path of paths) elements.push(path);
      for (const text of texts) elements.push(text);
      for (const element of scanElements) elements.push(element);
      pages.push({ number, width: viewport.width, height: viewport.height });
      page.cleanup();
      await new Promise((resolve) => setTimeout(resolve, 0));
    }
    if (!elements.length) throw new Error(`PDF에서 읽을 수 있는 선·원·글자가 없어요. ${[...warnings].join(" ")}`);
    if (elements.some((element) => element.kind === "circle" && element.source !== "image")) {
      warnings.add("확인 필요: PDF의 원은 곡선을 바탕으로 추정했어요. 중심과 반지름을 원본과 비교해 주세요.");
    }
    return {
      format: "PDF", unit: "포인트(1/72인치)", elements, pages, warnings: [...warnings],
      textCoverage: { reasons: textCoverageReasons },
    };
  } catch (error) {
    if (error.name === "PasswordException") throw new Error("암호가 걸린 PDF는 아직 읽지 못해요. 암호를 해제한 사본을 선택해 주세요.");
    if (error.name === "InvalidPDFException") throw new Error("올바른 PDF가 아니거나 파일이 손상되었어요. 원본 프로그램에서 다시 저장해 주세요.");
    throw error;
  } finally {
    if (ocrWorker) await ocrWorker.terminate();
    await task.destroy();
  }
}

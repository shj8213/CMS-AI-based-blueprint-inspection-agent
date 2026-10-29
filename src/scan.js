function clamp(value, minimum, maximum) {
  return Math.max(minimum, Math.min(maximum, value));
}

function isInsideBox(x, y, boxes, padding = 0) {
  return boxes.some((box) =>
    x >= box.left - padding && x <= box.right + padding &&
    y >= box.top - padding && y <= box.bottom + padding
  );
}

function collectEdges(image, textBoxes = []) {
  const { width, height, data } = image;
  const gray = new Uint8Array(width * height);
  const textMask = new Uint8Array(width * height);
  for (const box of textBoxes) {
    const left = clamp(Math.floor(box.x0 - 4), 0, width - 1);
    const right = clamp(Math.ceil(box.x1 + 4), 0, width - 1);
    const top = clamp(Math.floor(box.y0 - 4), 0, height - 1);
    const bottom = clamp(Math.ceil(box.y1 + 4), 0, height - 1);
    for (let y = top; y <= bottom; y += 1) textMask.fill(1, y * width + left, y * width + right + 1);
  }
  for (let index = 0; index < gray.length; index += 1) {
    const offset = index * 4;
    gray[index] = Math.round(data[offset] * 0.299 + data[offset + 1] * 0.587 + data[offset + 2] * 0.114);
  }
  const edges = [];
  for (let y = 1; y < height - 1; y += 1) {
    for (let x = 1; x < width - 1; x += 1) {
      if (textMask[y * width + x]) continue;
      const topLeft = gray[(y - 1) * width + x - 1];
      const top = gray[(y - 1) * width + x];
      const topRight = gray[(y - 1) * width + x + 1];
      const left = gray[y * width + x - 1];
      const right = gray[y * width + x + 1];
      const bottomLeft = gray[(y + 1) * width + x - 1];
      const bottom = gray[(y + 1) * width + x];
      const bottomRight = gray[(y + 1) * width + x + 1];
      const gx = -topLeft + topRight - 2 * left + 2 * right - bottomLeft + bottomRight;
      const gy = -topLeft - 2 * top - topRight + bottomLeft + 2 * bottom + bottomRight;
      const magnitude = Math.hypot(gx, gy);
      if (magnitude < 190) continue;
      edges.push({
        x, y,
        angle: (Math.round(Math.atan2(gy, gx) * 180 / Math.PI) + 360) % 180,
      });
    }
  }
  if (edges.length > 10_000) {
    const step = edges.length / 10_000;
    return Array.from({ length: 10_000 }, (_, index) => edges[Math.floor(index * step)]);
  }
  return edges;
}

function detectLines(edges, width, height, textBoxes) {
  if (edges.length < 20) return [];
  const diagonal = Math.ceil(Math.hypot(width, height));
  const rhoCount = diagonal * 2 + 1;
  const accumulator = new Uint16Array(180 * rhoCount);
  const cosines = new Float32Array(180);
  const sines = new Float32Array(180);
  for (let angle = 0; angle < 180; angle += 1) {
    const radians = angle * Math.PI / 180;
    cosines[angle] = Math.cos(radians);
    sines[angle] = Math.sin(radians);
  }
  for (const edge of edges) {
    const rho = Math.round(edge.x * cosines[edge.angle] + edge.y * sines[edge.angle]) + diagonal;
    const index = edge.angle * rhoCount + rho;
    if (accumulator[index] < 65535) accumulator[index] += 1;
  }
  const minimumVotes = Math.max(12, Math.floor(edges.length * 0.002));
  const candidates = [];
  for (let angle = 0; angle < 180; angle += 1) {
    for (let rho = 3; rho < rhoCount - 3; rho += 1) {
      const index = angle * rhoCount + rho;
      const votes = accumulator[index];
      if (votes < minimumVotes) continue;
      let localMaximum = true;
      for (let deltaAngle = -2; deltaAngle <= 2 && localMaximum; deltaAngle += 1) {
        if (angle + deltaAngle < 0 || angle + deltaAngle >= 180) continue;
        for (let deltaRho = -3; deltaRho <= 3; deltaRho += 1) {
          if (deltaAngle === 0 && deltaRho === 0) continue;
          if (accumulator[(angle + deltaAngle) * rhoCount + rho + deltaRho] > votes) {
            localMaximum = false;
            break;
          }
        }
      }
      if (localMaximum) candidates.push({ angle, rho: rho - diagonal, votes });
    }
  }
  candidates.sort((a, b) => b.votes - a.votes);
  const selected = [];
  const minimumLength = Math.max(40, Math.min(width, height) * 0.12);
  for (const candidate of candidates) {
    if (selected.length >= 100) break;
    const angle = candidate.angle * Math.PI / 180;
    const normalX = Math.cos(angle);
    const normalY = Math.sin(angle);
    const directionX = -normalY;
    const directionY = normalX;
    const projections = [];
    for (const edge of edges) {
        const difference = Math.abs(edge.angle - candidate.angle);
      const angleDifference = Math.min(difference, 180 - difference);
      if (angleDifference <= 7 && !isInsideBox(edge.x, edge.y, textBoxes, 2) &&
          Math.abs(edge.x * normalX + edge.y * normalY - candidate.rho) <= 2.5) {
        projections.push(edge.x * directionX + edge.y * directionY);
      }
    }
    if (projections.length < minimumVotes) continue;
    const minimum = Math.min(...projections);
    const maximum = Math.max(...projections);
    if (maximum - minimum < minimumLength) continue;
    if (selected.some((line) => {
      const angleDifference = Math.abs(candidate.angle - line.angle);
      return angleDifference <= 4 && Math.abs(candidate.rho - line.rho) <= 7;
    })) continue;
    selected.push({
      kind: "line",
      start: {
        x: directionX * minimum + normalX * candidate.rho,
        y: directionY * minimum + normalY * candidate.rho,
      },
      end: {
        x: directionX * maximum + normalX * candidate.rho,
        y: directionY * maximum + normalY * candidate.rho,
      },
      confidence: Math.min(1, projections.length / Math.max(1, (maximum - minimum) * 1.2)),
      uncertain: true,
      angle: candidate.angle,
      rho: candidate.rho,
    });
  }
  return selected.map(({ angle, rho, ...line }) => line);
}

function detectCircles(edges, textBoxes, width, height) {
  if (edges.length < 24) return [];
  const confidentTextBoxes = textBoxes.filter((box) => box.confidence >= 80);
  const minimumRadius = 9;
  const maximumRadius = Math.min(360, Math.floor(Math.min(width, height) / 3));
  if (maximumRadius < minimumRadius) return [];
  const centers = new Uint16Array(width * height);
  const touched = [];
  const candidates = [];
  for (let radius = minimumRadius; radius <= maximumRadius; radius += 3) {
    touched.length = 0;
    for (const edge of edges) {
      const radians = edge.angle * Math.PI / 180;
      for (const direction of [-1, 1]) {
        for (const adjustment of [-2, 0, 2]) {
          const voteRadius = radius + adjustment;
          const x = Math.round(edge.x - direction * Math.cos(radians) * voteRadius);
          const y = Math.round(edge.y - direction * Math.sin(radians) * voteRadius);
          if (x < 0 || x >= width || y < 0 || y >= height) continue;
          const index = y * width + x;
          if (centers[index] === 0) touched.push(index);
          if (centers[index] < 65535) centers[index] += 1;
        }
      }
    }
    touched.sort((a, b) => centers[b] - centers[a]);
    let selectedAtRadius = 0;
    for (const index of touched) {
      const votes = centers[index];
      if (votes < 12 || selectedAtRadius >= 3) break;
      const x = index % width;
      const y = Math.floor(index / width);
      if (candidates.some((candidate) =>
        candidate.radius === radius &&
        Math.hypot(candidate.x - x, candidate.y - y) < Math.max(8, radius * 0.35)
      )) continue;
      candidates.push({ x, y, radius, votes });
      selectedAtRadius += 1;
    }
    for (const index of touched) centers[index] = 0;
  }
  candidates.sort((a, b) => b.votes - a.votes);
  const circles = [];
  for (const candidate of candidates) {
    if (circles.length >= 40) break;
    const { x, y, radius } = candidate;
    if (isInsideBox(x, y, confidentTextBoxes, radius * 0.25)) continue;
    if (circles.some((circle) =>
      Math.hypot(circle.center.x - x, circle.center.y - y) < Math.max(10, Math.min(circle.radius, radius) * 0.6)
    )) continue;
    let edgeCount = 0;
    const sectors = new Uint8Array(36);
    let covered = 0;
    for (const edge of edges) {
      const dx = edge.x - x;
      const dy = edge.y - y;
      const distance = Math.hypot(dx, dy);
      if (Math.abs(distance - radius) > Math.max(2.5, radius * 0.045)) continue;
      edgeCount += 1;
      const sector = Math.floor((Math.atan2(dy, dx) + Math.PI) / (Math.PI * 2) * sectors.length) % sectors.length;
      if (!sectors[sector]) {
        sectors[sector] = 1;
        covered += 1;
      }
    }
    const coverage = covered / sectors.length;
    if (edgeCount < 18 || coverage < 0.48) continue;
    circles.push({
      kind: "circle",
      center: { x, y },
      radius,
      confidence: coverage,
      uncertain: true,
    });
  }
  return circles;
}

export function detectScanGeometry(image, textBoxes = []) {
  const { width, height } = image;
  if (!Number.isInteger(width) || !Number.isInteger(height) ||
      width < 3 || height < 3 || width * height > 5_000_000 ||
      image.data.length !== width * height * 4) {
    throw new Error("스캔 페이지 크기가 지원 범위를 벗어났어요.");
  }
  const edges = collectEdges(image);
  return [
    ...detectLines(edges, width, height, textBoxes),
    ...detectCircles(edges, textBoxes, width, height),
  ];
}

export function pageScaleForScan(width, height) {
  const maximumDimension = Math.max(width, height);
  const maximumPixels = 5_000_000;
  return Math.min(3, 2200 / maximumDimension, Math.sqrt(maximumPixels / (width * height)));
}

export const IDENTITY = [1, 0, 0, 1, 0, 0];

export function multiply(a, b) {
  return [
    a[0] * b[0] + a[2] * b[1],
    a[1] * b[0] + a[3] * b[1],
    a[0] * b[2] + a[2] * b[3],
    a[1] * b[2] + a[3] * b[3],
    a[0] * b[4] + a[2] * b[5] + a[4],
    a[1] * b[4] + a[3] * b[5] + a[5],
  ];
}

export function transform(matrix, x, y) {
  return {
    x: matrix[0] * x + matrix[2] * y + matrix[4],
    y: matrix[1] * x + matrix[3] * y + matrix[5],
  };
}

function distance(a, b) {
  return Math.hypot(a.x - b.x, a.y - b.y);
}

// PDF에는 원 명령이 없어, 닫힌 네 개의 베지어 곡선인지 확인합니다.
export function inferCircle(curves) {
  if (curves.length !== 4 || curves.some((curve) => curve.unsupported)) return null;
  const [a, b, c] = curves.map((curve) => curve.start);
  const denominator = 2 * (a.x * (b.y - c.y) + b.x * (c.y - a.y) + c.x * (a.y - b.y));
  if (Math.abs(denominator) < 1e-8) return null;
  const square = (p) => p.x * p.x + p.y * p.y;
  const center = {
    x: (square(a) * (b.y - c.y) + square(b) * (c.y - a.y) + square(c) * (a.y - b.y)) / denominator,
    y: (square(a) * (c.x - b.x) + square(b) * (a.x - c.x) + square(c) * (b.x - a.x)) / denominator,
  };
  const radius = distance(center, a);
  if (!Number.isFinite(radius) || radius < 1e-6) return null;
  const tolerance = radius * 0.003;
  for (let index = 0; index < curves.length; index += 1) {
    const { start, control1, control2, end } = curves[index];
    if (distance(end, curves[(index + 1) % 4].start) > tolerance) return null;
    for (let step = 0; step <= 16; step += 1) {
      const t = step / 16;
      const u = 1 - t;
      const point = {
        x: u ** 3 * start.x + 3 * u ** 2 * t * control1.x + 3 * u * t ** 2 * control2.x + t ** 3 * end.x,
        y: u ** 3 * start.y + 3 * u ** 2 * t * control1.y + 3 * u * t ** 2 * control2.y + t ** 3 * end.y,
      };
      if (Math.abs(distance(center, point) - radius) > tolerance) return null;
    }
  }
  return { kind: "circle", center, radius, uncertain: true };
}

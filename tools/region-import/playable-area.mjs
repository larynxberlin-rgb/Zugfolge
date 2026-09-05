// Ganzzahlige Geometriepruefung fuer den Offline-Releasebau. Die gesamte
// Gleislinie muss im Spielgebiet liegen, auch zwischen zwei inneren Halten.
function cross(a, b, c) {
  return (b[0] - a[0]) * (c[1] - a[1]) - (b[1] - a[1]) * (c[0] - a[0]);
}

function between(value, left, right) {
  return value >= (left < right ? left : right) && value <= (left > right ? left : right);
}

function containsScaled(polygon, point, denominator = 1n) {
  let inside = false;
  for (let i = 0, j = polygon.length - 1; i < polygon.length; j = i++) {
    const a = polygon[j].map((v) => v * denominator);
    const b = polygon[i].map((v) => v * denominator);
    const orientation = cross(a, b, point);
    if (orientation === 0n && between(point[0], a[0], b[0]) && between(point[1], a[1], b[1])) return true;
    if ((a[1] > point[1]) !== (b[1] > point[1]) && ((b[1] > a[1]) === (orientation > 0n))) inside = !inside;
  }
  return inside;
}

export function validatePlayableArea(value) {
  if (value === undefined) return undefined; // Historische Artefakte bleiben lesbar.
  if (value === null || typeof value !== "object" || Object.keys(value).join() !== "polygonE7"
      || !Array.isArray(value.polygonE7) || value.polygonE7.length < 3) throw new Error("Spielgebiet braucht ein Polygon in E7-Koordinaten.");
  const polygon = value.polygonE7.map((point) => {
    if (!Array.isArray(point) || point.length !== 2 || !point.every(Number.isSafeInteger)
        || Math.abs(point[0]) > 1_800_000_000 || Math.abs(point[1]) > 900_000_000) throw new Error("Spielgebiet besitzt ungueltige E7-Koordinaten.");
    return point.map(BigInt);
  });
  if (polygon.length > 3 && polygon[0][0] === polygon.at(-1)[0] && polygon[0][1] === polygon.at(-1)[1]) polygon.pop();
  const area = polygon.reduce((sum, p, i) => sum + p[0] * polygon[(i + 1) % polygon.length][1] - p[1] * polygon[(i + 1) % polygon.length][0], 0n);
  if (area === 0n) throw new Error("Spielgebiet besitzt keine Flaeche.");
  return polygon;
}

function segmentInside(polygon, a, b) {
  if (!containsScaled(polygon, a) || !containsScaled(polygon, b)) return false;
  const delta = [b[0] - a[0], b[1] - a[1]];
  if (delta[0] === 0n && delta[1] === 0n) return true;
  const cuts = [[0n, 1n], [1n, 1n]];
  for (let i = 0; i < polygon.length; i++) {
    const c = polygon[i];
    const d = polygon[(i + 1) % polygon.length];
    const edge = [d[0] - c[0], d[1] - c[1]];
    const offset = [c[0] - a[0], c[1] - a[1]];
    let denominator = delta[0] * edge[1] - delta[1] * edge[0];
    if (denominator === 0n) {
      if (cross(a, b, c) !== 0n) continue;
      const axis = delta[0] === 0n ? 1 : 0;
      for (const p of [c, d]) {
        const sign = delta[axis] < 0n ? -1n : 1n;
        const n = (p[axis] - a[axis]) * sign;
        const q = delta[axis] * sign;
        if (n > 0n && n < q) cuts.push([n, q]);
      }
      continue;
    }
    let t = offset[0] * edge[1] - offset[1] * edge[0];
    let u = offset[0] * delta[1] - offset[1] * delta[0];
    if (denominator < 0n) { denominator = -denominator; t = -t; u = -u; }
    if (t > 0n && t < denominator && u >= 0n && u <= denominator) cuts.push([t, denominator]);
  }
  cuts.sort(([n, q], [m, r]) => n * r < m * q ? -1 : n * r > m * q ? 1 : 0);
  for (let i = 1; i < cuts.length; i++) {
    const [n, q] = cuts[i - 1];
    const [m, r] = cuts[i];
    const numerator = n * r + m * q;
    const denominator = 2n * q * r;
    if (!containsScaled(polygon, [a[0] * denominator + delta[0] * numerator, a[1] * denominator + delta[1] * numerator], denominator)) return false;
  }
  return true;
}

export function trackInsidePlayableArea(polygon, coordinates) {
  if (polygon === undefined) return true;
  if (!Array.isArray(coordinates) || coordinates.length < 2) return false;
  const points = coordinates.map(({ longitudeE7, latitudeE7 }) => [BigInt(longitudeE7), BigInt(latitudeE7)]);
  return points.slice(1).every((point, index) => segmentInside(polygon, points[index], point));
}

export type AssetId = 'crate' | 'table' | 'shelf';
export type Placement = { id: AssetId; x: number; z: number; rotation: number };
export type Point = { x: number; z: number };

export const assets = [
  { id: 'crate' as const, name: '상자', english: 'Storage crate', width: .8, depth: .65, triangles: 1620, bytes: 117024, sha256: 'fd5ee84a7617c54c254528230c48f1c0e69e0c17743fe540e939623bef717a06' },
  { id: 'table' as const, name: '작업대', english: 'Workbench', width: 1.4, depth: .7, triangles: 972, bytes: 68912, sha256: 'd065dc4b27691fb27fcc4c4484e32beae95e3e77d52fab4f310789caddeba9da' },
  { id: 'shelf' as const, name: '선반', english: 'Display shelf', width: 1.1, depth: .45, triangles: 756, bytes: 56524, sha256: '14eb7351a009262b36c423510c026cb76a459523f6ea50cbd62722d0f4b8f2ff' },
];
export const assetUrl = (id: AssetId) => `/examples/local-prop-kit/${id}/model.glb`;
export const defaultPlacements = (): Placement[] => [
  { id: 'crate', x: -2.5, z: -.25, rotation: 0 },
  { id: 'table', x: 0, z: -1.75, rotation: 0 },
  { id: 'shelf', x: 2.5, z: -.25, rotation: 0 },
];
export const spawn: Point = { x: 0, z: 3.4 };
export const cells: Point[] = [{ x: -3, z: 2.5 }, { x: 3, z: 2.5 }, { x: -2.5, z: -3.2 }];
export const storageKey = 'treeset.workshop.layout.v1';
const fixedObstacles = [
  { left: -1.6, right: 1.6, back: -4.57, front: -4.43 },
  ...[-4.2, 4.2].map(x => ({ left: x - .14, right: x + .14, back: -3.64, front: -3.36 })),
];
const expanded = (box: { left: number; right: number; back: number; front: number }, margin: number) => ({ left: box.left - margin, right: box.right + margin, back: box.back - margin, front: box.front + margin });
export function bounds(p: Placement, margin = 0) {
  const spec = assets.find(a => a.id === p.id)!;
  const turn = p.rotation % 180 !== 0;
  const halfX = (turn ? spec.depth : spec.width) / 2 + margin;
  const halfZ = (turn ? spec.width : spec.depth) / 2 + margin;
  return { left: p.x - halfX, right: p.x + halfX, back: p.z - halfZ, front: p.z + halfZ };
}
function contains(point: Point, box: ReturnType<typeof bounds>) {
  return point.x >= box.left && point.x <= box.right && point.z >= box.back && point.z <= box.front;
}
export function validLayout(value: unknown): value is Placement[] {
  if (!Array.isArray(value) || value.length !== 3) return false;
  if (new Set(value.map(p => p?.id)).size !== 3) return false;
  for (const p of value) {
    if (!p || !assets.some(a => a.id === p.id) || !Number.isFinite(p.x) || !Number.isFinite(p.z) || ![0, 90, 180, 270].includes(p.rotation)) return false;
    const b = bounds(p, .2);
    if (Math.min(b.left, b.back) < -4.25 || Math.max(b.right, b.front) > 4.25) return false;
    if (fixedObstacles.some(o => b.left < o.right + .2 && b.right > o.left - .2 && b.back < o.front + .2 && b.front > o.back - .2)) return false;
    if ([spawn, ...cells].some(point => contains(point, bounds(p, .65)))) return false;
    for (const other of value) {
      if (other.id === p.id) continue;
      const o = bounds(other, .2);
      if (b.left < o.right && b.right > o.left && b.back < o.front && b.front > o.back) return false;
    }
  }
  return true;
}
export function replacePlacement(layout: Placement[], id: AssetId, point: Point, rotate = false): Placement[] | null {
  const candidate = layout.map(p => p.id === id ? { ...p, x: rotate ? p.x : Math.round(point.x * 2) / 2, z: rotate ? p.z : Math.round(point.z * 2) / 2, rotation: rotate ? (p.rotation + 90) % 360 : p.rotation } : { ...p });
  return validLayout(candidate) ? candidate : null;
}
export function canStand(point: Point, layout: Placement[]) {
  return Math.abs(point.x) <= 4.45 && Math.abs(point.z) <= 4.45 && !layout.some(p => contains(point, bounds(p, .22))) && !fixedObstacles.some(box => contains(point, expanded(box, .22)));
}
export function movePlayer(point: Point, direction: Point, seconds: number, layout: Placement[]): Point {
  const length = Math.hypot(direction.x, direction.z);
  if (!length || !Number.isFinite(length) || !Number.isFinite(seconds)) return { ...point };
  const elapsed = Math.min(Math.max(seconds, 0), .15);
  if (!elapsed) return { ...point };
  const steps = Math.ceil(elapsed / (1 / 60)), step = elapsed / steps * 3.1 / length;
  const next = { ...point };
  for (let i = 0; i < steps; i++) {
    if (canStand({ x: next.x + direction.x * step, z: next.z }, layout)) next.x += direction.x * step;
    if (canStand({ x: next.x, z: next.z + direction.z * step }, layout)) next.z += direction.z * step;
  }
  return next;
}
export type Game = { player: Point; carrying: number | null; delivered: number[] };
export type Notice = 'collect' | 'carrying' | 'delivered' | 'complete' | 'closer' | 'placed' | 'blocked' | 'saved' | 'restored';
export const freshGame = (): Game => ({ player: { ...spawn }, carrying: null, delivered: [] });
export function actionReady(game: Game, layout: Placement[]) {
  if (game.delivered.length === cells.length) return false;
  if (game.carrying !== null) {
    const table = layout.find(p => p.id === 'table')!;
    return Math.hypot(game.player.x - table.x, game.player.z - table.z) <= 1.3;
  }
  return cells.some((cell, id) => !game.delivered.includes(id) && Math.hypot(game.player.x - cell.x, game.player.z - cell.z) < .85);
}
export function routeToGoal(game: Game, layout: Placement[]): Point[] {
  if (game.delivered.length === cells.length) return [];
  const goal = game.carrying !== null ? layout.find(p => p.id === 'table')! : cells.filter((_p, id) => !game.delivered.includes(id)).sort((a, b) => Math.hypot(a.x - game.player.x, a.z - game.player.z) - Math.hypot(b.x - game.player.x, b.z - game.player.z))[0];
  const walkable: Point[] = [];
  for (let x = -4; x <= 4; x += .5) for (let z = -4; z <= 4; z += .5) if (canStand({ x, z }, layout)) walkable.push({ x, z });
  const start = walkable.sort((a, b) => Math.hypot(a.x - game.player.x, a.z - game.player.z) - Math.hypot(b.x - game.player.x, b.z - game.player.z))[0];
  if (!start) return [];
  const key = (p: Point) => `${p.x},${p.z}`, points = new Map(walkable.map(p => [key(p), p]));
  const queue = [start], previous = new Map<string, string | null>([[key(start), null]]);
  let end: Point | undefined;
  for (let head = 0; head < queue.length; head++) {
    const point = queue[head];
    if (Math.hypot(point.x - goal.x, point.z - goal.z) < (game.carrying !== null ? 1.15 : .45)) { end = point; break; }
    for (const [dx, dz] of [[.5, 0], [-.5, 0], [0, .5], [0, -.5]]) {
      const next = points.get(key({ x: point.x + dx, z: point.z + dz }));
      if (next && !previous.has(key(next))) { previous.set(key(next), key(point)); queue.push(next); }
    }
  }
  if (!end) return [];
  const route: Point[] = [];
  let cursor: string | null = key(end);
  while (cursor !== null) { route.push(points.get(cursor)!); cursor = previous.get(cursor) ?? null; }
  return route.reverse();
}
export function interact(game: Game, layout: Placement[]): { game: Game; notice: Notice } {
  if (game.delivered.length === cells.length) return { game, notice: 'complete' };
  if (game.carrying !== null) {
    const table = layout.find(p => p.id === 'table')!;
    if (Math.hypot(game.player.x - table.x, game.player.z - table.z) > 1.3) return { game, notice: 'closer' };
    const delivered = [...game.delivered, game.carrying];
    return { game: { ...game, carrying: null, delivered }, notice: delivered.length === cells.length ? 'complete' : 'delivered' };
  }
  const cell = cells.findIndex((p, id) => !game.delivered.includes(id) && Math.hypot(game.player.x - p.x, game.player.z - p.z) < .85);
  return cell >= 0 ? { game: { ...game, carrying: cell }, notice: 'carrying' } : { game, notice: 'closer' };
}
export function exportScene(layout: Placement[]) {
  if (!validLayout(layout)) throw new Error('Invalid workshop layout');
  return {
    schemaVersion: 1, kind: 'treeset-workshop-scene', units: 'metres', upAxis: 'Y',
    provenance: 'Developer-made example using local procedural Blender outputs; no AI provider request.',
    source: 'https://treeset.win/about/#local-workflow',
    assets: layout.map(p => ({ ...p, source: assetUrl(p.id), sha256: assets.find(a => a.id === p.id)!.sha256 })),
  };
}
export function importScene(text: string): Placement[] {
  if (text.length > 64000) throw new Error('Scene is too large');
  const parsed = JSON.parse(text);
  if (parsed?.schemaVersion !== 1 || parsed.kind !== 'treeset-workshop-scene' || parsed.units !== 'metres' || parsed.upAxis !== 'Y' || !Array.isArray(parsed.assets)) throw new Error('Unsupported scene format');
  const layout = parsed.assets.map((p: Record<string, unknown>) => ({ id: p?.id, x: p?.x, z: p?.z, rotation: p?.rotation }));
  if (!validLayout(layout)) throw new Error('Invalid placement');
  for (const p of parsed.assets) {
    const spec = assets.find(a => a.id === p.id)!;
    if (p.source !== assetUrl(spec.id) || p.sha256 !== spec.sha256) throw new Error('Unknown asset source');
  }
  return layout;
}

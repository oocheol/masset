import { describe, expect, it } from 'vitest';
import { readFileSync } from 'node:fs';
import { createHash } from 'node:crypto';
import { actionReady, assets, canStand, cells, defaultPlacements, exportScene, freshGame, importScene, interact, movePlayer, replacePlacement, routeToGoal, validLayout } from './state';

describe('workshop behavior and artifact boundary', () => {
  it('uses actual native artifact bytes and hashes', () => {
    for (const asset of assets) {
      const bytes = readFileSync(new URL(`../../public/examples/local-prop-kit/${asset.id}/model.glb`, import.meta.url));
      expect(bytes.length).toBe(asset.bytes); expect(createHash('sha256').update(bytes).digest('hex')).toBe(asset.sha256);
    }
  });
  it('saves and reopens a changed scene with fixed provenance', () => {
    const changed = replacePlacement(defaultPlacements(), 'crate', { x: -1.5, z: .5 })!;
    expect(changed).not.toBeNull(); expect(importScene(JSON.stringify(exportScene(changed)))).toEqual(changed);
  });
  it('rejects remote assets, forged hashes and unbounded files', () => {
    for (const change of [{ source: 'https://example.com/x.glb' }, { sha256: 'a'.repeat(64) }]) {
      const scene = exportScene(defaultPlacements()); Object.assign(scene.assets[0], change);
      expect(() => importScene(JSON.stringify(scene))).toThrow();
    }
    expect(() => importScene(' '.repeat(64001))).toThrow();
  });
  it('keeps placements away from cells, spawn, overlaps and edges', () => {
    expect(validLayout(defaultPlacements())).toBe(true);
    expect(replacePlacement(defaultPlacements(), 'crate', cells[0])).toBeNull();
    expect(replacePlacement(defaultPlacements(), 'crate', { x: 0, z: 3.5 })).toBeNull();
    expect(replacePlacement(defaultPlacements(), 'crate', { x: 0, z: -1.5 })).toBeNull();
    expect(replacePlacement(defaultPlacements(), 'crate', { x: 4.5, z: 4.5 })).toBeNull();
    expect(validLayout([{ id: 'crate', x: Infinity, z: 0, rotation: 0 }, ...defaultPlacements().slice(1)])).toBe(false);
  });
  it('keeps diagonal speed equal and limits long frame gaps', () => {
    const layout = defaultPlacements(), point = { x: 0, z: 2 };
    const straight = movePlayer(point, { x: 1, z: 0 }, 1 / 60, layout);
    const diagonal = movePlayer(point, { x: 1, z: 1 }, 1 / 60, layout);
    expect(Math.hypot(diagonal.x, diagonal.z - 2)).toBeCloseTo(straight.x);
    expect(movePlayer(point, { x: 1, z: 0 }, 20, layout).x).toBeLessThan(.466);
  });
  it('does not move through the workbench', () => {
    const next = movePlayer({ x: 0, z: -1.15 }, { x: 0, z: -1 }, 1 / 30, defaultPlacements());
    expect(next.z).toBe(-1.15);
  });
  it('keeps the fixed wall and pillars solid and rotates in place', () => {
    expect(canStand({ x: 4.2, z: -3.5 }, defaultPlacements())).toBe(false);
    expect(canStand({ x: 0, z: -4.4 }, defaultPlacements())).toBe(false);
    const original = defaultPlacements()[0];
    const rotated = replacePlacement(defaultPlacements(), 'crate', original, true)![0];
    expect(rotated.x).toBe(original.x); expect(rotated.z).toBe(original.z); expect(rotated.rotation).toBe(90);
  });
  it('requires collection and delivery proximity and never counts a cell twice', () => {
    const layout = defaultPlacements(); let game = freshGame();
    expect(interact(game, layout).notice).toBe('closer');
    for (let id = 0; id < 3; id++) {
      game.player = { ...cells[id] }; game = interact(game, layout).game;
      expect(game.carrying).toBe(id);
      expect(interact(game, layout).game.delivered).toHaveLength(id);
      game.player = { x: 0, z: -.75 }; game = interact(game, layout).game;
      expect(game.delivered).toHaveLength(id + 1); expect(game.carrying).toBeNull();
      expect(interact(game, layout).game.delivered).toHaveLength(id + 1);
    }
    expect(interact(game, layout).notice).toBe('complete');
    expect(freshGame().delivered).toEqual([]);
  });
  it('guides all three pickups and deliveries through walkable points', () => {
    const layout = defaultPlacements(); let game = freshGame();
    for (let step = 0; step < 6; step++) {
      const route = routeToGoal(game, layout);
      expect(route.length).toBeGreaterThan(0);
      for (const point of route) expect(canStand(point, layout)).toBe(true);
      game.player = route[route.length - 1];
      expect(actionReady(game, layout)).toBe(true); game = interact(game, layout).game;
    }
    expect(game.delivered).toHaveLength(3); expect(routeToGoal(game, layout)).toEqual([]);
  });
});

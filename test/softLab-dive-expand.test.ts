/**
 * Soft Lab dive-in auto-expand: internals live while viewing, Soft again on leave.
 */
import { describe, expect, it } from 'vitest';
import counterLab from '../examples/lab-counter-7seg.json';
import { flatten } from '../src/sim/hierarchy.js';
import {
  armSoftLabToGatesPor,
  clearSoftExpandForced,
  clearSoftLabPor,
  clearSoftLabState,
  clearSoftModelForceExpands,
  isSoftExpandForced,
  isSoftLabEnabled,
  setSoftExpandForced,
  setSoftLabEnabled,
  softLabModelKey,
  softLabShowsBadge,
  syncSoftExpandForDivePath,
} from '../src/sim/softLab.js';
import { deserializeProject, resolveStdcellInstances } from '../src/sim/serialize.js';
import { seedStandardCells } from '../src/sim/stdcells.js';
import { initialState, step } from '../src/sim/solver.js';
import type { Component, Level } from '../src/sim/types.js';

function loadCounterLab() {
  const { topCircuit, library } = deserializeProject(
    structuredClone(counterLab) as Parameters<typeof deserializeProject>[0],
  );
  seedStandardCells(library);
  resolveStdcellInstances(topCircuit, library);
  return { circuit: topCircuit, library };
}

function pinLevel(
  netMap: { netOf: Map<string, string> },
  state: { levelOf: Map<string, Level> },
  pinId: string,
): Level {
  const net = netMap.netOf.get(pinId);
  if (!net) return 'Z';
  return state.levelOf.get(net) ?? 'Z';
}

describe('syncSoftExpandForDivePath', () => {
  it('force-expands Soft Lab defs on path and releases them on leave', () => {
    const prev = isSoftLabEnabled();
    clearSoftExpandForced();
    try {
      setSoftLabEnabled(true);
      expect(syncSoftExpandForDivePath(['BCD_7SEG'])).toEqual({
        newly: ['BCD_7SEG'],
        released: [],
      });
      expect(isSoftExpandForced('BCD_7SEG')).toBe(true);
      expect(syncSoftExpandForDivePath(['BCD_7SEG'])).toEqual({ newly: [], released: [] });
      expect(syncSoftExpandForDivePath([])).toEqual({ newly: [], released: ['BCD_7SEG'] });
      expect(isSoftExpandForced('BCD_7SEG')).toBe(false);
    } finally {
      clearSoftExpandForced();
      setSoftLabEnabled(prev);
    }
  });

  it('dive into COUNTER4 also expands nested Soft Lab T_FF', () => {
    const prev = isSoftLabEnabled();
    clearSoftExpandForced();
    try {
      setSoftLabEnabled(true);
      const { library } = loadCounterLab();
      const { newly, released } = syncSoftExpandForDivePath(['COUNTER4'], library);
      expect(newly.sort()).toEqual(['COUNTER4', 'T_FF'].sort());
      expect(released).toEqual([]);
      expect(isSoftExpandForced('COUNTER4')).toBe(true);
      expect(isSoftExpandForced('T_FF')).toBe(true);
      const leave = syncSoftExpandForDivePath([], library);
      expect(leave.released.sort()).toEqual(['COUNTER4', 'T_FF'].sort());
      expect(isSoftExpandForced('COUNTER4')).toBe(false);
      expect(isSoftExpandForced('T_FF')).toBe(false);
    } finally {
      clearSoftExpandForced();
      setSoftLabEnabled(prev);
    }
  });

  it('Soft Lab model key resolves dive forks (COUNTER4_copy)', () => {
    expect(softLabModelKey('COUNTER4_copy')).toBe('COUNTER4');
    expect(softLabModelKey('COUNTER4_copy_2')).toBe('COUNTER4');
    expect(softLabModelKey('T_FF_copy')).toBe('T_FF');
  });

  it('toggling Soft Lab on with COUNTER4 dive path expands T_FF (no grey Soft guts)', () => {
    const prev = isSoftLabEnabled();
    clearSoftExpandForced();
    try {
      const { circuit, library } = loadCounterLab();
      // Gates first (Soft off) — full expand.
      setSoftLabEnabled(false);
      const gatesNets = flatten(circuit, library).computeNets().pinsOf.size;
      expect(gatesNets).toBeGreaterThan(200);

      // Soft on without dive expand → opaque Soft (grey guts if viewing inside).
      setSoftLabEnabled(true);
      expect(flatten(circuit, library).computeNets().pinsOf.size).toBeLessThan(50);

      // Same as Soft Lab toggle while dived into COUNTER4.
      const { newly } = syncSoftExpandForDivePath(['COUNTER4'], library);
      expect(newly).toContain('T_FF');
      expect(isSoftExpandForced('T_FF')).toBe(true);
      const expanded = flatten(circuit, library).computeNets().pinsOf.size;
      expect(expanded).toBeGreaterThan(100);
    } finally {
      clearSoftExpandForced();
      setSoftLabEnabled(prev);
    }
  });

  it('softLabShowsBadge only while Soft-opaque (hidden when force-expanded)', () => {
    const prev = isSoftLabEnabled();
    clearSoftExpandForced();
    try {
      setSoftLabEnabled(true);
      expect(softLabShowsBadge('T_FF')).toBe(true);
      expect(softLabShowsBadge('NOT')).toBe(false);
      setSoftExpandForced('T_FF', true);
      expect(softLabShowsBadge('T_FF')).toBe(false);
      setSoftExpandForced('T_FF', false);
      expect(softLabShowsBadge('T_FF')).toBe(true);
      setSoftLabEnabled(false);
      expect(softLabShowsBadge('T_FF')).toBe(false);
    } finally {
      clearSoftExpandForced();
      setSoftLabEnabled(prev);
    }
  });

  it('Soft OFF while dived then Soft ON at top: Soft COUNTER drives Q (not Z)', () => {
    const prev = isSoftLabEnabled();
    clearSoftExpandForced();
    clearSoftLabPor();
    try {
      const { circuit, library } = loadCounterLab();
      setSoftLabEnabled(true);
      syncSoftExpandForDivePath(['COUNTER4'], library);
      expect(isSoftExpandForced('COUNTER4')).toBe(true);
      expect(isSoftExpandForced('T_FF')).toBe(true);

      // Soft → Gates while still dived (UI calls sync after setSoftLabEnabled).
      setSoftLabEnabled(false);
      syncSoftExpandForDivePath(['COUNTER4'], library);
      expect(isSoftExpandForced('COUNTER4')).toBe(false);
      expect(isSoftExpandForced('T_FF')).toBe(false);

      // Gates → Soft at top: Soft opaque, not stuck silicon with floating Q.
      setSoftLabEnabled(true);
      clearSoftModelForceExpands();
      clearSoftLabState(circuit);
      syncSoftExpandForDivePath([], library);
      expect(isSoftExpandForced('COUNTER4')).toBe(false);
      expect(softLabShowsBadge('COUNTER4')).toBe(true);
      expect(softLabShowsBadge('T_FF')).toBe(true);
      expect(flatten(circuit, library).computeNets().pinsOf.size).toBeLessThan(50);

      let state = initialState();
      const flat = flatten(circuit, library);
      const nets = flat.computeNets();
      for (let i = 0; i < 8; i++) state = step(flat, nets, state);
      expect(state.settled).toBe(true);
      const counter = [...circuit.components.values()].find(
        (c): c is Extract<Component, { kind: 'chip' }> =>
          c.kind === 'chip' && library.get(c.defId)?.name === 'COUNTER4',
      )!;
      // Soft opaque COUNTER drives q0=0, not Z (the Soft↔Gates freeze symptom).
      expect(pinLevel(nets, state, counter.pins.q0!.id)).toBe(0);
      expect(pinLevel(nets, state, counter.pins.q1!.id)).toBe(0);
    } finally {
      clearSoftLabPor();
      clearSoftExpandForced();
      setSoftLabEnabled(prev);
    }
  });

  it('orphan Soft-model force-expand leaves Q floating; clearSoftModelForceExpands restores Soft', () => {
    const prev = isSoftLabEnabled();
    clearSoftExpandForced();
    clearSoftLabPor();
    try {
      const { circuit, library } = loadCounterLab();
      setSoftLabEnabled(true);
      // Simulate pre-fix orphan: Soft ON + COUNTER stuck force-expanded.
      setSoftExpandForced('COUNTER4', true);
      setSoftExpandForced('T_FF', true);
      clearSoftLabState(circuit);
      {
        const flat = flatten(circuit, library);
        const nets = flat.computeNets();
        let state = initialState();
        for (let i = 0; i < 8; i++) state = step(flat, nets, state);
        const counter = [...circuit.components.values()].find(
          (c): c is Extract<Component, { kind: 'chip' }> =>
            c.kind === 'chip' && library.get(c.defId)?.name === 'COUNTER4',
        )!;
        expect(nets.pinsOf.size).toBeGreaterThan(100);
        expect(pinLevel(nets, state, counter.pins.q0!.id)).toBe('Z');
      }

      clearSoftModelForceExpands();
      expect(isSoftExpandForced('COUNTER4')).toBe(false);
      const flat = flatten(circuit, library);
      const nets = flat.computeNets();
      expect(nets.pinsOf.size).toBeLessThan(50);
      let state = initialState();
      for (let i = 0; i < 8; i++) state = step(flat, nets, state);
      const counter = [...circuit.components.values()].find(
        (c): c is Extract<Component, { kind: 'chip' }> =>
          c.kind === 'chip' && library.get(c.defId)?.name === 'COUNTER4',
      )!;
      expect(pinLevel(nets, state, counter.pins.q0!.id)).toBe(0);
    } finally {
      clearSoftLabPor();
      clearSoftExpandForced();
      setSoftLabEnabled(prev);
    }
  });

  it('dive-expand BCD_7SEG makes internal nets live under Soft Lab', () => {
    const prev = isSoftLabEnabled();
    clearSoftExpandForced();
    clearSoftLabPor();
    try {
      const { circuit, library } = loadCounterLab();
      setSoftLabEnabled(true);
      // Soft opaque first.
      {
        const flat = flatten(circuit, library);
        expect(flat.computeNets().pinsOf.size).toBeLessThan(50);
      }
      const { newly } = syncSoftExpandForDivePath(['BCD_7SEG']);
      expect(newly).toEqual(['BCD_7SEG']);
      armSoftLabToGatesPor(circuit, library, new Set(newly));
      const flat = flatten(circuit, library);
      const nets = flat.computeNets();
      // COUNTER soft + BCD expanded ≈ 200+ nets (not full 494).
      expect(nets.pinsOf.size).toBeGreaterThan(100);
      expect(nets.pinsOf.size).toBeLessThan(400);
      let state = initialState();
      for (let i = 0; i < 8; i++) state = step(flat, nets, state);
      const bcd = [...circuit.components.values()].find(
        (c): c is Extract<Component, { kind: 'chip' }> =>
          c.kind === 'chip' && library.get(c.defId)?.name === 'BCD_7SEG',
      )!;
      // Digit 0 from soft COUNTER q=0 → segment a high.
      expect(pinLevel(nets, state, bcd.pins.a!.id)).toBe(1);
      expect(pinLevel(nets, state, bcd.pins.g!.id)).toBe(0);

      syncSoftExpandForDivePath([]);
      expect(isSoftExpandForced('BCD_7SEG')).toBe(false);
      expect(flatten(circuit, library).computeNets().pinsOf.size).toBeLessThan(50);
    } finally {
      clearSoftLabPor();
      clearSoftExpandForced();
      setSoftLabEnabled(prev);
    }
  });
});

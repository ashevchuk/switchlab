/**
 * Soft Lab → Gates one-shot POR: sequential q nets leave Z without Clear.
 */
import { describe, expect, it } from 'vitest';
import counterLab from '../examples/lab-counter-7seg.json';
import { flatten } from '../src/sim/hierarchy.js';
import {
  armSoftLabToGatesPor,
  clearSoftLabPor,
  isSoftLabEnabled,
  setSoftLabEnabled,
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

describe('Soft Lab → Gates POR', () => {
  it('seeds COUNTER4 q nets to 0 after Soft→Gates with CLR already released', () => {
    const prev = isSoftLabEnabled();
    clearSoftLabPor();
    try {
      const { circuit, library } = loadCounterLab();
      const ctr = [...circuit.components.values()].find(
        (c): c is Extract<Component, { kind: 'chip' }> =>
          c.kind === 'chip' && library.get(c.defId)?.name === 'COUNTER4',
      )!;
      const clrPin = ctr.pins.clr!;
      const clrWire = [...circuit.wires.values()].find((w) => w.a === clrPin.id || w.b === clrPin.id)!;
      const clrBtnId = (clrWire.a === clrPin.id ? clrWire.b : clrWire.a).split(':')[0]!;
      const clrBtn = circuit.components.get(clrBtnId)!;
      expect(clrBtn.kind).toBe('button');
      if (clrBtn.kind === 'button') clrBtn.value = 0; // Clear off — the stuck-Z scenario

      // Soft Lab on so flatten attaches softState (as in a normal lab session).
      setSoftLabEnabled(true);
      {
        const flat = flatten(circuit, library);
        const nets = flat.computeNets();
        let state = initialState();
        for (let i = 0; i < 4; i++) state = step(flat, nets, state);
        expect(pinLevel(nets, state, ctr.pins.q0!.id)).toBe(0);
      }

      // Soft → Gates hand-off with POR.
      setSoftLabEnabled(false);
      armSoftLabToGatesPor(circuit);
      {
        const flat = flatten(circuit, library);
        const nets = flat.computeNets();
        expect(nets.pinsOf.size).toBeGreaterThan(100);
        let state = initialState();
        for (let i = 0; i < 10; i++) state = step(flat, nets, state);
        expect(pinLevel(nets, state, ctr.pins.q0!.id)).toBe(0);
        expect(pinLevel(nets, state, ctr.pins.q1!.id)).toBe(0);
        expect(pinLevel(nets, state, ctr.pins.q2!.id)).toBe(0);
        expect(pinLevel(nets, state, ctr.pins.q3!.id)).toBe(0);
        // BCD should decode digit 0 (g off, a–f on) once q is concrete.
        const bcd = [...circuit.components.values()].find(
          (c): c is Extract<Component, { kind: 'chip' }> =>
            c.kind === 'chip' && library.get(c.defId)?.name === 'BCD_7SEG',
        )!;
        expect(pinLevel(nets, state, bcd.pins.a!.id)).toBe(1);
        expect(pinLevel(nets, state, bcd.pins.g!.id)).toBe(0);
      }
    } finally {
      clearSoftLabPor();
      setSoftLabEnabled(prev);
    }
  });

  it('without POR, Soft OFF + CLR=0 leaves COUNTER4 q floating', () => {
    const prev = isSoftLabEnabled();
    clearSoftLabPor();
    try {
      const { circuit, library } = loadCounterLab();
      const ctr = [...circuit.components.values()].find(
        (c): c is Extract<Component, { kind: 'chip' }> =>
          c.kind === 'chip' && library.get(c.defId)?.name === 'COUNTER4',
      )!;
      const clrPin = ctr.pins.clr!;
      const clrWire = [...circuit.wires.values()].find((w) => w.a === clrPin.id || w.b === clrPin.id)!;
      const clrBtnId = (clrWire.a === clrPin.id ? clrWire.b : clrWire.a).split(':')[0]!;
      const clrBtn = circuit.components.get(clrBtnId)!;
      if (clrBtn.kind === 'button') clrBtn.value = 0;

      setSoftLabEnabled(true);
      flatten(circuit, library); // attach softState
      setSoftLabEnabled(false);
      // Deliberately skip armSoftLabToGatesPor — regression guard for the Z bug.
      const flat = flatten(circuit, library);
      const nets = flat.computeNets();
      let state = initialState();
      for (let i = 0; i < 10; i++) state = step(flat, nets, state);
      expect(pinLevel(nets, state, ctr.pins.q0!.id)).toBe('Z');
    } finally {
      clearSoftLabPor();
      setSoftLabEnabled(prev);
    }
  });

  it('cold load Soft Lab OFF (no softState) still seeds COUNTER4 q via library', () => {
    const prev = isSoftLabEnabled();
    clearSoftLabPor();
    try {
      const { circuit, library } = loadCounterLab();
      const ctr = [...circuit.components.values()].find(
        (c): c is Extract<Component, { kind: 'chip' }> =>
          c.kind === 'chip' && library.get(c.defId)?.name === 'COUNTER4',
      )!;
      const clrPin = ctr.pins.clr!;
      const clrWire = [...circuit.wires.values()].find((w) => w.a === clrPin.id || w.b === clrPin.id)!;
      const clrBtnId = (clrWire.a === clrPin.id ? clrWire.b : clrWire.a).split(':')[0]!;
      const clrBtn = circuit.components.get(clrBtnId)!;
      if (clrBtn.kind === 'button') clrBtn.value = 0;

      // Reload scenario: Soft Lab already off, never attached softState.
      setSoftLabEnabled(false);
      expect(ctr.softState).toBeUndefined();
      armSoftLabToGatesPor(circuit, library);

      const flat = flatten(circuit, library);
      const nets = flat.computeNets();
      let state = initialState();
      for (let i = 0; i < 10; i++) state = step(flat, nets, state);
      expect(pinLevel(nets, state, ctr.pins.q0!.id)).toBe(0);
      expect(pinLevel(nets, state, ctr.pins.q3!.id)).toBe(0);
    } finally {
      clearSoftLabPor();
      setSoftLabEnabled(prev);
    }
  });

  it('a quiet CLK during POR leaves the COUNTER settled', async () => {
    const { tickLabInstruments } = await import('../src/sim/labTick.js');
    const { softLabPorActive } = await import('../src/sim/softLab.js');
    const prev = isSoftLabEnabled();
    clearSoftLabPor();
    try {
      const { circuit, library } = loadCounterLab();
      const ctr = [...circuit.components.values()].find(
        (c): c is Extract<Component, { kind: 'chip' }> =>
          c.kind === 'chip' && library.get(c.defId)?.name === 'COUNTER4',
      )!;
      const clk = [...circuit.components.values()].find((c) => c.kind === 'clock')!;
      if (clk.kind !== 'clock') throw new Error('no clock');
      clk.running = true;
      clk.periodFrames = 2;
      clk.dutyFrames = 1;
      clk.mode = 'continuous';
      clk.value = 0;
      clk.phase = 0;

      setSoftLabEnabled(false);
      armSoftLabToGatesPor(circuit, library);

      // main.ts holds CLK quiet until POR finishes.
      let state = initialState();
      let unsettle = 0;
      for (let f = 0; f < 40; f++) {
        let flat = flatten(circuit, library);
        let nets = flat.computeNets();
        for (const c of circuit.components.values()) {
          if (c.kind !== 'button') continue;
          const n = nets.netOf.get(c.pins.out.id);
          if (n === nets.netOf.get(ctr.pins.ce!.id)) c.value = 1;
          if (n === nets.netOf.get(ctr.pins.clr!.id)) c.value = 0;
        }
        flat = flatten(circuit, library);
        nets = flat.computeNets();
        state = step(flat, nets, state);
        if (!softLabPorActive()) {
          if (tickLabInstruments(circuit, nets, state.levelOf)) {
            flat = flatten(circuit, library);
            nets = flat.computeNets();
            state = step(flat, nets, state);
          }
        }
        if (!state.settled) unsettle++;
      }
      expect(unsettle).toBe(0);
      expect(state.settled).toBe(true);
    } finally {
      clearSoftLabPor();
      setSoftLabEnabled(prev);
    }
  });
});

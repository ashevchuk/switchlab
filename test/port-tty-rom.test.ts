import { describe, expect, it } from 'vitest';
import { createSoftDevices, PORT_TTY_OUT } from '../src/machine/softDevices.js';
import {
  PORT_TTY_ROM_BYTES,
  portTtyRomHexPrompt,
  loadPortTtyRom,
} from '../src/machine/portTtyRom.js';
import { createSoftZ80, softStep, type SoftMemHooks } from '../src/machine/softZ80.js';
import { ChipLibrary } from '../src/sim/ChipLibrary.js';
import { Circuit } from '../src/sim/Circuit.js';
import { buildZ80Cpu } from '../src/sim/blocks.js';
import { flatten } from '../src/sim/hierarchy.js';
import { initialState, step } from '../src/sim/solver.js';
import { MachineRunner } from '../src/machine/MachineRunner.js';

describe('Port TTY ROM', () => {
  it('assembles with OUT to PORT_TTY_OUT', () => {
    expect(PORT_TTY_ROM_BYTES.length).toBeGreaterThan(16);
    expect(portTtyRomHexPrompt().startsWith('31,')).toBe(true);
    expect(
      [...PORT_TTY_ROM_BYTES].some(
        (b, i) => b === 0xd3 && PORT_TTY_ROM_BYTES[i + 1] === PORT_TTY_OUT,
      ),
    ).toBe(true);
  });

  it('soft OUT prints into SoftDevices VT100', () => {
    const ram = new Uint8Array(0x1000);
    loadPortTtyRom(ram);
    const devices = createSoftDevices();
    const cpu = createSoftZ80();
    const hooks: SoftMemHooks = {
      portIn: (p) => devices.portIn(ram, p),
      portOut: (p, v) => devices.portOut(ram, p, v),
    };
    for (let i = 0; i < 200 && !cpu.halted; i++) softStep(cpu, ram, hooks);
    expect(devices.consoleTouched).toBe(true);
    const text = String.fromCharCode(...devices.consoleFb.filter((b) => b !== 0));
    expect(text).toContain('Hello via OUT!');
  });

  it('Gates ioWrite rising edge feeds SoftDevices.portOut', () => {
    const library = new ChipLibrary();
    const circuit = new Circuit();
    // LD A,'X' ; OUT (01h),A ; HALT
    const prog = Uint8Array.of(0x3e, 0x58, 0xd3, PORT_TTY_OUT, 0x76);
    const cpu = buildZ80Cpu(circuit, library, 12, prog, { x: 0, y: 0 });
    let flat = flatten(circuit, library);
    let netMap = flat.computeNets();
    let state = initialState();
    const runner = new MachineRunner();
    runner.attach(
      circuit,
      library,
      cpu,
      () => {
        flat = flatten(circuit, library);
        netMap = flat.computeNets();
        state = step(flat, netMap, state);
      },
      {
        readPin: (pin) => {
          const net = netMap.netOf.get(pin.id);
          if (!net) return 'Z';
          return state.levelOf.get(net) ?? 'Z';
        },
      },
    );
    runner.boot();
    runner.setSpeed('normal');
    for (let i = 0; i < 8; i++) runner.stepInstruction();
    expect(runner.softDevices.consoleTouched).toBe(true);
    expect(runner.softDevices.consoleFb[0]).toBe(0x58);
  });
});

import { ChipLibrary } from '../sim/ChipLibrary.js';
import { Circuit } from '../sim/Circuit.js';
import { placeTinyCpu } from '../sim/foldTinyCpu.js';
import { makeBusProbe, makeButton, makeClock, makeLed, wire } from '../sim/library.js';
import type { ChipInstanceComponent } from '../sim/types.js';
import { serializeSlimStdcells, type SerializedProject } from '../sim/serialize.js';
import { seedStandardCells } from '../sim/stdcells.js';

/** LDI 1; OUT; XRI 1; OUT; JMP 0 */
export const TINY_CPU_BLINK_PROGRAM = Uint8Array.of(0x01, 0xf0, 0x81, 0xf0, 0xe0);
export const TINY_CPU_BLINK_HEX = Array.from(TINY_CPU_BLINK_PROGRAM, (b) => b.toString(16).padStart(2, '0')).join(',');
const RAM_ADDR_BITS = 4;
const CLOCK_PERIOD_FRAMES = 8;

/** Pulse generator, RESET toggle (held until released) and an OUT0 LED + OUT bus probe around a placed Tiny CPU. */
export function addBlinkBench(circuit: Circuit, chip: ChipInstanceComponent): void {
  const { x, y } = chip.pos;
  const clk = makeClock(circuit, { x: x - 340, y });
  clk.running = true;
  clk.periodFrames = CLOCK_PERIOD_FRAMES;
  clk.dutyFrames = CLOCK_PERIOD_FRAMES / 2;
  const reset = makeButton(circuit, { x: x - 340, y: y + 120 }, 'toggle');
  reset.value = 1;
  wire(circuit, clk.pins.out, chip.pins.CLK!);
  wire(circuit, reset.pins.out, chip.pins.RESET!);

  const led = makeLed(circuit, { x: x + 100, y: y - 500 }, 'OUT0');
  wire(circuit, chip.pins.OUT0!, led.pins.in);
  const probe = makeBusProbe(circuit, 8, { x: x + 200, y: y - 500 });
  for (let i = 0; i < 8; i++) wire(circuit, chip.pins[`OUT${i}`]!, probe.pins[`b${i}`]!);
}

/**
 * Built on demand instead of shipped as JSON: the folded CPU serializes to
 * ~1.8 MB, far more than every other bundled example.
 */
export function buildTinyCpuBlinkProject(): SerializedProject {
  const library = new ChipLibrary();
  seedStandardCells(library);
  const circuit = new Circuit();
  const { chip } = placeTinyCpu(circuit, library, RAM_ADDR_BITS, TINY_CPU_BLINK_PROGRAM, { x: 400, y: 200 });
  addBlinkBench(circuit, chip);

  return serializeSlimStdcells(circuit, library);
}

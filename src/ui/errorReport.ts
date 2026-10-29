/** Where an error was caught; decides which advice follows the message. */
export type ErrorSource = 'frame' | 'machine' | 'script' | 'promise';

export interface ErrorReport {
  title: string;
  message: string;
  hint: string;
  /** Same key = same problem: repeats are counted instead of stacked. */
  key: string;
}

const MAX_MESSAGE_LENGTH = 300;

const TITLES: Record<ErrorSource, string> = {
  frame: 'The editor hit an error',
  machine: 'The machine stopped',
  script: 'Unexpected error',
  promise: 'Unexpected error',
};

const GENERIC_HINT =
  'Your session is autosaved. Undo the last edit with Ctrl+Z, or reload the page if the problem repeats.';

function errorName(err: unknown): string {
  return err instanceof Error ? err.name : '';
}

function errorText(err: unknown): string {
  if (err instanceof Error) return err.message || err.name;
  return typeof err === 'string' ? err : String(err);
}

function hintFor(err: unknown, source: ErrorSource): string {
  const name = errorName(err);
  const text = errorText(err);
  if (name === 'QuotaExceededError') {
    return 'Browser storage is full. Use File → Export project to keep your work, then clear this site\'s data.';
  }
  if (/call stack/i.test(text)) {
    return 'The circuit nests too deeply. Undo the last edit (Ctrl+Z) or unfold the innermost chip.';
  }
  if (/invalid array length|allocation failed|out of memory/i.test(text)) {
    return 'The circuit or memory is too large for this browser tab. Use fewer address bits or a smaller circuit.';
  }
  if (source === 'machine') {
    return 'The circuit is untouched. Press Reboot to start the machine again; if it stops at once, load a different program or switch to Soft speed.';
  }
  return GENERIC_HINT;
}

/** Turn anything that was thrown into a message and, where one is known, a way out. */
export function describeError(err: unknown, source: ErrorSource): ErrorReport {
  const message = errorText(err).slice(0, MAX_MESSAGE_LENGTH);
  return {
    title: TITLES[source],
    message,
    hint: hintFor(err, source),
    key: `${source}:${errorName(err)}:${message}`,
  };
}

/** The advice after the Spectrum emulator Worker stopped answering. */
export function describeWorkerRecovery(outcome: 'restarted' | 'stopped'): ErrorReport {
  if (outcome === 'restarted') {
    return {
      title: 'Spectrum emulator restarted',
      message: 'The emulation stopped responding for 3 seconds, so it was restarted.',
      hint: 'The program in memory was lost: load your snapshot, tape or demo again. If this repeats, lower Spec× to 1× and note which program caused it.',
      key: 'worker:restarted',
    };
  }
  return {
    title: 'Spectrum emulator stopped',
    message: 'The emulation stopped responding again soon after a restart.',
    hint: 'Reload the page (the circuit is autosaved) and avoid the program that caused it.',
    key: 'worker:stopped',
  };
}

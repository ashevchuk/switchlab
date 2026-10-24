/**
 * Lightweight Spectrum soft-session hint for page reload.
 * Full MMU banks / tape position are not serialized — only model + last demo
 * so soft reattach can boot the right ROM and optionally reload a bundled demo.
 */

import type { SpectrumModel } from './spectrum/mmu.js';

const KEY = 'switchlab.spectrumSession.v1';

export interface SpectrumSessionHint {
  model: SpectrumModel;
  /** Bundled demo id when last load was from Demo dropdown; null for file loads. */
  demoId: string | null;
  updatedAt: number;
}

export function loadSpectrumSession(): SpectrumSessionHint | null {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return null;
    const parsed = JSON.parse(raw) as Partial<SpectrumSessionHint>;
    if (parsed.model !== '48' && parsed.model !== '128') return null;
    return {
      model: parsed.model,
      demoId: typeof parsed.demoId === 'string' ? parsed.demoId : null,
      updatedAt: typeof parsed.updatedAt === 'number' ? parsed.updatedAt : 0,
    };
  } catch {
    return null;
  }
}

export function saveSpectrumSession(hint: {
  model: SpectrumModel;
  demoId?: string | null;
}): void {
  try {
    const prev = loadSpectrumSession();
    const next: SpectrumSessionHint = {
      model: hint.model,
      demoId: hint.demoId !== undefined ? hint.demoId : (prev?.demoId ?? null),
      updatedAt: Date.now(),
    };
    localStorage.setItem(KEY, JSON.stringify(next));
  } catch {
    /* ignore quota / private mode */
  }
}

export function clearSpectrumSessionDemo(): void {
  const prev = loadSpectrumSession();
  if (!prev) return;
  saveSpectrumSession({ model: prev.model, demoId: null });
}

export function clearSpectrumSession(): void {
  try {
    localStorage.removeItem(KEY);
  } catch {
    /* ignore */
  }
}

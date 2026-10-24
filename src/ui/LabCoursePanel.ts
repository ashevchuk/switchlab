/**
 * Persistent Lab course checklist panel (checkboxes, Next/Prev — no modal).
 */

import { FloatingWindow } from './FloatingWindow.js';
import {
  LAB_CURRICULUM,
  labCurriculumStep,
  type LabCurriculumStep,
} from './LabCurriculum.js';

const STORAGE_KEY = 'switchlab.labCourseChecks.v1';

function loadChecks(): Record<string, boolean[]> {
  try {
    const raw = sessionStorage.getItem(STORAGE_KEY);
    if (!raw) return {};
    const parsed = JSON.parse(raw) as Record<string, boolean[]>;
    return parsed && typeof parsed === 'object' ? parsed : {};
  } catch {
    return {};
  }
}

function saveChecks(map: Record<string, boolean[]>): void {
  try {
    sessionStorage.setItem(STORAGE_KEY, JSON.stringify(map));
  } catch {
    /* quota */
  }
}

export class LabCoursePanel {
  readonly win = new FloatingWindow('Lab course');
  private body: HTMLElement;
  private index = 0;
  private checks = loadChecks();
  onNavigate: ((index: number) => void) | null = null;

  constructor() {
    this.win.setTitle('Lab course', '');
    this.body = document.createElement('div');
    this.body.className = 'lab-course-panel';
    this.body.style.cssText =
      'padding:10px 12px 12px;overflow:auto;display:flex;flex-direction:column;gap:8px;min-height:120px';
    this.win.body.appendChild(this.body);
    this.win.setVisible(false);
    this.injectStyles();
  }

  private injectStyles(): void {
    if (document.getElementById('lab-course-panel-css')) return;
    const style = document.createElement('style');
    style.id = 'lab-course-panel-css';
    style.textContent = `
      .lab-course-panel .lab-course-head {
        font: 600 13px ui-monospace, monospace;
        color: var(--accent, #f5c518);
      }
      .lab-course-panel .lab-course-blurb {
        font: 12px/1.4 ui-sans-serif, system-ui, sans-serif;
        color: #9aa3b5;
        margin: 0;
      }
      .lab-course-panel .lab-course-progress {
        font: 11px ui-monospace, monospace;
        color: #6a7388;
      }
      .lab-course-panel .lab-course-list {
        list-style: none;
        margin: 0;
        padding: 0;
        display: flex;
        flex-direction: column;
        gap: 6px;
      }
      .lab-course-panel .lab-course-list label {
        display: flex;
        gap: 8px;
        align-items: flex-start;
        cursor: pointer;
        font: 12px/1.35 ui-sans-serif, system-ui, sans-serif;
        color: #e7e9ef;
      }
      .lab-course-panel .lab-course-list input {
        margin-top: 2px;
        flex: 0 0 auto;
      }
      .lab-course-panel .lab-course-list label.is-done span {
        color: #7a8499;
        text-decoration: line-through;
      }
      .lab-course-panel .lab-course-nav {
        display: flex;
        flex-wrap: wrap;
        gap: 6px;
        margin-top: 4px;
      }
      .lab-course-panel .lab-course-nav button {
        font: 600 11px ui-monospace, monospace;
        padding: 4px 8px;
        border-radius: 4px;
        border: 1px solid #2e3648;
        background: #1c2230;
        color: #e7e9ef;
        cursor: pointer;
      }
      .lab-course-panel .lab-course-nav button:hover:not(:disabled) {
        border-color: var(--accent, #f5c518);
        color: var(--accent, #f5c518);
      }
      .lab-course-panel .lab-course-nav button:disabled {
        opacity: 0.4;
        cursor: default;
      }
    `;
    document.head.appendChild(style);
  }

  showStep(index: number): void {
    const step = labCurriculumStep(index);
    if (!step) return;
    this.index = index;
    this.render(step);
    this.win.setTitle('Lab course', `${index + 1}/${LAB_CURRICULUM.length}`);
    this.win.setVisible(true);
  }

  private ensuredChecks(step: LabCurriculumStep): boolean[] {
    const items = step.checklist ?? [];
    let arr = this.checks[step.id];
    if (!arr || arr.length !== items.length) {
      arr = items.map(() => false);
      this.checks[step.id] = arr;
      saveChecks(this.checks);
    }
    return arr;
  }

  private render(step: LabCurriculumStep): void {
    const items = step.checklist ?? [];
    const arr = this.ensuredChecks(step);
    const done = arr.filter(Boolean).length;
    const prev = labCurriculumStep(this.index - 1);
    const next = labCurriculumStep(this.index + 1);

    this.body.innerHTML = '';
    const head = document.createElement('div');
    head.className = 'lab-course-head';
    head.textContent = step.title;
    this.body.appendChild(head);

    const blurb = document.createElement('p');
    blurb.className = 'lab-course-blurb';
    blurb.textContent = step.blurb;
    this.body.appendChild(blurb);

    const progress = document.createElement('div');
    progress.className = 'lab-course-progress';
    progress.textContent =
      items.length > 0
        ? `Checklist ${done}/${items.length} · step ${this.index + 1}/${LAB_CURRICULUM.length}`
        : `No checklist · step ${this.index + 1}/${LAB_CURRICULUM.length}`;
    this.body.appendChild(progress);

    if (items.length) {
      const ul = document.createElement('ul');
      ul.className = 'lab-course-list';
      items.forEach((text, i) => {
        const li = document.createElement('li');
        const label = document.createElement('label');
        if (arr[i]) label.classList.add('is-done');
        const cb = document.createElement('input');
        cb.type = 'checkbox';
        cb.checked = !!arr[i];
        cb.addEventListener('change', () => {
          arr[i] = cb.checked;
          this.checks[step.id] = arr;
          saveChecks(this.checks);
          label.classList.toggle('is-done', cb.checked);
          const d = arr.filter(Boolean).length;
          progress.textContent = `Checklist ${d}/${items.length} · step ${this.index + 1}/${LAB_CURRICULUM.length}`;
        });
        const span = document.createElement('span');
        span.textContent = text;
        label.appendChild(cb);
        label.appendChild(span);
        li.appendChild(label);
        ul.appendChild(li);
      });
      this.body.appendChild(ul);
    }

    const nav = document.createElement('div');
    nav.className = 'lab-course-nav';
    const mk = (label: string, disabled: boolean, go: () => void) => {
      const b = document.createElement('button');
      b.type = 'button';
      b.textContent = label;
      b.disabled = disabled;
      b.addEventListener('click', go);
      nav.appendChild(b);
    };
    mk(prev ? `← ${prev.title}` : '← Prev', !prev, () => this.onNavigate?.(this.index - 1));
    mk(next ? `Next: ${next.title} →` : 'Next →', !next, () => this.onNavigate?.(this.index + 1));
    mk('Hide', false, () => this.win.setVisible(false));
    this.body.appendChild(nav);
  }
}

import type { ErrorReport } from './errorReport.js';

/** Errors stay until dismissed: unlike a status-line notice they cannot be missed. */
const MAX_VISIBLE = 4;

let host: HTMLElement | null = null;
const visible = new Map<string, { el: HTMLElement; count: number }>();

function ensureHost(): HTMLElement {
  if (host) return host;
  const style = document.createElement('style');
  style.textContent = `
    .app-toasts {
      position: fixed;
      right: 16px;
      bottom: 44px;
      display: flex;
      flex-direction: column;
      gap: 8px;
      width: min(420px, calc(100vw - 32px));
      z-index: 9000;
      font: 13px/1.45 -apple-system, BlinkMacSystemFont, 'Segoe UI', system-ui, sans-serif;
    }
    .app-toast {
      background: var(--panel, #14161d);
      border: 1px solid var(--border, #262b36);
      border-left: 4px solid #e5534b;
      border-radius: 8px;
      padding: 10px 12px;
      color: var(--text, #e7e9ef);
      box-shadow: 0 8px 24px rgba(0, 0, 0, 0.45);
    }
    .app-toast-head { display: flex; align-items: baseline; gap: 8px; }
    .app-toast-title { font-weight: 600; flex: 1; }
    .app-toast-count { color: #e5534b; font-variant-numeric: tabular-nums; }
    .app-toast-close {
      background: none;
      border: 0;
      color: var(--text-dim, #9aa1b3);
      cursor: pointer;
      font: inherit;
      padding: 0 2px;
    }
    .app-toast-message {
      margin: 6px 0 0;
      font: 12px ui-monospace, 'SF Mono', monospace;
      color: var(--text-dim, #9aa1b3);
      white-space: pre-wrap;
      word-break: break-word;
    }
    .app-toast-hint { margin: 6px 0 0; }
  `;
  document.head.appendChild(style);
  host = document.createElement('div');
  host.className = 'app-toasts';
  host.setAttribute('role', 'alert');
  document.body.appendChild(host);
  return host;
}

function dismiss(key: string): void {
  visible.get(key)?.el.remove();
  visible.delete(key);
}

/** Show an error toast; the same error again only bumps its counter. */
export function showErrorToast(report: ErrorReport): void {
  const known = visible.get(report.key);
  if (known) {
    known.count++;
    known.el.querySelector('.app-toast-count')!.textContent = `×${known.count}`;
    return;
  }
  const root = ensureHost();
  while (visible.size >= MAX_VISIBLE) dismiss(visible.keys().next().value!);

  const el = document.createElement('div');
  el.className = 'app-toast';
  el.dataset.errorKey = report.key;
  const head = document.createElement('div');
  head.className = 'app-toast-head';
  const title = document.createElement('span');
  title.className = 'app-toast-title';
  title.textContent = report.title;
  const count = document.createElement('span');
  count.className = 'app-toast-count';
  const close = document.createElement('button');
  close.type = 'button';
  close.className = 'app-toast-close';
  close.title = 'Dismiss';
  close.textContent = '✕';
  close.addEventListener('click', () => dismiss(report.key));
  head.append(title, count, close);
  const message = document.createElement('p');
  message.className = 'app-toast-message';
  message.textContent = report.message;
  const hint = document.createElement('p');
  hint.className = 'app-toast-hint';
  hint.textContent = report.hint;
  el.append(head, message, hint);
  root.appendChild(el);
  visible.set(report.key, { el, count: 1 });
}

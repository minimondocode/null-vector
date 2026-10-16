/** Tiny DOM + formatting helpers shared by UI modules. */

export function h<K extends keyof HTMLElementTagNameMap>(tag: K, cls?: string, html?: string): HTMLElementTagNameMap[K] {
  const el = document.createElement(tag);
  if (cls) el.className = cls;
  if (html !== undefined) el.innerHTML = html;
  return el;
}

export function q<T extends HTMLElement = HTMLElement>(root: ParentNode, sel: string): T {
  return root.querySelector(sel) as T;
}

const ESC: Record<string, string> = { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' };
export function esc(s: string): string {
  return String(s).replace(/[&<>"']/g, (c) => ESC[c]);
}

export function fmtInt(n: number): string {
  return Math.round(n).toLocaleString('en-US');
}

export function fmtTime(sec: number): string {
  const s = Math.max(0, Math.floor(sec));
  const m = Math.floor(s / 60);
  return `${String(m).padStart(2, '0')}:${String(s % 60).padStart(2, '0')}`;
}

export function hexCss(n: number): string {
  return '#' + (n & 0xffffff).toString(16).padStart(6, '0');
}

/** "r g b" triplet for `rgb(var(--x-rgb) / a)` usage. */
export function hexRgb(n: number): string {
  return `${(n >> 16) & 255} ${(n >> 8) & 255} ${n & 255}`;
}

export function clamp01(v: number) {
  return v < 0 ? 0 : v > 1 ? 1 : v;
}

/**
 * Restart a CSS animation driven by `cls`. Keyframes named `rt-*` (with fill-mode both) are restarted
 * through the Web Animations API to avoid forcing a layout; otherwise falls back to a class toggle + reflow.
 */
export function retrigger(el: HTMLElement, cls: string, names?: string[]) {
  if (!el.classList.contains(cls)) {
    el.classList.add(cls);
    return;
  }
  let restarted = false;
  for (const a of el.getAnimations({ subtree: true })) {
    const name = (a as CSSAnimation).animationName;
    if (name && (names ? names.includes(name) : name.startsWith('rt-'))) {
      a.cancel();
      a.play();
      restarted = true;
    }
  }
  if (restarted) return;
  el.classList.remove(cls);
  void el.offsetWidth;
  el.classList.add(cls);
}

export async function copyText(text: string): Promise<boolean> {
  try {
    await navigator.clipboard.writeText(text);
    return true;
  } catch {
    try {
      const ta = h('textarea');
      ta.value = text;
      ta.style.cssText = 'position:fixed;opacity:0;pointer-events:none';
      document.body.appendChild(ta);
      ta.select();
      const ok = document.execCommand('copy');
      ta.remove();
      return ok;
    } catch {
      return false;
    }
  }
}

const GLYPHS = '█▓▒░<>/\\|#$%&@01ΞΣ';
export function randGlyph() {
  return GLYPHS[(Math.random() * GLYPHS.length) | 0];
}

/** Decode effect: settled prefix + a few scrambled glyphs at the head. p in 0..1. */
export function scramble(text: string, p: number, head = 4): string {
  if (p >= 1) return text;
  const n = Math.floor(text.length * p);
  let out = text.slice(0, n);
  for (let i = n; i < Math.min(text.length, n + head); i++) out += text[i] === ' ' ? ' ' : randGlyph();
  return out;
}

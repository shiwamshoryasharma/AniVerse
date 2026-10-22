/**
 * Parser for the comment Markdown produced by app/core/commentText.ts (and the
 * near-identical Markdown people type). Produces a small tree that the
 * RichText component renders with plain React elements — never raw HTML.
 */

export type Inline =
  | { t: 'text'; v: string }
  | { t: 'br' }
  | { t: 'b' | 'i' | 's' | 'spoiler'; c: Inline[] }
  | { t: 'code'; v: string }
  | { t: 'link'; href: string; c: Inline[] }
  | { t: 'img'; src: string; href?: string };

export type Block = { t: 'p'; c: Inline[] } | { t: 'h'; c: Inline[] } | { t: 'quote'; c: Block[] } | { t: 'list'; items: Inline[][] };

const URL_RE = /^https?:\/\/[^\s<>"]+$/i;
const TOKENS: [string, RegExp][] = [
  ['spoiler', /~!([\s\S]+?)!~/],
  // an image that links somewhere else: [![image](src)](href)
  ['linkimg', /\[!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)\]\((https?:\/\/[^\s)]+)\)/],
  ['img', /!\[[^\]]*\]\((https?:\/\/[^\s)]+)\)/],
  ['link', /\[([^\]]+)\]\((https?:\/\/[^\s)]+)\)/],
  ['b', /\*\*([\s\S]+?)\*\*|__([\s\S]+?)__/],
  ['s', /~~([\s\S]+?)~~/],
  ['code', /`([^`\n]+)`/],
  ['i', /(?<![\w*])\*(?![\s*])([^*\n]+?)\*(?![\w*])|(?<![\w_])_(?![\s_])([^_\n]+?)_(?![\w_])/],
  ['url', /https?:\/\/[^\s<>"()]*[^\s<>"().,!?;:'’]/],
];

export function parseInline(src: string): Inline[] {
  const out: Inline[] = [];
  let rest = src;
  while (rest) {
    let best: { kind: string; m: RegExpExecArray } | null = null;
    for (const [kind, re] of TOKENS) {
      const m = re.exec(rest);
      if (m && (!best || m.index < best.m.index)) best = { kind, m };
    }
    if (!best) {
      pushText(out, rest);
      break;
    }
    const { kind, m } = best;
    if (m.index) pushText(out, rest.slice(0, m.index));
    const inner = m[1] ?? m[2] ?? '';
    if (kind === 'linkimg') out.push({ t: 'img', src: m[1], href: m[2] });
    else if (kind === 'img') out.push({ t: 'img', src: m[1] });
    else if (kind === 'link') out.push({ t: 'link', href: m[2], c: parseInline(m[1]) });
    else if (kind === 'url') out.push({ t: 'link', href: m[0], c: [{ t: 'text', v: m[0] }] });
    else if (kind === 'code') out.push({ t: 'code', v: inner });
    else out.push({ t: kind as 'b' | 'i' | 's' | 'spoiler', c: parseInline(inner) });
    rest = rest.slice(m.index + m[0].length);
  }
  return out;
}

function pushText(out: Inline[], text: string) {
  text.split('\n').forEach((part, i) => {
    if (i) out.push({ t: 'br' });
    if (part) out.push({ t: 'text', v: part });
  });
}

export function parseBlocks(src: string): Block[] {
  const blocks: Block[] = [];
  const lines = src.replace(/\r/g, '').split('\n');
  let para: string[] = [];
  const flush = () => {
    if (para.length) blocks.push({ t: 'p', c: parseInline(para.join('\n')) });
    para = [];
  };
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (/^\s*>/.test(line)) {
      flush();
      const quoted: string[] = [];
      while (i < lines.length && /^\s*>/.test(lines[i])) quoted.push(lines[i++].replace(/^\s*>\s?/, ''));
      i--;
      blocks.push({ t: 'quote', c: parseBlocks(quoted.join('\n')) });
    } else if (/^\s*[-*•]\s+/.test(line)) {
      flush();
      const items: Inline[][] = [];
      while (i < lines.length && /^\s*[-*•]\s+/.test(lines[i])) items.push(parseInline(lines[i++].replace(/^\s*[-*•]\s+/, '')));
      i--;
      blocks.push({ t: 'list', items });
    } else if (/^#{1,6}\s+/.test(line)) {
      flush();
      blocks.push({ t: 'h', c: parseInline(line.replace(/^#{1,6}\s+/, '')) });
    } else if (!line.trim()) {
      flush();
    } else {
      para.push(line);
    }
  }
  flush();
  return blocks;
}

export const isSafeUrl = (u: string) => URL_RE.test(u);

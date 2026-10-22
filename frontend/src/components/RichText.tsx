import { useState, type ReactNode } from 'react';
import { call } from '../lib/bridge';
import { isSafeUrl, parseBlocks, type Block, type Inline } from '../lib/richText';

/** Renders comment Markdown (bold, italic, links, images, quotes, lists, spoilers) safely. */
export function RichText({ source }: { source: string }) {
  return <div className="rich">{parseBlocks(source).map((b, i) => renderBlock(b, i))}</div>;
}

function renderBlock(b: Block, key: number): ReactNode {
  switch (b.t) {
    case 'p':
      return <p key={key}>{renderInline(b.c)}</p>;
    case 'h':
      return (
        <p key={key} className="rich-h">
          {renderInline(b.c)}
        </p>
      );
    case 'quote':
      return <blockquote key={key}>{b.c.map((c, i) => renderBlock(c, i))}</blockquote>;
    case 'list':
      return (
        <ul key={key}>
          {b.items.map((item, i) => (
            <li key={i}>{renderInline(item)}</li>
          ))}
        </ul>
      );
  }
}

const open = (url: string) => {
  if (isSafeUrl(url)) void call('app.openExternal', { url });
};

function renderInline(nodes: Inline[]): ReactNode[] {
  return nodes.map((n, i) => {
    switch (n.t) {
      case 'text':
        return n.v;
      case 'br':
        return <br key={i} />;
      case 'b':
        return <strong key={i}>{renderInline(n.c)}</strong>;
      case 'i':
        return <em key={i}>{renderInline(n.c)}</em>;
      case 's':
        return <s key={i}>{renderInline(n.c)}</s>;
      case 'code':
        return <code key={i}>{n.v}</code>;
      case 'spoiler':
        return <Spoiler key={i}>{renderInline(n.c)}</Spoiler>;
      case 'link':
        return (
          <a
            key={i}
            href={n.href}
            title={n.href}
            onClick={(e) => {
              e.preventDefault();
              open(n.href);
            }}
          >
            {renderInline(n.c)}
          </a>
        );
      case 'img':
        return (
          <a
            key={i}
            href={n.href ?? n.src}
            title={n.href}
            className="rich-img"
            onClick={(e) => {
              e.preventDefault();
              open(n.href ?? n.src);
            }}
          >
            <img src={n.src} alt="" loading="lazy" referrerPolicy="no-referrer" />
          </a>
        );
    }
  });
}

function Spoiler({ children }: { children: ReactNode }) {
  const [shown, setShown] = useState(false);
  return shown ? (
    <span className="rich-spoiler shown">{children}</span>
  ) : (
    <button type="button" className="rich-spoiler" onClick={() => setShown(true)} title="Show spoiler">
      Spoiler — click to show
    </button>
  );
}

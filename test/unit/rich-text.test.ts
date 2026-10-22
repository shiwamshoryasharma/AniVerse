import { describe, expect, it } from 'vitest';
import { bbcodeToMarkdown } from '../../app/core/commentText';
import { parseBlocks, parseInline } from '../../frontend/src/lib/richText';

describe('comment rich text', () => {
  it('turns a MyAnimeList post into paragraphs and line breaks (no raw <br /> or entities)', () => {
    const md = bbcodeToMarkdown('So are there 4 people? Idk if I&#039;m right. <br />\r\n<br />\r\nAt least the cute Saikawa will be back!');
    expect(parseBlocks(md)).toEqual([
      { t: 'p', c: [{ t: 'text', v: "So are there 4 people? Idk if I'm right." }] },
      { t: 'p', c: [{ t: 'text', v: 'At least the cute Saikawa will be back!' }] },
    ]);
  });

  it('parses emphasis, links, images, code and spoilers', () => {
    expect(parseInline('**big** _small_ ~~gone~~ `x` [site](https://a.io) ~!he lives!~ ![image](https://a.io/i.png)')).toEqual([
      { t: 'b', c: [{ t: 'text', v: 'big' }] },
      { t: 'text', v: ' ' },
      { t: 'i', c: [{ t: 'text', v: 'small' }] },
      { t: 'text', v: ' ' },
      { t: 's', c: [{ t: 'text', v: 'gone' }] },
      { t: 'text', v: ' ' },
      { t: 'code', v: 'x' },
      { t: 'text', v: ' ' },
      { t: 'link', href: 'https://a.io', c: [{ t: 'text', v: 'site' }] },
      { t: 'text', v: ' ' },
      { t: 'spoiler', c: [{ t: 'text', v: 'he lives' }] },
      { t: 'text', v: ' ' },
      { t: 'img', src: 'https://a.io/i.png' },
    ]);
  });

  it('leaves snake_case words, trailing punctuation and non-http links alone', () => {
    expect(parseInline('my_var_name')).toEqual([{ t: 'text', v: 'my_var_name' }]);
    expect(parseInline('see https://a.io/x.')).toEqual([{ t: 'text', v: 'see ' }, { t: 'link', href: 'https://a.io/x', c: [{ t: 'text', v: 'https://a.io/x' }] }, { t: 'text', v: '.' }]);
    expect(parseInline('[bad](javascript:alert(1))')).toEqual([{ t: 'text', v: '[bad](javascript:alert(1))' }]);
  });

  it('decodes the typographic entities MyAnimeList posts use', () => {
    const md = bbcodeToMarkdown('He&rsquo;s &ldquo;fine&rdquo; &mdash; caf&eacute; &amp; more&hellip; I&#039;m &Uuml;ber &bogus;');
    expect(md).toBe('He’s “fine” — café & more… I\'m Über &bogus;');
  });

  it('keeps images that link to an album as clickable images', () => {
    const md = bbcodeToMarkdown('look<br />\n[url=https://imgchest.com/p/ne7bnkelv75][img]https://cdn.imgchest.com/files/bf4282e45cd5.png[/img][/url]<br />\n[img width=400]https://cdn.imgchest.com/files/3ff6aed25137.jpg[/img]');
    expect(parseBlocks(md)).toEqual([
      {
        t: 'p',
        c: [
          { t: 'text', v: 'look' },
          { t: 'br' },
          { t: 'img', src: 'https://cdn.imgchest.com/files/bf4282e45cd5.png', href: 'https://imgchest.com/p/ne7bnkelv75' },
          { t: 'br' },
          { t: 'img', src: 'https://cdn.imgchest.com/files/3ff6aed25137.jpg' },
        ],
      },
    ]);
  });

  it('groups quotes and lists', () => {
    expect(parseBlocks('> **Ann** wrote:\n> first\nreply\n- a\n- b')).toEqual([
      { t: 'quote', c: [{ t: 'p', c: [{ t: 'b', c: [{ t: 'text', v: 'Ann' }] }, { t: 'text', v: ' wrote:' }, { t: 'br' }, { t: 'text', v: 'first' }] }] },
      { t: 'p', c: [{ t: 'text', v: 'reply' }] },
      { t: 'list', items: [[{ t: 'text', v: 'a' }], [{ t: 'text', v: 'b' }]] },
    ]);
  });
});

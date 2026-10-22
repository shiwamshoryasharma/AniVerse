import { decodeEntities } from './util';

/**
 * Every comment source is normalised to one small Markdown dialect that the
 * renderer understands (frontend/src/lib/richText.ts):
 *   **bold**  _italic_  ~~strike~~  `code`  [text](https://…)  ![image](https://…)
 *   ~!spoiler!~  "> quote" lines  "- item" lines  "# heading" lines  blank line = paragraph
 * Raw HTML never survives: tags are converted or dropped, entities decoded.
 */

const safeUrl = (url: string) => (/^https?:\/\//i.test(url.trim()) ? url.trim().replace(/[()\s]/g, encodeURIComponent) : null);
const link = (text: string, url: string) => {
  const u = safeUrl(decodeEntities(url));
  return u ? `[${text.trim() || u}](${u})` : text;
};
const image = (url: string) => {
  const u = safeUrl(decodeEntities(url));
  return u ? `![image](${u})` : '';
};
const quote = (body: string, who?: string) =>
  `\n${[who ? `**${who.trim()}** wrote:` : null, ...body.trim().split('\n')]
    .filter((l): l is string => l !== null)
    .map((l) => `> ${l}`)
    .join('\n')}\n`;

/** HTML fragments (YouTube, AniList, stray tags in MAL posts) → comment Markdown. */
export function htmlToMarkdown(html: string): string {
  let s = html.replace(/\r/g, '');
  s = s
    // a <br /> is the line break; the newline the source put after it is not a second one
    .replace(/<br\s*\/?>\n?/gi, '\n')
    // …also when the source escaped it once more (&lt;br /&gt;)
    .replace(/&lt;br\s*\/?&gt;\n?/gi, '\n')
    .replace(/<\/?(p|div)[^>]*>/gi, '\n')
    .replace(/<(b|strong)>([\s\S]*?)<\/\1>/gi, '**$2**')
    .replace(/<(i|em)>([\s\S]*?)<\/\1>/gi, '_$2_')
    .replace(/<(s|del|strike)>([\s\S]*?)<\/\1>/gi, '~~$2~~')
    .replace(/<code>([\s\S]*?)<\/code>/gi, '`$1`')
    .replace(/<a\s[^>]*href=["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi, (_m, href: string, text: string) => link(text.replace(/<[^>]+>/g, ''), href))
    .replace(/<img\s[^>]*src=["']([^"']+)["'][^>]*>/gi, (_m, src: string) => image(src))
    .replace(/<blockquote[^>]*>([\s\S]*?)<\/blockquote>/gi, (_m, body: string) => quote(body))
    .replace(/<span class=["']?spoiler[^>]*>([\s\S]*?)<\/span>/gi, '~!$1!~')
    .replace(/<\/?[a-z][^>]*>/gi, '');
  return tidy(decodeEntities(s));
}

/** MyAnimeList forum posts: BBCode with HTML line breaks and entities. */
export function bbcodeToMarkdown(text: string): string {
  let s = text.replace(/\r/g, '').replace(/<br\s*\/?>\n?/gi, '\n');
  // Innermost quotes first so nested quotes keep their structure.
  for (let i = 0; i < 5 && /\[quote/i.test(s); i++) {
    s = s.replace(/\[quote(?:=([^\]]+))?\]((?:(?!\[quote)[\s\S])*?)\[\/quote\]/gi, (_m, who: string | undefined, body: string) => quote(body, who?.replace(/\s*message=\d+$/i, '')));
  }
  s = s
    .replace(/\[b\]([\s\S]*?)\[\/b\]/gi, '**$1**')
    .replace(/\[i\]([\s\S]*?)\[\/i\]/gi, '_$1_')
    .replace(/\[s\]([\s\S]*?)\[\/s\]/gi, '~~$1~~')
    .replace(/\[spoiler(?:=[^\]]*)?\]([\s\S]*?)\[\/spoiler\]/gi, '~!$1!~')
    .replace(/\[url=([^\]]+)\]([\s\S]*?)\[\/url\]/gi, (_m, url: string, t: string) => link(t, url))
    .replace(/\[url\]([\s\S]*?)\[\/url\]/gi, (_m, url: string) => link(url, url))
    .replace(/\[img[^\]]*\]([\s\S]*?)\[\/img\]/gi, (_m, url: string) => image(url))
    .replace(/\[yt\]([\w-]{6,})\[\/yt\]/gi, '[YouTube video](https://youtu.be/$1)')
    .replace(/\[\*\]/g, '\n- ')
    // any other BBCode tag ([color], [size], [center]…) — but not the [text](url) we just made
    .replace(/\[\/?[a-z]+(?:=[^\]]*)?\](?!\()/gi, '');
  return htmlToMarkdown(s);
}

/** AniList's Markdown flavour (img()/youtube()/webm(), ~~~centre~~~, inline HTML). */
export function anilistToMarkdown(text: string): string {
  const s = text
    .replace(/img\d*%?\((https?:[^)\s]+)\)/gi, (_m, url: string) => image(url))
    .replace(/youtube\(([^)\s]+)\)/gi, (_m, id: string) => link('YouTube video', /^https?:/i.test(id) ? id : `https://youtu.be/${id}`))
    .replace(/webm\((https?:[^)\s]+)\)/gi, (_m, url: string) => link('video', url))
    .replace(/~~~([\s\S]*?)~~~/g, '$1');
  return htmlToMarkdown(s);
}

function tidy(s: string): string {
  return s
    .split('\n')
    .map((l) => l.replace(/[ \t]+$/g, ''))
    .join('\n')
    .replace(/\n{3,}/g, '\n\n')
    .trim();
}

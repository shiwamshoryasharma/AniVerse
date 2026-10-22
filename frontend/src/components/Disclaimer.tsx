import { Gavel, Globe, HeartHandshake, ServerOff, ShieldAlert, UserCheck } from 'lucide-react';

/**
 * The legal position of the app, styled to be impossible to miss: AniVerse is a
 * browser with custom features; it hosts nothing, and notices about content
 * belong to the websites that serve it.
 */
export function Disclaimer() {
  return (
    <section className="disclaimer" role="note" aria-labelledby="disclaimer-title">
      <div className="disclaimer-head">
        <span className="disclaimer-badge" aria-hidden>
          <ShieldAlert size={26} />
        </span>
        <div>
          <span className="disclaimer-kicker">Important — please read</span>
          <h3 id="disclaimer-title">
            AniVerse is a web browser with anime features. <em>It hosts nothing.</em>
          </h3>
        </div>
      </div>
      <ul className="disclaimer-points">
        <li className="tone-err">
          <span className="dz-icon" aria-hidden>
            <ServerOff size={18} />
          </span>
          <div>
            <strong>No hosting. No media servers.</strong> AniVerse does not host, upload, store, stream or distribute any video or other content, and its developer runs no servers for media.
          </div>
        </li>
        <li className="tone-warn">
          <span className="dz-icon" aria-hidden>
            <Globe size={18} />
          </span>
          <div>
            <strong>Only third-party websites that you add yourself.</strong> Their pages load directly from each site’s own servers (<span className="code">config/streaming-sites.txt</span>). AniVerse
            reads those pages to find search results and episodes (web scraping and automated navigation), blocks ads, and lays a custom CSS overlay on top so only the site’s own player shows. Videos play
            from the site’s servers — AniVerse never downloads or copies them.
          </div>
        </li>
        <li className="tone-accent">
          <span className="dz-icon" aria-hidden>
            <Gavel size={18} />
          </span>
          <div>
            <strong>Legal notices go to the website’s operator or hosting provider — not to AniVerse.</strong> Copyright and DMCA notices about any content must be sent to whoever hosts it. The developer of
            AniVerse has no control over, affiliation with, or responsibility for those websites, and there is <strong>nothing hosted by AniVerse to take down</strong>.
          </div>
        </li>
        <li className="tone-ok">
          <span className="dz-icon" aria-hidden>
            <UserCheck size={18} />
          </span>
          <div>
            <strong>You are responsible for the websites you add</strong> and for following the laws of your country.
          </div>
        </li>
        <li className="tone-warn">
          <span className="dz-icon" aria-hidden>
            <HeartHandshake size={18} />
          </span>
          <div>
            <strong>A personal project, shared as-is.</strong> The developer made AniVerse for their own comfort. New releases and updates will be <strong>rare</strong>: they come only when the developer runs into
            a problem or wants a change. There is no release schedule, roadmap or promise of support.
          </div>
        </li>
      </ul>
    </section>
  );
}

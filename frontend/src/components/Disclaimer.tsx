import { Gavel, Globe, HeartHandshake, Database, ShieldAlert, UserCheck } from 'lucide-react';

/** Short product notice; DISCLAIMER.md documents the complete scope. */
export function Disclaimer() {
  return (
    <section className="disclaimer" role="note" aria-labelledby="disclaimer-title">
      <div className="disclaimer-head">
        <span className="disclaimer-badge" aria-hidden>
          <ShieldAlert size={26} />
        </span>
        <div>
          <span className="disclaimer-kicker">Browser, media and privacy notice</span>
          <h3 id="disclaimer-title">
            Your websites. Your local collection. <em>Your choices.</em>
          </h3>
        </div>
      </div>
      <ul className="disclaimer-points">
        <li className="tone-accent">
          <span className="dz-icon" aria-hidden>
            <Globe size={18} />
          </span>
          <div>
            <strong>A desktop browser with anime features.</strong> You choose the websites. AniVerse navigates rendered pages, blocks selected distractions,
            and focuses the site's existing player. Official signed releases contain no streaming-site list. The project does not operate a public
            episode-hosting service.
          </div>
        </li>
        <li className="tone-warn">
          <span className="dz-icon" aria-hidden>
            <Database size={18} />
          </span>
          <div>
            <strong>Local data still exists.</strong> Browser cookies/cache, progress, notes, plans and collection records remain on this device. Opt-in watch
            insights stay local. Third-party sites receive their own requests. Casting may temporarily serve a selected local file to your device over the local
            network.
          </div>
        </li>
        <li className="tone-ok">
          <span className="dz-icon" aria-hidden>
            <UserCheck size={18} />
          </span>
          <div>
            <strong>Use sources and files you are entitled to access.</strong> The application's software license does not license third-party videos, artwork
            or subtitles. Calling an app a browser does not establish permission or a legal exemption. AniVerse does not remove DRM or defeat access controls.
          </div>
        </li>
        <li className="tone-accent">
          <span className="dz-icon" aria-hidden>
            <Gavel size={18} />
          </span>
          <div>
            <strong>Direct concerns to whoever controls the material.</strong> Website content is controlled by its operator or host. Concerns about this
            project's own code or assets can be raised through its repository and GitHub's formal copyright channels. Valid legal obligations are not waived by
            this notice.
          </div>
        </li>
        <li className="tone-warn">
          <span className="dz-icon" aria-hidden>
            <HeartHandshake size={18} />
          </span>
          <div>
            <strong>A personal project, provided without warranty under its license.</strong> Updates may be infrequent, with no fixed roadmap or support
            promise. Website compatibility, source quality and GPU enhancements depend on external systems. See DISCLAIMER.md and PRIVACY.md in the repository
            for the full notices.
          </div>
        </li>
      </ul>
    </section>
  );
}

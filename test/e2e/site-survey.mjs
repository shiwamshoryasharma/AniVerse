// Site survey: drives every configured website through the site navigator
// (search → title → episode → player) inside the real app and records how each
// site behaves. Runs in-process (test/e2e/drivers/site-survey.cjs) rather than
// through Playwright: remote debugging sets navigator.webdriver, which some
// sites' anti-bot guards and Cloudflare react to.
// Output: test/artifacts/site-survey.json + survey-<id>.png. Run `npm run build` first.
//
//   node test/e2e/site-survey.mjs                 all web sources
//   node test/e2e/site-survey.mjs example-to ...  selected sources
//   SURVEY_ID=154587 SURVEY_EP=3 SURVEY_TIMEOUT=80000 node test/e2e/site-survey.mjs
//   SURVEY_KEEP=1 keeps the previous survey profile (cookies, learned links)
import { runDriver } from './native.mjs';

const code = await runDriver('test/e2e/drivers/site-survey.cjs', {
  env: { SURVEY_SOURCES: process.argv.slice(2).join(',') },
  keepProfile: !!process.env.SURVEY_KEEP,
  profile: process.env.SURVEY_PROFILE ?? 'survey-profile',
});
process.exit(code);

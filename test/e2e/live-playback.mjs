import {runDriver} from './native.mjs';
const profile='security-live-'+Date.now();
const code=await runDriver('test/e2e/drivers/playback-survey.cjs',{profile,keepProfile:true,env:{SURVEY_TIMEOUT:process.env.SURVEY_TIMEOUT??'35000',TEMP:new URL('../cache/',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1'),TMP:new URL('../cache/',import.meta.url).pathname.replace(/^\/([A-Za-z]:)/,'$1')}});
process.exit(code);

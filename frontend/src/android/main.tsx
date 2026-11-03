import '@fontsource-variable/inter';
import '../styles/app.css';
import '../styles/controls.css';
import '../styles/workspace.css';
import '../styles/themes.css';
import '../styles/layouts.css';
import '../styles/changelog.css';
import './tablet.css';
import { installTabletBridge } from './bridge';
try { await installTabletBridge(); const {mountTablet}=await import('./app');mountTablet(); } catch(error){document.getElementById('root')!.textContent='AniVerse could not start: '+String(error);}

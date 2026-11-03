import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { QueryClient,QueryClientProvider } from '@tanstack/react-query';
import { createHashRouter,RouterProvider } from 'react-router';
import { ToastProvider } from '../lib/toast';
import { RouteCrash } from '../components/RouteCrash';
import { HomePage } from '../pages/Home';
import { BrowsePage } from '../pages/Browse';
import { DetailsPage } from '../pages/Details';
import { SchedulePage } from '../pages/Schedule';
import { LibraryPage } from '../pages/Library';
import { HistoryPage } from '../pages/History';
import { TabletShell } from './TabletShell';
import { TabletWatch } from './TabletWatch';
import { TabletSources,TabletLocal,TabletDownloads,TabletSettings } from './pages';
export function mountTablet(){
  const client=new QueryClient({defaultOptions:{queries:{retry:1,refetchOnWindowFocus:false}}});
  const router=createHashRouter([{element:<TabletShell/>,errorElement:<RouteCrash/>,children:[{index:true,element:<HomePage/>},{path:'browse',element:<BrowsePage/>},{path:'anime/:id',element:<DetailsPage/>},{path:'watch/:id/:episode?',element:<TabletWatch/>},{path:'schedule',element:<SchedulePage/>},{path:'library',element:<LibraryPage/>},{path:'history',element:<HistoryPage/>},{path:'sources',element:<TabletSources/>},{path:'sources/:id',element:<TabletSources/>},{path:'local',element:<TabletLocal/>},{path:'downloads',element:<TabletDownloads/>},{path:'settings/:section?',element:<TabletSettings/>}]}]);
  createRoot(document.getElementById('root')!).render(<StrictMode><QueryClientProvider client={client}><ToastProvider><RouterProvider router={router}/></ToastProvider></QueryClientProvider></StrictMode>);
}

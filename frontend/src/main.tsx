import '@fontsource-variable/inter';
import './styles/app.css';
import './styles/controls.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createHashRouter, RouterProvider } from 'react-router';
import { RouteCrash } from './components/RouteCrash';
import { Shell } from './components/Shell';
import { ToastProvider } from './lib/toast';
import { BrowsePage } from './pages/Browse';
import { DetailsPage } from './pages/Details';
import { HomePage } from './pages/Home';
import { HistoryPage, LibraryPage } from './pages/Library';
import { PlayerPage } from './pages/Player';
import { ProfilePage } from './pages/Profile';
import { SchedulePage } from './pages/Schedule';
import { SettingsPage } from './pages/Settings';
import { SourceBrowserPage, SourcesPage } from './pages/Sources';
import { WatchPage } from './pages/Watch';

const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      retry: (count, err) => count < 1 && (err as { code?: string }).code !== 'invalid-input' && (err as { code?: string }).code !== 'not-found',
      refetchOnWindowFocus: false,
    },
  },
});

const router = createHashRouter([
  {
    element: <Shell />,
    errorElement: <RouteCrash />,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'browse', element: <BrowsePage /> },
      { path: 'anime/:id', element: <DetailsPage /> },
      { path: 'watch/:id/:episode?', element: <WatchPage /> },
      { path: 'schedule', element: <SchedulePage /> },
      { path: 'library', element: <LibraryPage /> },
      { path: 'history', element: <HistoryPage /> },
      { path: 'sources', element: <SourcesPage /> },
      { path: 'sources/:id', element: <SourceBrowserPage /> },
      { path: 'player', element: <PlayerPage /> },
      { path: 'profile', element: <ProfilePage /> },
      { path: 'settings/:section?', element: <SettingsPage /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode>
    <QueryClientProvider client={queryClient}>
      <ToastProvider>
        <RouterProvider router={router} />
      </ToastProvider>
    </QueryClientProvider>
  </StrictMode>,
);

import '@fontsource-variable/inter';
import './styles/app.css';
import './styles/controls.css';
import './styles/workspace.css';
import './styles/themes.css';
import './styles/upscale.css';
import './styles/layouts.css';
import './styles/changelog.css';
import './styles/casting.css';
import './styles/midnight.css';
import './styles/desktop-display.css';
import './styles/aniverse2-theme-surfaces.css';
import { QueryClient, QueryClientProvider } from '@tanstack/react-query';
import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createHashRouter, RouterProvider } from 'react-router';
import { Spinner } from './components/common';
import { RouteCrash } from './components/RouteCrash';
import { Shell } from './components/Shell';
import { ToastProvider } from './lib/toast';
import { HomePage } from './pages/Home';

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
    hydrateFallbackElement: <div className="state" role="status"><Spinner /> Loading page…</div>,
    children: [
      { index: true, element: <HomePage /> },
      { path: 'browse', lazy: () => import('./pages/Browse').then(({ BrowsePage: Component }) => ({ Component })) },
      { path: 'anime/:id', lazy: () => import('./pages/Details').then(({ DetailsPage: Component }) => ({ Component })) },
      { path: 'watch/:id/:episode?', lazy: () => import('./pages/Watch').then(({ WatchPage: Component }) => ({ Component })) },
      { path: 'schedule', lazy: () => import('./pages/Schedule').then(({ SchedulePage: Component }) => ({ Component })) },
      { path: 'library', lazy: () => import('./pages/Library').then(({ LibraryPage: Component }) => ({ Component })) },
      { path: 'history', lazy: () => import('./pages/Library').then(({ HistoryPage: Component }) => ({ Component })) },
      { path: 'sources', lazy: () => import('./pages/Sources').then(({ SourcesPage: Component }) => ({ Component })) },
      { path: 'sources/:id', lazy: () => import('./pages/Sources').then(({ SourceBrowserPage: Component }) => ({ Component })) },
      { path: 'workspace/:section?', lazy: () => import('./pages/Workspace').then(({ WorkspacePage: Component }) => ({ Component })) },
      { path: 'player', lazy: () => import('./pages/Player').then(({ PlayerPage: Component }) => ({ Component })) },
      { path: 'profile', lazy: () => import('./pages/Profile').then(({ ProfilePage: Component }) => ({ Component })) },
      { path: 'settings/:section?', lazy: () => import('./pages/Settings').then(({ SettingsPage: Component }) => ({ Component })) },
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

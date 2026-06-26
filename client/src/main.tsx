import { StrictMode } from 'react';
import { createRoot } from 'react-dom/client';
import { createBrowserRouter, RouterProvider, Navigate } from 'react-router-dom';
import Kiosk from './kiosk/Kiosk';
import Admin from './admin/Admin';
import { Log, Content, Kids, Reading, Scheduling, Evals, Faces, Settings } from './admin/pages';
import Preview from './admin/Preview';
import './index.css';

const router = createBrowserRouter([
  { path: '/', element: <Kiosk /> },
  { path: '/preview/:id', element: <Preview /> },
  {
    path: '/admin', element: <Admin />, children: [
      { index: true, element: <Navigate to="log" replace /> },
      { path: 'log', element: <Log /> },
      { path: 'content', element: <Content /> },
      { path: 'pages', element: <Navigate to="/admin/content" replace /> },
      { path: 'create', element: <Navigate to="/admin/content" replace /> },
      { path: 'kids', element: <Kids /> },
      { path: 'schedule', element: <Scheduling /> },
      { path: 'timers', element: <Navigate to="/admin/schedule" replace /> },
      { path: 'reading', element: <Reading /> },
      { path: 'evals', element: <Evals /> },
      { path: 'faces', element: <Faces /> },
      { path: 'settings', element: <Settings /> },
    ],
  },
]);

createRoot(document.getElementById('root')!).render(
  <StrictMode><RouterProvider router={router} /></StrictMode>,
);

import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { ConnectionProvider } from '@/contexts/ConnectionContext';
import { OperationLogProvider } from '@/contexts/OperationLogContext';
import { Sidebar } from '@/components/layout/Sidebar';
import { RequireConnection } from '@/components/layout/RequireConnection';
import { ToastContainer } from '@/components/ui/Toast';
import { usePreloadBlobby } from '@/components/ui/Blobby';
import { ConnectPage } from '@/pages/ConnectPage';

function PaddedLayout() {
  return (
    <div className="flex-1 flex items-center justify-center py-6">
      <div className="max-w-5xl w-full px-6">
        <Outlet />
      </div>
    </div>
  );
}
import { MigratePage } from '@/pages/MigratePage';
import { BulkDeletePage } from '@/pages/BulkDeletePage';
import { BulkMovePage } from '@/pages/BulkMovePage';
import { UsersPage } from '@/pages/UsersPage';
import { GroupsPage } from '@/pages/GroupsPage';
import { ModelsPage } from '@/pages/ModelsPage';
import { TopicsPage } from '@/pages/TopicsPage';
import { EmbedsPage } from '@/pages/EmbedsPage';
import { HistoryPage } from '@/pages/HistoryPage';
import { DownloadsPage } from '@/pages/DownloadsPage';
import { BulkCopyPage } from '@/pages/BulkCopyPage';
import { ConnectionsPage } from '@/pages/ConnectionsPage';
import { SchedulesPage } from '@/pages/SchedulesPage';
import { LabelsPage } from '@/pages/LabelsPage';
import { UploadsPage } from '@/pages/UploadsPage';
import { DeckBuilderPage } from '@/pages/DeckBuilderPage';
import { DataPrivacyPage } from '@/pages/DataPrivacyPage';

function AppLayout() {
  return (
    <div className="flex min-h-screen" style={{ background: 'radial-gradient(ellipse at top left, #FFECF5 0%, #FFF2F8 40%, #FFF8FB 100%)' }}>
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[100] focus:bg-omni-700 focus:text-white focus:px-4 focus:py-2 focus:rounded-button focus:shadow-dropdown"
      >
        Skip to main content
      </a>
      <Sidebar />
      <main id="main-content" className="flex-1 flex flex-col overflow-y-auto" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<Navigate to="/connect" replace />} />
          <Route path="/connect" element={<ConnectPage />} />
          <Route element={<PaddedLayout />}>
            <Route path="/dashboards/migrate" element={<MigratePage />} />
            <Route
              path="/dashboards/bulk-move"
              element={<RequireConnection><BulkMovePage /></RequireConnection>}
            />
            <Route
              path="/dashboards/bulk-copy"
              element={<RequireConnection><BulkCopyPage /></RequireConnection>}
            />
            <Route
              path="/dashboards/bulk-delete"
              element={<RequireConnection><BulkDeletePage /></RequireConnection>}
            />
            <Route
              path="/dashboards/downloads"
              element={<RequireConnection><DownloadsPage /></RequireConnection>}
            />
            <Route
              path="/deck-builder"
              element={<RequireConnection><DeckBuilderPage /></RequireConnection>}
            />
            <Route
              path="/connections"
              element={<RequireConnection><ConnectionsPage /></RequireConnection>}
            />
            <Route
              path="/uploads"
              element={<RequireConnection><UploadsPage /></RequireConnection>}
            />
            <Route
              path="/users"
              element={<RequireConnection><UsersPage /></RequireConnection>}
            />
            <Route
              path="/groups"
              element={<RequireConnection><GroupsPage /></RequireConnection>}
            />
            <Route
              path="/models"
              element={<RequireConnection><ModelsPage /></RequireConnection>}
            />
            <Route
              path="/topics"
              element={<RequireConnection><TopicsPage /></RequireConnection>}
            />
            <Route
              path="/labels"
              element={<RequireConnection><LabelsPage /></RequireConnection>}
            />
            <Route
              path="/schedules"
              element={<RequireConnection><SchedulesPage /></RequireConnection>}
            />
            <Route
              path="/embeds"
              element={<RequireConnection><EmbedsPage /></RequireConnection>}
            />
            <Route path="/history" element={<HistoryPage />} />
            <Route path="/data-privacy" element={<DataPrivacyPage />} />
          </Route>
        </Routes>
      </main>
      <ToastContainer />
    </div>
  );
}

function App() {
  usePreloadBlobby();
  return (
    <BrowserRouter>
      <ConnectionProvider>
        <OperationLogProvider>
          <AppLayout />
        </OperationLogProvider>
      </ConnectionProvider>
    </BrowserRouter>
  );
}

export default App;

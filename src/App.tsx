import { BrowserRouter, Routes, Route, Navigate, Outlet } from 'react-router-dom';
import { ConnectionProvider } from '@/contexts/ConnectionContext';
import { OperationLogProvider } from '@/contexts/OperationLogContext';
import { Sidebar } from '@/components/layout/Sidebar';
import { RequireConnection } from '@/components/layout/RequireConnection';
import { ToastContainer } from '@/components/ui/Toast';
import { OmniKitWalkthrough } from '@/components/walkthrough/OmniKitWalkthrough';
import { usePreloadBlobby } from '@/components/ui/Blobby';
import { WalkthroughProvider } from '@/contexts/WalkthroughContext';
import { ConnectPage } from '@/pages/ConnectPage';
import { VaultSessionProvider } from '@/hooks/useVaultSession';

function PaddedLayout() {
  return (
    <div className="flex-1 min-h-full flex items-start justify-center py-6">
      <div className="w-full max-w-[1560px] 2xl:max-w-[1680px] px-4 sm:px-6 my-auto">
        <Outlet />
      </div>
    </div>
  );
}
import { MigratePage } from '@/pages/MigratePage';
import { ModelMigratorPage } from '@/pages/ModelMigratorPage';
import { UserManagementPage } from '@/pages/UserManagementPage';
import { ModelsPage } from '@/pages/ModelsPage';
import { TopicsPage } from '@/pages/TopicsPage';
import { EmbedsPage } from '@/pages/EmbedsPage';
import { HistoryPage } from '@/pages/HistoryPage';
import { DownloadsPage } from '@/pages/DownloadsPage';
import { ConnectionsPage } from '@/pages/ConnectionsPage';
import { SchedulesPage } from '@/pages/SchedulesPage';
import { LabelsPage } from '@/pages/LabelsPage';
import { UploadsPage } from '@/pages/UploadsPage';
import { DeckBuilderPage } from '@/pages/DeckBuilderPage';
import { DataPrivacyPage } from '@/pages/DataPrivacyPage';
import { DashboardOperationsPage } from '@/pages/DashboardOperationsPage';
import { ContentHealthPage } from '@/pages/ContentHealthPage';
import { AIDashboardStudioPage } from '@/pages/AIDashboardStudioPage';
import { InstancesPage } from '@/pages/InstancesPage';

function AppLayout() {
  return (
    <div className="flex h-screen overflow-hidden bg-surface-secondary">
      <a
        href="#main-content"
        className="sr-only focus:not-sr-only focus:fixed focus:top-4 focus:left-4 focus:z-[100] focus:bg-omni-700 focus:text-white focus:px-4 focus:py-2 focus:rounded-button focus:shadow-dropdown"
      >
        Skip to main content
      </a>
      <Sidebar />
      <main id="main-content" className="flex-1 min-w-0 min-h-0 flex flex-col overflow-y-auto" tabIndex={-1}>
        <Routes>
          <Route path="/" element={<ConnectPage />} />
          <Route path="/connect" element={<Navigate to="/" replace />} />
          <Route element={<PaddedLayout />}>
            <Route path="/dashboards/migrate" element={<MigratePage />} />
            <Route path="/models/migrate" element={<ModelMigratorPage />} />
            <Route
              path="/dashboards/ai-studio"
              element={<RequireConnection><AIDashboardStudioPage /></RequireConnection>}
            />
            <Route
              path="/dashboards/operations"
              element={<RequireConnection><DashboardOperationsPage /></RequireConnection>}
            />
            <Route
              path="/dashboards/bulk-move"
              element={<Navigate to="/dashboards/operations" replace />}
            />
            <Route
              path="/dashboards/bulk-copy"
              element={<Navigate to="/dashboards/operations" replace />}
            />
            <Route
              path="/dashboards/bulk-delete"
              element={<Navigate to="/dashboards/operations" replace />}
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
            <Route path="/instances" element={<InstancesPage />} />
            <Route
              path="/uploads"
              element={<RequireConnection><UploadsPage /></RequireConnection>}
            />
            <Route
              path="/users"
              element={<RequireConnection><UserManagementPage /></RequireConnection>}
            />
            <Route
              path="/groups"
              element={<Navigate to="/users?tab=groups" replace />}
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
              path="/content-health"
              element={<RequireConnection><ContentHealthPage /></RequireConnection>}
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
      <OmniKitWalkthrough />
      <ToastContainer />
    </div>
  );
}

function App() {
  usePreloadBlobby();
  return (
    <BrowserRouter>
      <ConnectionProvider>
        <VaultSessionProvider>
          <OperationLogProvider>
            <WalkthroughProvider>
              <AppLayout />
            </WalkthroughProvider>
          </OperationLogProvider>
        </VaultSessionProvider>
      </ConnectionProvider>
    </BrowserRouter>
  );
}

export default App;

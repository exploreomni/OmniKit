import { useEffect, useState } from 'react';
import { Link2, Copy, Check, ExternalLink } from 'lucide-react';
import { generateEmbedUrl } from '@/services/omniApi';
import { useConnection } from '@/contexts/ConnectionContext';
import { useConnectionRequestGuard } from '@/hooks/useConnectionRequestGuard';
import { DashboardSearch } from '@/components/deckBuilder/DashboardSearch';
import { PageHeader } from '@/components/layout/PageHeader';
import { Blobby } from '@/components/ui/Blobby';
import { fetchDashboardList } from '@/services/deckBuilder/omniDeckApi';
import { dashboardCache, type CachedDashboard } from '@/services/deckBuilder/localCache';
import { friendlyApiError } from '@/utils/apiErrors';

function dashboardContentPath(dashboard: CachedDashboard) {
  return `/dashboards/${dashboard.id}`;
}

export function EmbedsPage() {
  const { connection } = useConnection();
  const { connectionKey, isActiveConnectionRequest } = useConnectionRequestGuard(connection);
  const [contentPath, setContentPath] = useState('');
  const [selectedDashboardId, setSelectedDashboardId] = useState('');
  const [dashboards, setDashboards] = useState<CachedDashboard[]>([]);
  const [dashboardsSyncedAt, setDashboardsSyncedAt] = useState<number | null>(null);
  const [loadingDashboards, setLoadingDashboards] = useState(false);
  const [externalId, setExternalId] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [groups, setGroups] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [recentUrls, setRecentUrls] = useState<Array<{ path: string; url: string; time: string }>>([]);

  useEffect(() => {
    const cached = dashboardCache.load(connection.baseUrl);
    if (cached?.data) {
      setDashboards(cached.data);
      setDashboardsSyncedAt(cached.savedAt);
    } else {
      setDashboards([]);
      setDashboardsSyncedAt(null);
    }
    setSelectedDashboardId('');
    setContentPath('');
    setResult(null);
    setError('');
    setCopied(false);
    setLoading(false);
    setLoadingDashboards(false);
    setRecentUrls([]);
  }, [connection.baseUrl, connectionKey]);

  async function refreshDashboards() {
    const requestKey = connectionKey;
    setLoadingDashboards(true);
    setError('');
    try {
      const next = await fetchDashboardList(connection.baseUrl, connection.apiKey);
      if (!isActiveConnectionRequest(requestKey)) return;
      setDashboards(next);
      setDashboardsSyncedAt(Date.now());
      dashboardCache.save(connection.baseUrl, next);
    } catch (err) {
      if (!isActiveConnectionRequest(requestKey)) return;
      setError(friendlyApiError(err, 'Failed to load dashboards'));
    } finally {
      if (isActiveConnectionRequest(requestKey)) setLoadingDashboards(false);
    }
  }

  function pickDashboard(dashboard: CachedDashboard) {
    setSelectedDashboardId(dashboard.id);
    setContentPath(dashboardContentPath(dashboard));
    setResult(null);
    setCopied(false);
  }

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
    const requestKey = connectionKey;
    setLoading(true);
    setError('');
    setResult(null);

    try {
      const body: Record<string, unknown> = {
        contentPath,
        externalId: externalId || undefined,
        name: name || undefined,
        email: email || undefined,
      };
      if (groups) {
        body.groups = groups.split(',').map((g) => g.trim()).filter(Boolean);
      }

      const res = await generateEmbedUrl(connection.baseUrl, connection.apiKey, body);
      if (!isActiveConnectionRequest(requestKey)) return;
      const url = res.url || res.embed_url || JSON.stringify(res);
      setResult(url);
      setRecentUrls((prev) => [
        { path: contentPath, url, time: new Date().toLocaleTimeString() },
        ...prev.slice(0, 9),
      ]);
    } catch (err) {
      if (!isActiveConnectionRequest(requestKey)) return;
      setError(friendlyApiError(err, 'Failed to generate embed URL'));
    } finally {
      if (isActiveConnectionRequest(requestKey)) setLoading(false);
    }
  }

  async function copyText(value: string) {
    try {
      await navigator.clipboard.writeText(value);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    } catch (err) {
      setError(friendlyApiError(err, 'Unable to copy URL'));
    }
  }

  function handleCopy() {
    if (result) {
      copyText(result);
    }
  }

  return (
    <div className="space-y-5 max-w-6xl mx-auto">
      <PageHeader
        title="Embed URL Generator"
        description="Generate signed embed URLs for governed external application access."
        icon={<Blobby mood="embed" size={58} className="animate-float" style={{ animationDuration: '3.7s' }} />}
      />

      <div className="grid md:grid-cols-3 gap-4 items-stretch">
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Governance Use Case</div>
          <div className="mt-2 text-sm font-semibold text-content-primary">Embedded access validation</div>
          <p className="mt-1 text-xs text-content-secondary leading-5">Generate a signed URL for a known content path and user identity before app handoff.</p>
        </div>
        <div className="card p-4">
          <div className="text-xs font-medium text-content-secondary uppercase tracking-wider">Identity Context</div>
          <div className="mt-2 text-sm font-semibold text-content-primary">External ID, email, groups</div>
          <p className="mt-1 text-xs text-content-secondary leading-5">Pass the same identity claims your embedded app will send in production.</p>
        </div>
        <div className="card p-4 border-yellow-200 bg-yellow-50">
          <div className="text-xs font-medium text-yellow-800 uppercase tracking-wider">Sensitive Output</div>
          <div className="mt-2 text-sm font-semibold text-yellow-900">Treat URLs like credentials</div>
          <p className="mt-1 text-xs text-yellow-800 leading-5">Signed embed URLs can grant access. Share only through the approved implementation channel.</p>
        </div>
      </div>

      <div className="max-w-4xl mx-auto space-y-5">
        <div className="card min-h-[220px] flex flex-col justify-center">
          <h3 className="text-sm font-semibold text-content-primary mb-4">Embed Readiness Checklist</h3>
          <div className="grid gap-4 md:grid-cols-3 text-sm">
            <div className="flex items-start gap-2">
              <Check size={14} className="text-green-600 mt-0.5 flex-shrink-0" />
              <div>
                <div className="font-medium text-content-primary">Confirm content path</div>
                <p className="text-xs text-content-secondary mt-0.5 leading-5">Use the same dashboard or workbook path the application will embed.</p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Check size={14} className="text-green-600 mt-0.5 flex-shrink-0" />
              <div>
                <div className="font-medium text-content-primary">Match production identity</div>
                <p className="text-xs text-content-secondary mt-0.5 leading-5">External ID, email, and groups should mirror the claims your app will send.</p>
              </div>
            </div>
            <div className="flex items-start gap-2">
              <Check size={14} className="text-green-600 mt-0.5 flex-shrink-0" />
              <div>
                <div className="font-medium text-content-primary">Share securely</div>
                <p className="text-xs text-content-secondary mt-0.5 leading-5">Copy signed URLs only into approved test or implementation channels.</p>
              </div>
            </div>
          </div>
        </div>

        <div className="card">
          <h3 className="text-sm font-semibold text-content-primary mb-4">Configuration</h3>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 rounded mb-4">{error}</div>
          )}

          <form onSubmit={handleGenerate} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-content-secondary mb-1">Dashboard Picker</label>
              <DashboardSearch
                dashboards={dashboards}
                loading={loadingDashboards}
                lastSyncedAt={dashboardsSyncedAt}
                onRefresh={refreshDashboards}
                onPick={pickDashboard}
                selectedDashboardId={selectedDashboardId}
                disabled={!connection.baseUrl || !connection.apiKey}
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-content-secondary mb-1">Content Path *</label>
              <input
                type="text"
                value={contentPath}
                onChange={(e) => {
                  setContentPath(e.target.value);
                  setSelectedDashboardId('');
                  setResult(null);
                }}
                className="input-field"
                placeholder="/dashboards/my-dashboard"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-content-secondary mb-1">External ID</label>
              <input
                type="text"
                value={externalId}
                onChange={(e) => setExternalId(e.target.value)}
                className="input-field"
                placeholder="user-123"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-content-secondary mb-1">Name</label>
              <input
                type="text"
                value={name}
                onChange={(e) => setName(e.target.value)}
                className="input-field"
                placeholder="John Doe"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-content-secondary mb-1">Email</label>
              <input
                type="email"
                value={email}
                onChange={(e) => setEmail(e.target.value)}
                className="input-field"
                placeholder="user@example.com"
              />
            </div>
            <div>
              <label className="block text-xs font-medium text-content-secondary mb-1">Groups (comma-separated)</label>
              <input
                type="text"
                value={groups}
                onChange={(e) => setGroups(e.target.value)}
                className="input-field"
                placeholder="group1, group2"
              />
            </div>
            <button type="submit" disabled={loading || !contentPath} className="btn-primary w-full">
              {loading ? (
                <span className="w-4 h-4 border-2 border-white border-t-transparent rounded-full animate-spin" />
              ) : (
                <Link2 size={14} />
              )}
              Generate Embed URL
            </button>
          </form>
        </div>

        {result && (
          <div className="card min-h-[220px]">
            <h3 className="text-sm font-semibold text-content-primary mb-3">Generated URL</h3>
            <div className="bg-gray-900 rounded p-3 mb-3">
              <code className="text-green-400 text-xs font-mono break-all leading-relaxed">{result}</code>
            </div>
            <div className="flex gap-2">
              <button onClick={handleCopy} className="btn-secondary text-sm flex-1">
                {copied ? <Check size={14} className="text-success" /> : <Copy size={14} />}
                {copied ? 'Copied' : 'Copy URL'}
              </button>
              <a
                href={result}
                target="_blank"
                rel="noopener noreferrer"
                className="btn-secondary text-sm flex-1 justify-center"
              >
                <ExternalLink size={14} />
                Open in New Tab
              </a>
            </div>
          </div>
        )}

        {recentUrls.length > 0 && (
          <div className="card">
            <h3 className="text-sm font-semibold text-content-primary mb-3">Recent URLs</h3>
            <div className="space-y-2">
              {recentUrls.map((item, i) => (
                <div key={i} className="flex items-center justify-between py-2 border-b border-border/50 last:border-0">
                  <div className="min-w-0 flex-1">
                    <div className="text-sm text-content-primary truncate">{item.path}</div>
                    <div className="text-xs text-content-secondary">{item.time}</div>
                  </div>
                  <button
                    onClick={() => {
                      copyText(item.url);
                    }}
                    className="p-1.5 text-content-secondary hover:text-omni-700 hover:bg-omni-100 rounded transition-colors flex-shrink-0 ml-2"
                  >
                    <Copy size={14} />
                  </button>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </div>
  );
}

import { useState } from 'react';
import { Link2, Copy, Check, ExternalLink } from 'lucide-react';
import { generateEmbedUrl } from '@/services/omniApi';
import { useConnection } from '@/contexts/ConnectionContext';
import { PageHeader } from '@/components/layout/PageHeader';

export function EmbedsPage() {
  const { connection } = useConnection();
  const [contentPath, setContentPath] = useState('');
  const [externalId, setExternalId] = useState('');
  const [name, setName] = useState('');
  const [email, setEmail] = useState('');
  const [groups, setGroups] = useState('');
  const [result, setResult] = useState<string | null>(null);
  const [error, setError] = useState('');
  const [loading, setLoading] = useState(false);
  const [copied, setCopied] = useState(false);
  const [recentUrls, setRecentUrls] = useState<Array<{ path: string; url: string; time: string }>>([]);

  async function handleGenerate(e: React.FormEvent) {
    e.preventDefault();
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
      const url = res.url || res.embed_url || JSON.stringify(res);
      setResult(url);
      setRecentUrls((prev) => [
        { path: contentPath, url, time: new Date().toLocaleTimeString() },
        ...prev.slice(0, 9),
      ]);
    } catch (err) {
      setError(err instanceof Error ? err.message : 'Failed to generate embed URL');
    } finally {
      setLoading(false);
    }
  }

  function handleCopy() {
    if (result) {
      navigator.clipboard.writeText(result);
      setCopied(true);
      setTimeout(() => setCopied(false), 2000);
    }
  }

  return (
    <div className="space-y-5">
      <PageHeader
        title="Embed URL Generator"
        description="Generate signed embed URLs for embedding Omni content in external applications."
      />

      <div className="grid grid-cols-1 lg:grid-cols-2 gap-6">
        <div className="card">
          <h3 className="text-sm font-semibold text-content-primary mb-4">Configuration</h3>

          {error && (
            <div className="bg-red-50 border border-red-200 text-red-700 text-xs px-3 py-2 rounded mb-4">{error}</div>
          )}

          <form onSubmit={handleGenerate} className="space-y-4">
            <div>
              <label className="block text-xs font-medium text-content-secondary mb-1">Content Path *</label>
              <input
                type="text"
                value={contentPath}
                onChange={(e) => setContentPath(e.target.value)}
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

        <div className="space-y-4">
          {result && (
            <div className="card">
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
                        navigator.clipboard.writeText(item.url);
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
    </div>
  );
}

export interface ParsedDashboardUrl {
  dashboardId: string;
  host: string;
}

export function parseDashboardUrl(input: string, expectedBaseUrl: string): ParsedDashboardUrl {
  const trimmed = input.trim();
  if (!trimmed) {
    throw new Error('Dashboard URL is required.');
  }

  let parsed: URL;
  try {
    parsed = new URL(trimmed);
  } catch {
    throw new Error('That does not look like a valid URL.');
  }

  const expectedHost = (() => {
    try {
      return new URL(expectedBaseUrl).host;
    } catch {
      return expectedBaseUrl.replace(/^https?:\/\//, '').replace(/\/$/, '');
    }
  })();

  if (expectedHost && parsed.host !== expectedHost) {
    throw new Error(
      `URL host (${parsed.host}) does not match your connected Omni instance (${expectedHost}).`
    );
  }

  const match = parsed.pathname.match(/\/dashboards\/([^/?#]+)/);
  if (!match) {
    throw new Error('Could not find a dashboard ID in the URL. Expected /dashboards/<id>.');
  }

  return { dashboardId: match[1], host: parsed.host };
}

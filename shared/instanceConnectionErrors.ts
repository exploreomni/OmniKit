export const INSTANCE_CONNECTION_ERROR_CODES = {
  cancelled: 'INSTANCE_VALIDATION_CANCELLED',
  timeout: 'INSTANCE_VALIDATION_TIMEOUT',
  networkTimeout: 'INSTANCE_NETWORK_TIMEOUT',
  invalidResponse: 'INSTANCE_INVALID_RESPONSE',
  credentialRejected: 'INSTANCE_CREDENTIAL_REJECTED',
  callerForbidden: 'INSTANCE_CALLER_FORBIDDEN',
  rateLimited: 'INSTANCE_RATE_LIMITED',
  upstreamUnavailable: 'INSTANCE_UPSTREAM_UNAVAILABLE',
  identityEndpointUnavailable: 'INSTANCE_IDENTITY_ENDPOINT_UNAVAILABLE',
  redirectBlocked: 'INSTANCE_REDIRECT_BLOCKED',
  urlInvalid: 'INSTANCE_URL_INVALID',
  dnsResolutionFailed: 'INSTANCE_DNS_RESOLUTION_FAILED',
  networkTargetBlocked: 'INSTANCE_NETWORK_TARGET_BLOCKED',
  connectionRefused: 'INSTANCE_CONNECTION_REFUSED',
  networkUnreachable: 'INSTANCE_NETWORK_UNREACHABLE',
  connectionInterrupted: 'INSTANCE_CONNECTION_INTERRUPTED',
  tlsValidationFailed: 'INSTANCE_TLS_VALIDATION_FAILED',
  validationHttpFailed: 'INSTANCE_VALIDATION_HTTP_FAILED',
  transportFailed: 'INSTANCE_TRANSPORT_FAILED',
  credentialChanged: 'INSTANCE_CREDENTIAL_CHANGED',
  clientConnectionFailed: 'INSTANCE_CLIENT_CONNECTION_FAILED',
  localServerUnreachable: 'OMNIKIT_LOCAL_SERVER_UNREACHABLE',
  legacyValidationFailed: 'INSTANCE_VALIDATION_FAILED',
} as const;

export type InstanceConnectionErrorCode = (
  typeof INSTANCE_CONNECTION_ERROR_CODES
)[keyof typeof INSTANCE_CONNECTION_ERROR_CODES];

export interface InstanceConnectionDiagnosticCopy {
  message: string;
  guidance: string;
}

export const INSTANCE_CONNECTION_DIAGNOSTICS: Record<
  InstanceConnectionErrorCode,
  InstanceConnectionDiagnosticCopy
> = {
  INSTANCE_VALIDATION_CANCELLED: {
    message: 'The Omni connection check was cancelled.',
    guidance: 'Choose the saved instance again when you are ready to retry.',
  },
  INSTANCE_VALIDATION_TIMEOUT: {
    message: 'Omni did not respond within 8 seconds.',
    guidance: 'Check the instance network path, VPN, or proxy, then retry once.',
  },
  INSTANCE_NETWORK_TIMEOUT: {
    message: 'The network connection to Omni timed out before validation completed.',
    guidance: 'Check the instance network path, VPN, or proxy, then retry once.',
  },
  INSTANCE_INVALID_RESPONSE: {
    message: 'Omni returned an invalid current-caller response, so the connection was not marked validated.',
    guidance: 'Confirm this is the direct Omni instance URL and that the instance supports GET /api/v1/whoami.',
  },
  INSTANCE_CREDENTIAL_REJECTED: {
    message: 'The saved Omni credential was rejected.',
    guidance: 'Replace an expired or incorrect API key, then test the saved instance again.',
  },
  INSTANCE_CALLER_FORBIDDEN: {
    message: 'The saved credential reached Omni but cannot read the current caller.',
    guidance: 'Confirm the API key is active and permitted to call GET /api/v1/whoami.',
  },
  INSTANCE_RATE_LIMITED: {
    message: 'Omni is rate limiting connection checks.',
    guidance: 'Wait briefly, then retry once. Repeated retries can extend the limit.',
  },
  INSTANCE_UPSTREAM_UNAVAILABLE: {
    message: 'Omni is temporarily unavailable.',
    guidance: 'Check the Omni instance status and retry after the upstream service recovers.',
  },
  INSTANCE_IDENTITY_ENDPOINT_UNAVAILABLE: {
    message: 'The Omni instance did not expose the required current-caller endpoint.',
    guidance: 'Confirm the saved URL points directly to the intended Omni instance and that GET /api/v1/whoami is available.',
  },
  INSTANCE_REDIRECT_BLOCKED: {
    message: 'The saved Omni URL redirected the connection check.',
    guidance: 'Save the direct HTTPS Omni instance URL; OmniKit does not follow redirects with credentials.',
  },
  INSTANCE_URL_INVALID: {
    message: 'The saved Omni instance URL is invalid or no longer permitted.',
    guidance: 'Update the saved instance with its direct HTTPS Omni URL and try again.',
  },
  INSTANCE_DNS_RESOLUTION_FAILED: {
    message: 'OmniKit could not resolve the saved Omni hostname.',
    guidance: 'Check the instance URL, DNS, and any required VPN connection.',
  },
  INSTANCE_NETWORK_TARGET_BLOCKED: {
    message: 'OmniKit blocked the resolved network target.',
    guidance: 'Use the public HTTPS Omni instance hostname; local and private network targets are not permitted.',
  },
  INSTANCE_CONNECTION_REFUSED: {
    message: 'The saved Omni host refused the connection.',
    guidance: 'Check the hostname, port, firewall, and whether the Omni endpoint is accepting HTTPS connections.',
  },
  INSTANCE_NETWORK_UNREACHABLE: {
    message: 'The saved Omni host is not reachable from this machine.',
    guidance: 'Check the network route, VPN, proxy, and firewall, then retry.',
  },
  INSTANCE_CONNECTION_INTERRUPTED: {
    message: 'The connection to Omni was interrupted before validation completed.',
    guidance: 'Check the network path and retry once after connectivity is stable.',
  },
  INSTANCE_TLS_VALIDATION_FAILED: {
    message: 'OmniKit could not validate the Omni host TLS certificate.',
    guidance: 'Check the saved hostname, certificate chain, and any TLS-inspecting proxy. OmniKit will not bypass certificate validation.',
  },
  INSTANCE_VALIDATION_HTTP_FAILED: {
    message: 'Omni rejected the current-caller validation request.',
    guidance: 'Confirm the saved instance URL and API-key contract, then test the instance again.',
  },
  INSTANCE_TRANSPORT_FAILED: {
    message: 'OmniKit could not establish a verified network connection to Omni.',
    guidance: 'Check DNS, TLS, VPN, proxy, and firewall access. Include the diagnostic code and build identifier when reporting the failure.',
  },
  INSTANCE_CREDENTIAL_CHANGED: {
    message: 'The saved instance changed during validation.',
    guidance: 'Test or connect to the current saved credential again.',
  },
  INSTANCE_CLIENT_CONNECTION_FAILED: {
    message: 'OmniKit could not complete the saved-instance connection.',
    guidance: 'Retry once, then include the diagnostic code and build identifier if the failure continues.',
  },
  OMNIKIT_LOCAL_SERVER_UNREACHABLE: {
    message: 'The browser could not reach the local OmniKit server.',
    guidance: 'Confirm OmniKit is still running locally, then reload the app and retry.',
  },
  INSTANCE_VALIDATION_FAILED: {
    message: 'The Omni connection could not be verified.',
    guidance: 'This is a legacy generic code. Check network access and include the build identifier when reporting the failure.',
  },
};

const SAFE_DIAGNOSTIC_CODE = /^[A-Z][A-Z0-9_]{2,79}$/;

export function normalizeConnectionDiagnosticCode(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const normalized = value.trim().toUpperCase();
  return SAFE_DIAGNOSTIC_CODE.test(normalized) ? normalized : undefined;
}

export function isInstanceConnectionErrorCode(value: unknown): value is InstanceConnectionErrorCode {
  const normalized = normalizeConnectionDiagnosticCode(value);
  return Boolean(normalized && Object.prototype.hasOwnProperty.call(INSTANCE_CONNECTION_DIAGNOSTICS, normalized));
}

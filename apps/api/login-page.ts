// spec: contracts/platform.contract.md#PLAT-1 — Control plane management surface
// spec: contracts/platform.contract.md#PLAT-15 — Zero raw secret leakage into server logs
// spec: tasks/milestone-0.75-backing-services-and-auth/T-0756-control-plane-login-page.md
// spec: tasks/milestone-0.8-developer-experience-ux/T-0802-login-page-callback-redirect.md

export interface LoginPageOptions {
  serviceName?: string;
  defaultOrgId?: string;
  callbackUrl?: string; // Validated loopback URL, e.g. http://127.0.0.1:54321/callback
  state?: string; // Nonce string to pass through to the callback
  orgId?: string;
}

/**
 * Validates loopback callback URL against open-redirect, SSRF, and port traversal attacks.
 * spec: tasks/milestone-0.8-developer-experience-ux/T-0802-login-page-callback-redirect.md
 */
export function isValidCallbackUrl(urlStr: string): boolean {
  try {
    const parsed = new URL(urlStr);
    // Protocol must be plain HTTP for loopback
    if (parsed.protocol !== "http:") return false;
    // Reject userinfo spoofing (e.g. http://127.0.0.1:pwd@evil.com)
    if (parsed.username !== "" || parsed.password !== "") return false;
    // Strictly restrict host to loopback addresses
    if (parsed.hostname !== "127.0.0.1" && parsed.hostname !== "localhost") {
      return false;
    }
    // Explicit port in unprivileged range required
    if (!parsed.port) return false;
    const port = parseInt(parsed.port, 10);
    if (isNaN(port) || port < 1024 || port > 65535) return false;
    // Blacklist sensitive internal database and control ports
    if (port === 5432 || port === 6379 || port === 8080 || port === 8081) {
      return false;
    }
    // Pathname must strictly be /callback with zero pre-existing search or hash
    if (parsed.pathname !== "/callback") return false;
    if (parsed.search !== "" || parsed.hash !== "") return false;

    return true;
  } catch {
    return false;
  }
}

/**
 * Renders a self-contained, responsive, dark-mode web authentication page.
 *
 * Implements the browser-based authentication flow for `rail login`.
 * Zero external CDN script or stylesheet dependencies.
 */
export function renderLoginPageHtml(options?: LoginPageOptions): string {
  const serviceName = options?.serviceName ?? "RailFog Cloud";
  const defaultOrgId = options?.orgId ?? options?.defaultOrgId ?? "default-org";

  const rawCallback = options?.callbackUrl ?? "";
  const validCallback = isValidCallbackUrl(rawCallback) ? rawCallback : "";

  // Sanitize state nonce against reflected XSS
  const rawState = options?.state ?? "";
  const safeState = /^[a-zA-Z0-9_-]{1,128}$/.test(rawState) ? rawState : "";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <meta name="referrer" content="no-referrer">
  <title>Login — ${serviceName}</title>
  <style>
    :root {
      --ink: #0B2340;
      --ink-soft: #16335C;
      --paper: #F7F9FA;
      --canvas: #EBF0F3;
      --mist: #DFE6EB;
      --line: #C9D3DB;
      --steel: #6C8194;
      --slate: #3D5266;
      --mute: #4E6274;
      --lamp: #0FB88E;
      --lamp-press: #0A9E7A;
      --lamp-tint: #C6F0E0;
      --lamp-deep: #0A6B50;
      --stop: #B3261E;
      --stop-tint: #FBE4E1;
      --font-sans: Archivo, system-ui, -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, sans-serif;
      --font-mono: "IBM Plex Mono", ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--canvas);
      color: var(--ink);
      font-family: var(--font-sans);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    .card {
      background-color: var(--paper);
      border: 1px solid var(--line);
      border-radius: 2px;
      max-width: 460px;
      width: 100%;
      padding: 2.25rem 2rem;
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 1.25rem;
    }
    .logo {
      width: 32px;
      height: 32px;
      background: var(--ink);
      border-radius: 2px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      font-family: var(--font-mono);
      font-size: 0.85rem;
      color: var(--lamp);
      letter-spacing: 0.05em;
    }
    h1 {
      font-size: 1.25rem;
      font-weight: 700;
      letter-spacing: -0.02em;
      color: var(--ink);
    }
    p.subtitle {
      color: var(--slate);
      font-size: 0.9rem;
      line-height: 1.5;
      margin-bottom: 1.5rem;
    }
    .form-group {
      margin-bottom: 1.25rem;
    }
    label {
      display: block;
      font-size: 0.75rem;
      font-weight: 600;
      text-transform: uppercase;
      letter-spacing: 0.05em;
      color: var(--slate);
      margin-bottom: 0.4rem;
    }
    input[type="text"] {
      width: 100%;
      height: 42px;
      padding: 0 0.875rem;
      background: #ffffff;
      border: 1px solid var(--line);
      border-radius: 2px;
      color: var(--ink);
      font-family: var(--font-mono);
      font-size: 0.9rem;
      outline: none;
      transition: border-color 0.15s;
    }
    input[type="text"]:focus {
      border-color: var(--ink);
    }
    .btn {
      width: 100%;
      height: 44px;
      padding: 0 1rem;
      background: var(--ink);
      color: var(--paper);
      border: none;
      border-radius: 2px;
      font-weight: 600;
      font-size: 0.95rem;
      cursor: pointer;
      transition: background 0.15s;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }
    .btn:hover {
      background: var(--ink-soft);
    }
    .btn-authorize {
      background: var(--lamp);
      color: var(--ink);
      font-weight: 700;
      margin-top: 0.75rem;
    }
    .btn-authorize:hover {
      background: var(--lamp-press);
    }
    .key-box {
      margin-top: 1.5rem;
      padding: 1.25rem;
      background: var(--mist);
      border: 1px solid var(--line);
      border-radius: 2px;
      display: none;
    }
    .key-display {
      font-family: var(--font-mono);
      font-size: 0.85rem;
      padding: 0.75rem;
      background: #ffffff;
      border: 1px solid var(--line);
      border-radius: 2px;
      word-break: break-all;
      margin: 0.75rem 0;
      color: var(--ink);
    }
    .btn-copy {
      background: var(--paper);
      color: var(--ink);
      border: 1px solid var(--line);
      padding: 0.65rem 1rem;
      font-size: 0.85rem;
      width: 100%;
      border-radius: 2px;
      cursor: pointer;
      font-weight: 600;
      transition: border-color 0.15s;
    }
    .btn-copy:hover {
      border-color: var(--steel);
    }
    .steps {
      margin-top: 1.25rem;
      font-size: 0.825rem;
      color: var(--slate);
      line-height: 1.6;
    }
    .steps ol {
      margin-left: 1.2rem;
      margin-top: 0.25rem;
    }
    .badge {
      display: inline-flex;
      align-items: center;
      gap: 4px;
      padding: 0.2rem 0.5rem;
      background: var(--lamp-tint);
      color: var(--lamp-deep);
      border: 1px solid var(--lamp);
      font-size: 0.75rem;
      border-radius: 2px;
      font-weight: 600;
    }
    .callback-notice {
      background: var(--lamp-tint);
      border: 1px solid var(--lamp);
      border-radius: 2px;
      padding: 0.65rem 0.85rem;
      font-size: 0.82rem;
      color: var(--lamp-deep);
      margin-bottom: 1.25rem;
      font-weight: 500;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <div class="logo">RF</div>
      <h1>${serviceName}</h1>
    </div>
    
    ${
    validCallback
      ? `<div class="callback-notice">🔗 Terminal CLI session detected. Click below to authorize directly.</div>`
      : ""
  }

    <p class="subtitle">Authenticate your session by generating an API key for your RailFog CLI.</p>

    <div id="setup-view">
      <div class="form-group">
        <label for="orgId">Organization Account</label>
        <input type="text" id="orgId" value="${defaultOrgId}" placeholder="orgId">
      </div>
      <div class="form-group">
        <label for="keyName">Key Label</label>
        <input type="text" id="keyName" value="cli-session" placeholder="e.g. dev-laptop">
      </div>
      <button class="btn" id="generate-btn" onclick="generateApiKey()">
        ${validCallback ? "🚀 Authorize CLI in Terminal" : "Generate API Key"}
      </button>
    </div>

    <div class="key-box" id="key-box">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-weight:600; font-size:0.9rem;">Your API Key</span>
        <span class="badge" id="status-badge">Ready</span>
      </div>
      <div class="key-display" id="key-text"></div>
      
      ${
    validCallback
      ? `
      <button class="btn btn-authorize" id="authorize-btn" onclick="authorizeCli()">
        🚀 Authorize CLI in Terminal
      </button>
      <div style="margin: 0.75rem 0; text-align: center; font-size: 0.8rem; color: var(--muted);">— or copy manually —</div>
      `
      : ""
  }

      <button class="btn-copy" id="copy-btn" onclick="copyKey()">
        📋 Copy API Key
      </button>

      <div class="steps">
        <strong>Next Steps:</strong>
        <ol>
          ${
    validCallback
      ? `
          <li>Click <strong>Authorize CLI in Terminal</strong> to log in automatically.</li>
          <li>Or copy the key and paste into your terminal manually.</li>
          `
      : `
          <li>Click <strong>Copy API Key</strong> above.</li>
          <li>Return to your terminal window.</li>
          <li>Paste the key into the prompt and press <strong>Enter</strong>.</li>
          `
  }
        </ol>
      </div>
    </div>
  </div>

  <script>
    let activeKey = "";
    let selectedOrgId = "";
    let selectedKeyName = "";
    const CALLBACK_URL = ${JSON.stringify(validCallback)};
    const STATE_NONCE = ${JSON.stringify(safeState)};

    async function generateApiKey() {
      const orgId = document.getElementById("orgId").value.trim() || "${defaultOrgId}";
      const keyName = document.getElementById("keyName").value.trim() || "cli-session";
      selectedOrgId = orgId;
      selectedKeyName = keyName;
      const btn = document.getElementById("generate-btn");
      btn.disabled = true;
      btn.innerText = "Generating...";

      try {
        const res = await fetch("/v1/auth/keys", {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ orgId, name: keyName })
        });
        const data = await res.json();
        if (data.rawToken) {
          activeKey = data.rawToken;
          document.getElementById("key-text").innerText = activeKey;
          document.getElementById("key-box").style.display = "block";
          document.getElementById("setup-view").style.display = "none";
          // Copy to clipboard
          copyKey();
          // 1-Click zero-copy flow: automatically redirect if terminal callback URL and state are present
          if (CALLBACK_URL && STATE_NONCE) {
            authorizeCli();
          }
        } else {
          alert("Failed to generate key: " + (data.error?.message || "Unknown error"));
          btn.disabled = false;
          btn.innerText = "Generate API Key";
        }
      } catch (err) {
        alert("Network error contacting control plane.");
        btn.disabled = false;
        btn.innerText = "Generate API Key";
      }
    }

    function authorizeCli() {
      if (!activeKey || !CALLBACK_URL) return;
      if (!STATE_NONCE) {
        alert("Session state is missing from URL. Please copy your API key and paste it into your terminal manually.");
        return;
      }
      let target = CALLBACK_URL + "?token=" + encodeURIComponent(activeKey) + "&state=" + encodeURIComponent(STATE_NONCE);
      if (selectedOrgId) {
        target += "&orgId=" + encodeURIComponent(selectedOrgId);
      }
      if (selectedKeyName) {
        target += "&keyName=" + encodeURIComponent(selectedKeyName);
      }
      // Use window.location.replace to prevent storing token in browser back-button history (PLAT-15)
      window.location.replace(target);
    }

    async function copyKey() {
      if (!activeKey) return;
      try {
        await navigator.clipboard.writeText(activeKey);
        const copyBtn = document.getElementById("copy-btn");
        copyBtn.innerText = "✓ Copied to Clipboard!";
        copyBtn.style.borderColor = "var(--success)";
        copyBtn.style.color = "var(--success)";
        setTimeout(() => {
          copyBtn.innerText = "📋 Copy API Key";
          copyBtn.style.borderColor = "#334155";
          copyBtn.style.color = "#e2e8f0";
        }, 3000);
      } catch (e) {
        // Clipboard API may be restricted in some browsers
      }
    }
  </script>
</body>
</html>`;
}

export const renderLoginPage = renderLoginPageHtml;

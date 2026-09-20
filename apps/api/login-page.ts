// spec: contracts/platform.contract.md#PLAT-1 — Control plane management surface
// spec: contracts/platform.contract.md#PLAT-15 — Zero raw secret leakage into server logs
// spec: tasks/milestone-0.75-backing-services-and-auth/T-0756-control-plane-login-page.md

export interface LoginPageOptions {
  serviceName?: string;
  defaultOrgId?: string;
}

/**
 * Renders a self-contained, responsive, dark-mode web authentication page.
 *
 * Implements the browser-based authentication flow for `rail login`.
 * Zero external CDN script or stylesheet dependencies.
 */
export function renderLoginPageHtml(options?: LoginPageOptions): string {
  const serviceName = options?.serviceName ?? "RailFog Cloud";
  const defaultOrgId = options?.defaultOrgId ?? "default-org";

  return `<!DOCTYPE html>
<html lang="en">
<head>
  <meta charset="UTF-8">
  <meta name="viewport" content="width=device-width, initial-scale=1.0">
  <title>Login — ${serviceName}</title>
  <style>
    :root {
      --bg: #090a0f;
      --card-bg: #12141c;
      --border: #222634;
      --text: #f0f3f8;
      --muted: #8b949e;
      --accent: #3b82f6;
      --accent-hover: #2563eb;
      --success: #10b981;
      --font-sans: -apple-system, BlinkMacSystemFont, "Segoe UI", Roboto, Helvetica, Arial, sans-serif;
      --font-mono: ui-monospace, SFMono-Regular, Menlo, Monaco, Consolas, monospace;
    }
    * { box-sizing: border-box; margin: 0; padding: 0; }
    body {
      background-color: var(--bg);
      color: var(--text);
      font-family: var(--font-sans);
      min-height: 100vh;
      display: flex;
      align-items: center;
      justify-content: center;
      padding: 1.5rem;
    }
    .card {
      background-color: var(--card-bg);
      border: 1px solid var(--border);
      border-radius: 12px;
      max-width: 480px;
      width: 100%;
      padding: 2.5rem 2rem;
      box-shadow: 0 10px 25px rgba(0,0,0,0.5);
    }
    .brand {
      display: flex;
      align-items: center;
      gap: 0.75rem;
      margin-bottom: 1.5rem;
    }
    .logo {
      width: 32px;
      height: 32px;
      background: linear-gradient(135deg, var(--accent), #8b5cf6);
      border-radius: 8px;
      display: flex;
      align-items: center;
      justify-content: center;
      font-weight: 700;
      color: #fff;
    }
    h1 {
      font-size: 1.35rem;
      font-weight: 600;
      letter-spacing: -0.02em;
    }
    p.subtitle {
      color: var(--muted);
      font-size: 0.9rem;
      line-height: 1.4;
      margin-bottom: 1.75rem;
    }
    .form-group {
      margin-bottom: 1.25rem;
    }
    label {
      display: block;
      font-size: 0.825rem;
      font-weight: 500;
      color: var(--muted);
      margin-bottom: 0.5rem;
    }
    input[type="text"] {
      width: 100%;
      padding: 0.75rem 1rem;
      background: #0d0f17;
      border: 1px solid var(--border);
      border-radius: 6px;
      color: var(--text);
      font-family: var(--font-sans);
      font-size: 0.95rem;
      outline: none;
      transition: border-color 0.2s;
    }
    input[type="text"]:focus {
      border-color: var(--accent);
    }
    .btn {
      width: 100%;
      padding: 0.75rem 1rem;
      background: var(--accent);
      color: #fff;
      border: none;
      border-radius: 6px;
      font-weight: 600;
      font-size: 0.95rem;
      cursor: pointer;
      transition: background 0.2s;
      display: flex;
      align-items: center;
      justify-content: center;
      gap: 0.5rem;
    }
    .btn:hover {
      background: var(--accent-hover);
    }
    .key-box {
      margin-top: 1.5rem;
      padding: 1.25rem;
      background: #0a0c12;
      border: 1px dashed var(--accent);
      border-radius: 8px;
      display: none;
    }
    .key-display {
      font-family: var(--font-mono);
      font-size: 0.85rem;
      padding: 0.65rem;
      background: #000;
      border: 1px solid var(--border);
      border-radius: 4px;
      word-break: break-all;
      margin: 0.75rem 0;
      color: #a7f3d0;
    }
    .btn-copy {
      background: #1e293b;
      color: #e2e8f0;
      border: 1px solid #334155;
      padding: 0.5rem 1rem;
      font-size: 0.85rem;
      width: 100%;
      border-radius: 4px;
      cursor: pointer;
      font-weight: 500;
    }
    .btn-copy:hover {
      background: #334155;
    }
    .steps {
      margin-top: 1.25rem;
      font-size: 0.825rem;
      color: var(--muted);
      line-height: 1.6;
    }
    .steps ol {
      margin-left: 1.2rem;
      margin-top: 0.25rem;
    }
    .badge {
      display: inline-block;
      padding: 0.2rem 0.5rem;
      background: rgba(16, 185, 129, 0.15);
      color: var(--success);
      font-size: 0.75rem;
      border-radius: 4px;
      font-weight: 600;
    }
  </style>
</head>
<body>
  <div class="card">
    <div class="brand">
      <div class="logo">RF</div>
      <h1>${serviceName}</h1>
    </div>
    <p class="subtitle">Authenticate your terminal session by generating an API key and pasting it into your CLI prompt.</p>

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
        Generate API Key
      </button>
    </div>

    <div class="key-box" id="key-box">
      <div style="display:flex; justify-content:space-between; align-items:center;">
        <span style="font-weight:600; font-size:0.9rem;">Your API Key</span>
        <span class="badge" id="status-badge">Ready</span>
      </div>
      <div class="key-display" id="key-text"></div>
      <button class="btn-copy" id="copy-btn" onclick="copyKey()">
        📋 Copy API Key
      </button>

      <div class="steps">
        <strong>Next Steps:</strong>
        <ol>
          <li>Click <strong>Copy API Key</strong> above.</li>
          <li>Return to your terminal window.</li>
          <li>Paste the key into the prompt and press <strong>Enter</strong>.</li>
        </ol>
      </div>
    </div>
  </div>

  <script>
    let activeKey = "";

    async function generateApiKey() {
      const orgId = document.getElementById("orgId").value || "${defaultOrgId}";
      const keyName = document.getElementById("keyName").value || "cli-session";
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
          // Automatically try to copy immediately
          copyKey();
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

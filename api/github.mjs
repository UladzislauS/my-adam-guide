/* "Sign in with GitHub" for the guide editor (/admin), as a Vercel serverless function.
 *
 * It uses a GitHub App installed only on this site's repository, so a signed-in token can at most
 * read and write that repository's contents, and only if the person signing in may edit it.
 * The tokens live in HttpOnly cookies; the editor only ever gets a short-lived access token.
 *
 *   GET  /api/github?step=login    → redirects to GitHub's sign-in page
 *   GET  /api/github?code=…        → GitHub sends the person back here (the App's callback URL)
 *   POST /api/github?step=token    → { token, expiresAt, login, repo, branch } or 401 when signed out
 *   POST /api/github?step=logout   → signs out
 *
 * Environment variables (Vercel → Project → Settings → Environment Variables):
 *   GITHUB_CLIENT_ID, GITHUB_CLIENT_SECRET   from the GitHub App
 *   GUIDE_REPO   optional, "owner/name"; defaults to the repo Vercel deploys from
 *   GUIDE_BRANCH optional, defaults to "main"
 */

const COOKIE_PATH = "/api/github";
const HALF_YEAR = 180 * 24 * 3600;

export default async function handler(req, res) {
  res.setHeader("Cache-Control", "no-store");
  const env = process.env;
  const clientId = env.GITHUB_CLIENT_ID;
  const secret = env.GITHUB_CLIENT_SECRET;
  if (!clientId || !secret) return json(res, 501, { error: "not_configured" });

  const proto = String(req.headers["x-forwarded-proto"] || "https").split(",")[0];
  const origin = `${proto}://${req.headers.host}`;
  const url = new URL(req.url, origin);
  const callback = origin + COOKIE_PATH;
  const cookies = parseCookies(req.headers.cookie);
  const step = url.searchParams.get("step");
  const out = []; // Set-Cookie headers

  try {
    /* 1. Start: send the person to GitHub */
    if (step === "login") {
      const state = crypto.randomUUID();
      out.push(cookie("gh_state", state, 600));
      const to = new URL("https://github.com/login/oauth/authorize");
      to.search = new URLSearchParams({ client_id: clientId, redirect_uri: callback, state });
      return redirect(res, to.toString(), out);
    }

    /* 2. GitHub sends them back with a one-time code */
    if (url.searchParams.has("code") || url.searchParams.has("error")) {
      out.push(cookie("gh_state", "", 0));
      const state = url.searchParams.get("state");
      if (url.searchParams.has("error") || !state || state !== cookies.gh_state) {
        return redirect(res, "/admin?signin=failed", out);
      }
      const t = await exchange({ client_id: clientId, client_secret: secret, code: url.searchParams.get("code"), redirect_uri: callback });
      if (!t.access_token) return redirect(res, "/admin?signin=failed", out);
      const user = await fetch("https://api.github.com/user", {
        headers: { Authorization: `Bearer ${t.access_token}`, Accept: "application/vnd.github+json", "User-Agent": "city-guide-editor" },
      }).then((r) => (r.ok ? r.json() : {}));
      session(out, t, user.login || "");
      return redirect(res, "/admin", out);
    }

    /* 3. The editor asks for a usable token (refreshing it when it's about to expire) */
    if (step === "token" && req.method === "POST") {
      let token = cookies.gh_at;
      let expiresAt = Number(cookies.gh_exp) || null;
      if (!token || (expiresAt && expiresAt - Date.now() < 5 * 60e3)) {
        if (!cookies.gh_rt) return json(res, 401, { error: "signed_out" }, clear(out));
        const t = await exchange({ client_id: clientId, client_secret: secret, grant_type: "refresh_token", refresh_token: cookies.gh_rt });
        if (!t.access_token) return json(res, 401, { error: "signed_out" }, clear(out));
        expiresAt = session(out, t, cookies.gh_user || "");
        token = t.access_token;
      }
      const repo = env.GUIDE_REPO || (env.VERCEL_GIT_REPO_OWNER && env.VERCEL_GIT_REPO_SLUG
        ? `${env.VERCEL_GIT_REPO_OWNER}/${env.VERCEL_GIT_REPO_SLUG}` : null);
      return json(res, 200, { token, expiresAt, login: cookies.gh_user || null, repo, branch: env.GUIDE_BRANCH || "main" }, out);
    }

    /* 4. Sign out: revoke the token at GitHub (best effort) and forget it */
    if (step === "logout" && req.method === "POST") {
      if (cookies.gh_at) {
        await fetch(`https://api.github.com/applications/${clientId}/token`, {
          method: "DELETE",
          headers: {
            Authorization: "Basic " + Buffer.from(`${clientId}:${secret}`).toString("base64"),
            Accept: "application/vnd.github+json",
            "User-Agent": "city-guide-editor",
          },
          body: JSON.stringify({ access_token: cookies.gh_at }),
        }).catch(() => {});
      }
      return json(res, 200, { ok: true }, clear(out));
    }

    return json(res, 400, { error: "unknown_step" });
  } catch (e) {
    return json(res, 502, { error: "github_unreachable", message: String(e.message || e) }, out);
  }
}

async function exchange(params) {
  const r = await fetch("https://github.com/login/oauth/access_token", {
    method: "POST",
    headers: { Accept: "application/json", "Content-Type": "application/x-www-form-urlencoded", "User-Agent": "city-guide-editor" },
    body: new URLSearchParams(params),
  });
  return r.ok ? r.json() : {};
}

// Stores a fresh token set. GitHub App tokens normally last 8 hours and come with a 6-month refresh token;
// if the App has expiring tokens turned off there's no refresh token and the access token simply lasts.
function session(out, t, login) {
  const life = t.expires_in ? Math.max(60, t.expires_in - 600) : HALF_YEAR;
  const expiresAt = t.expires_in ? Date.now() + life * 1000 : 0;
  out.push(cookie("gh_at", t.access_token, life));
  out.push(cookie("gh_exp", String(expiresAt), life));
  if (t.refresh_token) out.push(cookie("gh_rt", t.refresh_token, t.refresh_token_expires_in || HALF_YEAR));
  if (login) out.push(cookie("gh_user", login, HALF_YEAR));
  return expiresAt || null;
}
function clear(out) {
  for (const name of ["gh_at", "gh_exp", "gh_rt", "gh_user", "gh_state"]) out.push(cookie(name, "", 0));
  return out;
}

function cookie(name, value, maxAge) {
  return `${name}=${encodeURIComponent(value)}; Path=${COOKIE_PATH}; Max-Age=${maxAge}; HttpOnly; Secure; SameSite=Lax`;
}
function parseCookies(header = "") {
  const out = {};
  for (const part of header.split(";")) {
    const i = part.indexOf("=");
    if (i > 0) {
      try { out[part.slice(0, i).trim()] = decodeURIComponent(part.slice(i + 1).trim()); } catch { /* skip bad cookie */ }
    }
  }
  return out;
}
function json(res, status, body, cookies = []) {
  if (cookies.length) res.setHeader("Set-Cookie", cookies);
  res.statusCode = status;
  res.setHeader("Content-Type", "application/json");
  res.end(JSON.stringify(body));
}
function redirect(res, location, cookies = []) {
  if (cookies.length) res.setHeader("Set-Cookie", cookies);
  res.statusCode = 302;
  res.setHeader("Location", location);
  res.end();
}

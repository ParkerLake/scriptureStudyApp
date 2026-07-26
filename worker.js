/**
 * Cloudflare Worker: GitHub sync proxy for the Book of Mormon Study app.
 *
 * Holds your GitHub personal access token as a server-side secret so it
 * never has to live in the browser. The app talks to this Worker with a
 * short passcode instead; the Worker is the only thing that ever talks to
 * GitHub.
 *
 * Deploy: paste this file into a new Worker (Cloudflare dashboard ->
 * Workers & Pages -> Create -> paste into the Quick Edit editor -> Deploy),
 * then set these under Settings -> Variables and Secrets for the Worker:
 *
 *   GITHUB_TOKEN   (secret)  - fine-grained PAT, Contents: Read and write,
 *                              scoped to just your repo
 *   APP_PASSCODE   (secret)  - a passcode you make up; the app sends this
 *                              back on every request
 *   GITHUB_OWNER   (var)     - your GitHub username
 *   GITHUB_REPO    (var)     - e.g. scriptureStudyApp
 *   GITHUB_PATH    (var)     - e.g. data/study-data.json
 *   ALLOWED_ORIGIN (var, optional) - your GitHub Pages origin, e.g.
 *                              https://yourname.github.io
 *                              (omit to allow any origin)
 */

export default {
  async fetch(request, env) {
    const corsHeaders = {
      'Access-Control-Allow-Origin': env.ALLOWED_ORIGIN || '*',
      'Access-Control-Allow-Methods': 'GET, PUT, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, X-Passcode',
    };

    if (request.method === 'OPTIONS') {
      return new Response(null, { headers: corsHeaders });
    }

    const url = new URL(request.url);
    if (url.pathname !== '/data') {
      return new Response('Not found', { status: 404, headers: corsHeaders });
    }

    const passcode = request.headers.get('X-Passcode');
    if (!env.APP_PASSCODE || !passcode || passcode !== env.APP_PASSCODE) {
      return new Response('Unauthorized', { status: 401, headers: corsHeaders });
    }

    if (!env.GITHUB_TOKEN || !env.GITHUB_OWNER || !env.GITHUB_REPO || !env.GITHUB_PATH) {
      return new Response('Worker is missing required configuration.', { status: 500, headers: corsHeaders });
    }

    const ghUrl = `https://api.github.com/repos/${env.GITHUB_OWNER}/${env.GITHUB_REPO}/contents/${env.GITHUB_PATH}`;
    const ghHeaders = {
      Authorization: `token ${env.GITHUB_TOKEN}`,
      Accept: 'application/vnd.github+json',
      'User-Agent': 'bom-study-worker',
    };

    try {
      if (request.method === 'GET') {
        const res = await fetch(ghUrl, { headers: ghHeaders });
        if (res.status === 404) {
          return json({ notFound: true }, 200, corsHeaders);
        }
        if (!res.ok) {
          return new Response(await res.text(), { status: res.status, headers: corsHeaders });
        }
        const body = await res.json();
        const content = b64DecodeUnicode(body.content);
        return new Response(content, { status: 200, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
      }

      if (request.method === 'PUT') {
        const incoming = await request.text();
        let sha;
        const head = await fetch(ghUrl, { headers: ghHeaders });
        if (head.ok) {
          const headJson = await head.json();
          sha = headJson.sha;
        } else if (head.status !== 404) {
          return new Response(await head.text(), { status: head.status, headers: corsHeaders });
        }

        const putBody = {
          message: 'Update study data — ' + new Date().toISOString(),
          content: b64EncodeUnicode(incoming),
        };
        if (sha) putBody.sha = sha;

        const putRes = await fetch(ghUrl, {
          method: 'PUT',
          headers: { ...ghHeaders, 'Content-Type': 'application/json' },
          body: JSON.stringify(putBody),
        });
        if (!putRes.ok) {
          return new Response(await putRes.text(), { status: putRes.status, headers: corsHeaders });
        }
        return json({ ok: true }, 200, corsHeaders);
      }

      return new Response('Method not allowed', { status: 405, headers: corsHeaders });
    } catch (err) {
      return new Response('Worker error: ' + err.message, { status: 500, headers: corsHeaders });
    }
  },
};

function json(obj, status, corsHeaders) {
  return new Response(JSON.stringify(obj), { status, headers: { ...corsHeaders, 'Content-Type': 'application/json' } });
}

function b64EncodeUnicode(str) {
  const bytes = new TextEncoder().encode(str);
  let binary = '';
  bytes.forEach((b) => (binary += String.fromCharCode(b)));
  return btoa(binary);
}

function b64DecodeUnicode(b64) {
  const binary = atob(b64.replace(/\n/g, ''));
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

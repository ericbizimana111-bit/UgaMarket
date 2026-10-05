/**
 * Storefront ↔ backend route contract.
 *
 * Parses the backend's ACTUAL route registrations (backend/src/app.js mounts +
 * each router's method/path) and requires every API call in frontend/src to
 * hit a real route with the same method. Catches path drift (a renamed or
 * removed endpoint, a typo, a wrong HTTP method) before it reaches customers.
 *
 * Scanned call shapes:
 *   apiClient.get('/path')            incl. multi-line `apiClient\n  .get(...)`
 *   apiClient.post(`/x/${id}/y?q=1`)  template literals (interpolations = params)
 *   const endpoint = cond ? `/a/${x}` : `/b`;  apiClient.get(endpoint)
 *   new EventSource(`${API_BASE}/realtime/stream?...`)
 */
const fs = require('fs');
const path = require('path');

const FRONTEND_SRC = path.resolve(__dirname, '..');
const BACKEND_SRC = path.resolve(__dirname, '..', '..', '..', 'backend', 'src');

function walk(dir, exts, acc = []) {
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    if (entry.isDirectory()) walk(full, exts, acc);
    else if (exts.some((e) => entry.name.endsWith(e)) && !entry.name.includes('.test.')) acc.push(full);
  }
  return acc;
}

function extractBackendRoutes() {
  const appJs = fs.readFileSync(path.join(BACKEND_SRC, 'app.js'), 'utf8');
  const mounts = [...appJs.matchAll(/app\.use\('([^']+)',\s*(?:[\w$]+,\s*)?(\w+)\)/g)]
    .filter((m) => m[1].startsWith('/api'))
    .map((m) => ({ mount: m[1].replace(/\/$/, ''), routerVar: m[2] }));

  const resolveFile = (spec) => {
    const resolved = path.join(BACKEND_SRC, spec);
    if (fs.existsSync(resolved + '.js')) return resolved + '.js';
    return fs.existsSync(resolved) ? resolved : null;
  };
  const bindings = {};
  for (const m of appJs.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*require\(['"]([^'"]*routes[^'"]*)['"]\)/g)) {
    const file = resolveFile(m[2]);
    if (file) bindings[m[1]] = { file, exportName: null };
  }
  for (const m of appJs.matchAll(/(?:const|let|var)\s+\{([^}]+)\}\s*=\s*require\(['"]([^'"]*routes[^'"]*)['"]\)/g)) {
    const file = resolveFile(m[2]);
    if (!file) continue;
    for (const name of m[1].split(',').map((s) => s.trim()).filter(Boolean)) {
      const [exported, local] = name.split(':').map((s) => s.trim());
      bindings[local || exported] = { file, exportName: exported };
    }
  }

  const routes = [];
  for (const { mount, routerVar } of mounts) {
    const binding = bindings[routerVar];
    if (!binding) continue;
    const src = fs.readFileSync(binding.file, 'utf8');
    let locals = [...src.matchAll(/(?:const|let|var)\s+(\w+)\s*=\s*express\.Router\(\)/g)].map((m) => m[1]);
    if (binding.exportName) {
      const block = src.match(/module\.exports\s*=\s*\{([^}]+)\}/);
      const pair =
        block &&
        block[1]
          .split(',')
          .map((s) => s.trim().split(':').map((x) => x.trim()))
          .find(([key]) => key === binding.exportName);
      locals = pair ? [pair[1] || pair[0]] : [];
    }
    for (const local of locals) {
      const re = new RegExp(`\\b${local}\\.(get|post|put|patch|delete)\\(\\s*'([^']+)'`, 'g');
      for (const m of src.matchAll(re)) {
        routes.push({ method: m[1].toUpperCase(), template: (mount + (m[2] === '/' ? '' : m[2])).replace(/\/+$/, '') || mount });
      }
    }
  }
  return routes;
}

/** '/orders/${id}/payment?x=1' -> ['', 'api', 'orders', ':param', 'payment'] */
function toSegments(rawPath) {
  const withBase = rawPath.startsWith('/api') ? rawPath : `/api${rawPath}`;
  return withBase
    .replace(/\$\{[^}]+\}/g, ':param')
    .split('?')[0]
    .replace(/\/+$/, '')
    .split('/');
}

function collectCalls() {
  const calls = [];
  for (const file of walk(FRONTEND_SRC, ['.js', '.jsx'])) {
    const src = fs.readFileSync(file, 'utf8');
    const rel = path.relative(FRONTEND_SRC, file);
    for (const m of src.matchAll(/\b(?:apiClient|api)\s*\.\s*(get|post|put|patch|delete)\s*\(\s*(['"`])(\/[^'"`]*)\2/g)) {
      calls.push({ file: rel, method: m[1].toUpperCase(), rawPath: m[3] });
    }
    for (const m of src.matchAll(/\bendpoint\s*=\s*([^;]+);/g)) {
      for (const lit of m[1].matchAll(/(['"`])(\/[^'"`]*)\1/g)) calls.push({ file: rel, method: 'GET', rawPath: lit[2] });
    }
    for (const m of src.matchAll(/EventSource\(\s*`\$\{API_BASE\}(\/[^`?]*)/g)) {
      calls.push({ file: rel, method: 'GET', rawPath: m[1] });
    }
  }
  return calls;
}

describe('storefront ↔ backend route contract', () => {
  const routes = extractBackendRoutes();
  const calls = collectCalls();

  test('the extraction itself found the backend and the storefront calls', () => {
    const t = routes.map((r) => `${r.method} ${r.template}`);
    expect(t).toEqual(expect.arrayContaining(['POST /api/orders', 'GET /api/store', 'POST /api/checkout/preview', 'GET /api/realtime/stream']));
    expect(calls.length).toBeGreaterThanOrEqual(40);
  });

  test('every storefront API call maps to a real backend route', () => {
    const offenders = calls.filter(({ method, rawPath }) => {
      const c = toSegments(rawPath);
      return !routes.some((r) => {
        if (r.method !== method) return false;
        const t = r.template.split('/');
        return t.length === c.length && c.every((seg, i) => seg === t[i] || seg === ':param' || t[i].startsWith(':'));
      });
    });
    expect(offenders.map((o) => `${o.file}: ${o.method} ${o.rawPath}`)).toEqual([]);
  });
});

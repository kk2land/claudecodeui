import assert from 'node:assert/strict';
import fs from 'node:fs';
import http from 'node:http';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';

import express from 'express';

import {
  applyStaticAssetCacheHeaders,
  createStaticAssetsMiddleware,
} from '../static-assets.service.js';

function headersFor(filePath: string): Record<string, string> {
  const headers: Record<string, string> = {};
  applyStaticAssetCacheHeaders(
    {
      setHeader: (name: string, value: string | number | readonly string[]) => {
        headers[name] = String(value);
      },
    } as unknown as http.ServerResponse,
    filePath,
  );
  return headers;
}

test('HTML documents are never stored', () => {
  for (const filePath of ['/app/dist/index.html', '/app/public/api-docs.html']) {
    const headers = headersFor(filePath);
    assert.match(headers['Cache-Control'], /no-store/);
    assert.equal(headers.Pragma, 'no-cache');
    assert.equal(headers.Expires, '0');
  }
});

test('the service worker is revalidated from either serving directory', () => {
  // Installed npm packages ship `dist/`, not `public/`, so both copies matter.
  for (const filePath of ['/app/public/sw.js', '/app/dist/sw.js', '/app/dist/service-worker.js']) {
    const headers = headersFor(filePath);
    assert.equal(headers['Cache-Control'], 'no-cache');
    assert.doesNotMatch(headers['Cache-Control'], /immutable/);
    assert.doesNotMatch(headers['Cache-Control'], /max-age=[1-9]/);
  }
});

test('content-hashed build assets are immutable for a year', () => {
  for (const filePath of [
    '/app/dist/assets/index-Ca8xYz12.js',
    '/app/dist/assets/vendor-react-Dq7l2mNp.js',
    '/app/dist/assets/index-AbCdEf12.css',
    '/app/dist/assets/logo-B1c2D3e4.woff2',
  ]) {
    assert.equal(headersFor(filePath)['Cache-Control'], 'public, max-age=31536000, immutable');
  }
});

test('non-hashed public files revalidate instead of being immutable or never cached', () => {
  for (const filePath of [
    '/app/dist/manifest.json',
    '/app/dist/logo-256.png',
    '/app/dist/icons/icon-192x192.png',
    '/app/public/favicon.svg',
    '/app/dist/assets/logo-128.png',
  ]) {
    assert.equal(headersFor(filePath)['Cache-Control'], 'no-cache', filePath);
  }
});

type TestServer = { baseUrl: string; close: () => Promise<void> };

async function startServer(application: express.Express): Promise<TestServer> {
  const server = http.createServer(application);
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const address = server.address();
  assert.ok(address && typeof address === 'object');
  return {
    baseUrl: `http://127.0.0.1:${address.port}`,
    close: () => new Promise<void>((resolve, reject) => server.close((error) => (error ? reject(error) : resolve()))),
  };
}

function httpGet(url: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: http.IncomingHttpHeaders }> {
  return new Promise((resolve, reject) => {
    const request = http.get(url, { headers }, (response) => {
      response.resume();
      response.on('end', () => resolve({ status: response.statusCode ?? 0, headers: response.headers }));
    });
    request.on('error', reject);
    request.setTimeout(5000, () => request.destroy(new Error(`request timed out: ${url}`)));
  });
}

function writeFile(root: string, relativePath: string, contents: string | Buffer): void {
  const filePath = path.join(root, relativePath);
  fs.mkdirSync(path.dirname(filePath), { recursive: true });
  fs.writeFileSync(filePath, contents);
}

function createApplication(publicDirectory: string, distDirectory: string): express.Express {
  const application = express();
  application.use(createStaticAssetsMiddleware({ publicDirectory, distDirectory }));
  // Mirrors the SPA fallback in server/index.ts: files with an extension 404, every
  // other path returns the current dist/index.html.
  application.get('*', (request, response) => {
    if (path.extname(request.path)) {
      response.status(404).send('Not found');
      return;
    }
    const indexPath = path.join(distDirectory, 'index.html');
    if (!fs.existsSync(indexPath)) {
      response.status(404).send('Not built');
      return;
    }
    applyStaticAssetCacheHeaders(response, indexPath);
    response.sendFile(indexPath);
  });
  return application;
}

test('HTTP responses: hashed assets cached, everything else revalidated, build A/B switches index', { timeout: 20000 }, async (t) => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'cloudcli-cache-'));
  const publicDirectory = path.join(root, 'public');
  const distDirectory = path.join(root, 'dist');

  try {
    // Build A.
    writeFile(publicDirectory, 'sw.js', '// service worker v1');
    writeFile(publicDirectory, 'manifest.json', '{"name":"CloudCLI UI"}');
    writeFile(publicDirectory, 'logo-256.png', Buffer.from([0x89, 0x50, 0x4e, 0x47, 1]));
    writeFile(distDirectory, 'index.html', '<!doctype html><script src="/assets/index-AAAA1111.js"></script>build-a');
    writeFile(distDirectory, 'assets/index-AAAA1111.js', 'console.log("build a")');

    const application = createApplication(publicDirectory, distDirectory);
    const server = await startServer(application);
    t.after(() => server.close());

    const get = (requestPath: string, headers?: Record<string, string>) =>
      fetch(`${server.baseUrl}${requestPath}`, { headers, redirect: 'manual' });

    const indexResponse = await get('/index.html');
    assert.equal(indexResponse.status, 200);
    assert.match(indexResponse.headers.get('cache-control') ?? '', /no-store/);

    // SPA navigation fallback serves the current document and is never cacheable.
    const spaResponse = await get('/session/12345678');
    assert.equal(spaResponse.status, 200);
    assert.match(spaResponse.headers.get('cache-control') ?? '', /no-store/);
    assert.match(await spaResponse.text(), /build-a/);

    // Build A's hashed bundle is immutable.
    const assetResponse = await get('/assets/index-AAAA1111.js');
    assert.equal(assetResponse.status, 200);
    assert.equal(assetResponse.headers.get('cache-control'), 'public, max-age=31536000, immutable');

    // The worker script and the PWA manifest must stay revalidatable, even though the
    // manifest is a `.json` and sw.js is a `.js` file.
    for (const requestPath of ['/sw.js', '/manifest.json']) {
      const response = await get(requestPath);
      assert.equal(response.status, 200, requestPath);
      assert.equal(response.headers.get('cache-control'), 'no-cache', requestPath);
    }

    // Revalidation: an unchanged non-hashed file answers 304 instead of re-downloading.
    const iconFirst = await httpGet(`${server.baseUrl}/logo-256.png`);
    assert.equal(iconFirst.status, 200);
    assert.equal(iconFirst.headers['cache-control'], 'no-cache');
    assert.ok(iconFirst.headers.etag);
    const iconSecond = await httpGet(`${server.baseUrl}/logo-256.png`, {
      'If-None-Match': String(iconFirst.headers.etag),
    });
    assert.equal(iconSecond.status, 304);

    // Rebuild (B): the HTML changes, the old hashed asset no longer exists, and the new
    // hashed asset is immutable under its new name.
    fs.rmSync(path.join(distDirectory, 'assets/index-AAAA1111.js'));
    writeFile(distDirectory, 'assets/index-BBBB2222.js', 'console.log("build b")');
    writeFile(distDirectory, 'index.html', '<!doctype html><script src="/assets/index-BBBB2222.js"></script>build-b');

    const rebuiltNavigation = await get('/session/12345678');
    assert.match(rebuiltNavigation.headers.get('cache-control') ?? '', /no-store/);
    assert.match(await rebuiltNavigation.text(), /build-b/);
    assert.match(await (await get('/')).text(), /build-b/);

    assert.equal((await get('/assets/index-AAAA1111.js')).status, 404);
    const newAsset = await get('/assets/index-BBBB2222.js');
    assert.equal(newAsset.headers.get('cache-control'), 'public, max-age=31536000, immutable');
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

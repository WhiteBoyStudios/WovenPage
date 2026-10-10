/**
 * The preview engine: a loopback-only HTTP server that turns site files into
 * what a browser should see.
 *
 *  - Unsaved editor buffers are overlaid on disk, so the preview always shows
 *    what is on screen, not what was last saved.
 *  - Pages are composed (layout + fills + parts) on every request.
 *  - With ?__wp=canvas the page is also *instrumented*: every element carries
 *    its source address and the canvas agent is injected. That build is what
 *    the design view embeds.
 *  - Ordinary requests get a tiny live-reload client instead, so the same URL
 *    opened in the system browser refreshes as the user types.
 */

import * as fs from 'node:fs';
import * as http from 'node:http';
import type { AddressInfo } from 'node:net';

import { ComposeIssue, composePage } from '../../shared/compose';
import { INSTANCE_ATTR, instrument } from '../../shared/html/instrument';
import { basename, dirname, extname, fileKind, isSassPartial, join, mimeType, normalize, escapesRoot, sassSourcePath } from '../../shared/paths';
import { CANVAS_QUERY } from '../../shared/protocol';
import type { ProjectService } from './ProjectService';
import { compileSass, errorStylesheet } from './SassCompiler';

export interface PreviewScripts {
  /** Source of the canvas agent bundle. */
  agent: () => string;
  /** Source of the live-reload client bundle. */
  live: () => string;
}

export interface CanvasBoot {
  epoch: number;
  files: string[];
  path: string;
  issues: ComposeIssue[];
}

type ChangeKind = 'css' | 'reload';

const PART_PREVIEW_FILE = '__part-preview__.html';
/** Origin of the workbench window (see the wp:// scheme in main.ts). */
export const APP_ORIGIN = 'wp://app';

export class PreviewServer {
  private server: http.Server | null = null;
  private port = 0;
  private overlays = new Map<string, string>();
  private clients = new Set<http.ServerResponse>();
  private heartbeat: NodeJS.Timeout | null = null;

  constructor(
    private readonly project: ProjectService,
    private readonly scripts: PreviewScripts,
  ) {}

  get origin(): string {
    return `http://127.0.0.1:${this.port}`;
  }

  async start(): Promise<string> {
    this.server = http.createServer((req, res) => {
      this.handle(req, res).catch((err) => {
        if (!res.headersSent) res.writeHead(500, { 'content-type': 'text/plain; charset=utf-8' });
        res.end(`Preview error: ${(err as Error).message}`);
      });
    });
    await new Promise<void>((resolve, reject) => {
      this.server!.once('error', reject);
      // Loopback only: the preview is never reachable from another machine.
      this.server!.listen(0, '127.0.0.1', () => resolve());
    });
    this.port = (this.server.address() as AddressInfo).port;
    this.heartbeat = setInterval(() => this.clients.forEach((c) => c.write(': keep-alive\n\n')), 25000);
    return this.origin;
  }

  async stop(): Promise<void> {
    if (this.heartbeat) clearInterval(this.heartbeat);
    for (const client of this.clients) client.end();
    this.clients.clear();
    await new Promise<void>((resolve) => (this.server ? this.server.close(() => resolve()) : resolve()));
    this.server?.closeAllConnections?.();
    this.server = null;
  }

  // -------------------------------------------------------------- overlays

  /** Makes the preview serve `text` for a file instead of what is on disk. */
  setOverlay(path: string, text: string): void {
    const rel = normalize(path);
    if (this.overlays.get(rel) === text) return;
    this.overlays.set(rel, text);
    this.notify([rel]);
  }

  clearOverlay(path: string): void {
    const rel = normalize(path);
    if (this.overlays.delete(rel)) this.notify([rel]);
  }

  /** Text of a file as the preview sees it: the unsaved buffer if there is one. */
  readText = (path: string): string | null => {
    const rel = normalize(path);
    return this.overlays.get(rel) ?? this.project.readSync(rel);
  };

  /** Tells every connected browser that files changed. */
  notify(paths: string[]): void {
    if (!paths.length) return;
    const kind: ChangeKind = paths.every((p) => fileKind(p) === 'css') ? 'css' : 'reload';
    const payload = `data: ${JSON.stringify({ kind, paths })}\n\n`;
    for (const client of this.clients) client.write(payload);
  }

  urlFor(path: string): string {
    return `${this.origin}/${normalize(path).split('/').map(encodeURIComponent).join('/')}`;
  }

  // -------------------------------------------------------------- requests

  private async handle(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
    // Refuse requests that arrived under another hostname (DNS rebinding).
    const host = req.headers.host ?? '';
    if (host !== `127.0.0.1:${this.port}` && host !== `localhost:${this.port}`) {
      res.writeHead(403).end('Forbidden');
      return;
    }
    if (req.method !== 'GET' && req.method !== 'HEAD') {
      // Forms in a static preview have nowhere to post to; answer politely.
      res.writeHead(200, { 'content-type': 'text/html; charset=utf-8' });
      res.end('<!doctype html><meta charset="utf-8"><body style="font:16px system-ui;padding:2rem">This is a local preview. The form was not sent anywhere. <a href="javascript:history.back()">Go back</a></body>');
      return;
    }

    const url = new URL(req.url ?? '/', this.origin);
    let pathname: string;
    try {
      pathname = decodeURIComponent(url.pathname);
    } catch {
      res.writeHead(400).end('Bad request');
      return;
    }

    if (pathname === '/__wp/events') return this.openEventStream(res);
    if (pathname === '/__wp/agent.js') return this.sendText(res, 200, 'text/javascript; charset=utf-8', this.scripts.agent());
    if (pathname === '/__wp/live.js') return this.sendText(res, 200, 'text/javascript; charset=utf-8', this.scripts.live());

    let rel = normalize(pathname);
    if (escapesRoot(rel) || this.project.isIgnored(rel)) return this.notFound(res, rel);

    const overlay = this.overlays.get(rel);
    let stat = overlay === undefined ? this.statOf(rel) : null;
    if (stat?.isDirectory() || rel === '') {
      rel = join(rel, 'index.html');
      stat = this.statOf(rel);
    }
    if (overlay === undefined && !this.overlays.has(rel) && !stat?.isFile()) {
      // A stylesheet that only exists as Sass is compiled on request.
      const css = this.compiledStylesheet(rel);
      if (css !== null) return this.sendText(res, 200, 'text/css; charset=utf-8', css);
      return this.notFound(res, rel);
    }

    if (fileKind(rel) === 'html') {
      const canvas = url.searchParams.get(CANVAS_QUERY) === 'canvas';
      const epoch = Number(url.searchParams.get('e') ?? 0);
      return this.sendText(res, 200, 'text/html; charset=utf-8', this.renderPage(rel, canvas, epoch));
    }

    const text = this.overlays.get(rel);
    if (text !== undefined) return this.sendText(res, 200, mimeType(rel), text);
    return this.sendFile(req, res, rel, stat!);
  }

  /** Composes a page, optionally instrumented for the canvas, and injects the right client script. */
  renderPage(path: string, canvas: boolean, epoch = 0): string {
    const files: string[] = [];
    const read = (p: string): string | null => {
      const text = p === this.partPreviewPath(path) ? this.partPreviewSource(path) : this.readText(p);
      if (text === null || !canvas) return text;
      let index = files.indexOf(p);
      if (index === -1) index = files.push(p) - 1;
      return instrument(text, index);
    };

    // A part is a fragment; on its own it would render unstyled. Show it
    // inside the site's first layout instead, as a one-off virtual page.
    const virtual = this.partPreviewSource(path) !== null ? this.partPreviewPath(path) : null;
    const result = composePage(virtual ?? path, { read, canvas });
    let html = result.html;

    if (canvas && virtual) {
      // The virtual page is not a real file, so nothing may address it.
      const v = files.indexOf(virtual);
      if (v !== -1) html = html.replace(new RegExp(` ${INSTANCE_ATTR}="${v}:\\d+"`, 'g'), '');
    }

    let inject: string;
    if (canvas) {
      const boot: CanvasBoot = { epoch, files, path, issues: result.issues };
      inject = `<script>window.__WOVENPAGE__=${JSON.stringify(boot).replace(/</g, '\\u003c')}</script><script src="/__wp/agent.js"></script>`;
    } else {
      inject = '<script src="/__wp/live.js" async></script>';
    }
    return injectIntoHead(html, inject);
  }

  /** CSS for `x.css` when the site has `x.scss` instead; null if there is no such Sass file. */
  compiledStylesheet(cssPath: string): string | null {
    if (extname(cssPath) !== '.css') return null;
    const source = sassSourcePath(cssPath);
    if (isSassPartial(source) || this.readText(source) === null) return null;
    const result = compileSass(source, this.readText);
    return result.error ? errorStylesheet(source, result.error) : result.css;
  }

  private partPreviewPath(path: string): string {
    return join(dirname(path), PART_PREVIEW_FILE);
  }

  private partPreviewSource(path: string): string | null {
    const partsDir = normalize(this.project.manifest.partsDir) + '/';
    if (!path.startsWith(partsDir)) return null;
    const layout = this.firstLayout();
    if (!layout) return null;
    return `<w-page layout="${layout}" title="${basename(path)}"><w-fill slot="main"><w-part src="${path}"></w-part></w-fill></w-page>`;
  }

  private firstLayout(): string | null {
    const dir = normalize(this.project.manifest.layoutsDir);
    try {
      const names = fs.readdirSync(this.project.abs(dir)).filter((n) => /\.html?$/i.test(n)).sort();
      for (const name of names) {
        const text = this.readText(join(dir, name));
        if (text && /<w-slot\b/i.test(text)) return join(dir, name);
      }
    } catch {
      /* no layouts folder */
    }
    return null;
  }

  private statOf(rel: string): fs.Stats | null {
    try {
      return fs.statSync(this.project.abs(rel));
    } catch {
      return null;
    }
  }

  private sendText(res: http.ServerResponse, status: number, type: string, body: string): void {
    res.writeHead(status, {
      'content-type': type,
      'cache-control': 'no-store',
      'x-content-type-options': 'nosniff',
    });
    res.end(body);
  }

  private notFound(res: http.ServerResponse, rel: string): void {
    this.sendText(
      res,
      404,
      'text/html; charset=utf-8',
      `<!doctype html><meta charset="utf-8"><title>Not found</title><body style="font:16px system-ui;padding:2rem;color:#333"><h1 style="font-size:1.25rem">This file is not in the site</h1><p><code>${rel.replace(/[<&]/g, '')}</code> does not exist. Check the link that brought you here.</p><script src="/__wp/live.js" async></script></body>`,
    );
  }

  /** Streams a file from disk, honouring Range so video can seek. */
  private sendFile(req: http.IncomingMessage, res: http.ServerResponse, rel: string, stat: fs.Stats): void {
    const abs = this.project.abs(rel);
    const headers: http.OutgoingHttpHeaders = {
      'content-type': mimeType(rel),
      'cache-control': 'no-store',
      'accept-ranges': 'bytes',
      'x-content-type-options': 'nosniff',
    };
    // The workbench previews fonts with the FontFace API, which needs CORS.
    // Only the app's own origin is allowed, so no website the user visits can
    // read the unpublished site off the loopback port.
    if (req.headers.origin === APP_ORIGIN) {
      headers['access-control-allow-origin'] = APP_ORIGIN;
      headers.vary = 'origin';
    }
    const range = /^bytes=(\d*)-(\d*)$/.exec(req.headers.range ?? '');
    if (range && stat.size > 0) {
      let start = range[1] ? Number(range[1]) : stat.size - Number(range[2]);
      let end = range[1] && range[2] ? Number(range[2]) : stat.size - 1;
      start = Math.max(0, start);
      end = Math.min(stat.size - 1, end);
      if (start > end) {
        res.writeHead(416, { 'content-range': `bytes */${stat.size}` }).end();
        return;
      }
      res.writeHead(206, { ...headers, 'content-range': `bytes ${start}-${end}/${stat.size}`, 'content-length': end - start + 1 });
      if (req.method === 'HEAD') return void res.end();
      fs.createReadStream(abs, { start, end }).pipe(res);
      return;
    }
    res.writeHead(200, { ...headers, 'content-length': stat.size });
    if (req.method === 'HEAD') return void res.end();
    fs.createReadStream(abs).on('error', () => res.destroy()).pipe(res);
  }

  private openEventStream(res: http.ServerResponse): void {
    res.writeHead(200, {
      'content-type': 'text/event-stream',
      'cache-control': 'no-store',
      connection: 'keep-alive',
    });
    res.write(': connected\n\n');
    this.clients.add(res);
    res.on('close', () => this.clients.delete(res));
  }
}

/** Places markup at the top of <head> so it runs before the page's own scripts. */
export function injectIntoHead(html: string, markup: string): string {
  const head = /<head\b[^>]*>/i.exec(html);
  if (head) return html.slice(0, head.index + head[0].length) + markup + html.slice(head.index + head[0].length);
  const htmlTag = /<html\b[^>]*>/i.exec(html);
  if (htmlTag) return html.slice(0, htmlTag.index + htmlTag[0].length) + markup + html.slice(htmlTag.index + htmlTag[0].length);
  const doctype = /^\s*<!doctype[^>]*>/i.exec(html);
  if (doctype) return doctype[0] + markup + html.slice(doctype[0].length);
  return markup + html;
}

/**
 * Builds the publishable site: every page composed to plain HTML, everything
 * else copied, and the authoring-only folders (layouts, parts) left out.
 * The output contains no Wovenpage tags and needs no runtime.
 */

import * as fsp from 'node:fs/promises';
import * as nodePath from 'node:path';

import { composePage } from '../../shared/compose';
import { basename, compiledCssPath, fileKind, isSass, isSassPartial, normalize } from '../../shared/paths';
import { BuildIssue, BuildResult, MANIFEST_FILE } from '../../shared/types';
import type { ProjectService } from './ProjectService';
import { compileSass } from './SassCompiler';

export class BuildService {
  constructor(private readonly project: ProjectService) {}

  /** True for source files that should not appear in the published site. */
  isAuthoringOnly(path: string): boolean {
    const { layoutsDir, partsDir } = this.project.manifest;
    const p = normalize(path);
    return (
      p === MANIFEST_FILE ||
      p.startsWith(normalize(layoutsDir) + '/') ||
      p.startsWith(normalize(partsDir) + '/') ||
      isSassPartial(p) ||
      basename(p).startsWith('.') && basename(p) !== '.htaccess' && basename(p) !== '.well-known'
    );
  }

  async build(overlays: Record<string, string> = {}): Promise<BuildResult> {
    const started = Date.now();
    const outRel = normalize(this.project.manifest.outDir);
    if (!outRel) throw new Error('The build folder cannot be the site folder itself. Change "outDir" in wovenpage.json.');
    const outAbs = this.project.abs(outRel);

    const read = (path: string) => overlays[path] ?? this.project.readSync(path);
    const issues: BuildIssue[] = [];
    const written: string[] = [];
    let pages = 0;

    await fsp.rm(outAbs, { recursive: true, force: true });
    await fsp.mkdir(outAbs, { recursive: true });

    const all = await this.project.listFiles();
    for (const file of all) {
      if (this.isAuthoringOnly(file)) continue;
      if (isSass(file)) {
        // Sass is published as the stylesheet it compiles to; the .scss itself stays behind.
        const cssPath = compiledCssPath(file);
        if (all.includes(cssPath)) {
          issues.push({ file, message: `Both ${basename(file)} and ${basename(cssPath)} exist; the .css file is published and the Sass file is ignored.`, severity: 'warning' });
          continue;
        }
        const result = compileSass(file, read);
        if (result.error) {
          issues.push({ file: result.error.file ?? file, message: `Sass, line ${result.error.line}: ${result.error.message}`, severity: 'error' });
          continue;
        }
        const cssDest = nodePath.join(outAbs, cssPath);
        await fsp.mkdir(nodePath.dirname(cssDest), { recursive: true });
        await fsp.writeFile(cssDest, result.css, 'utf8');
        written.push(cssPath);
        continue;
      }
      const dest = nodePath.join(outAbs, file);
      await fsp.mkdir(nodePath.dirname(dest), { recursive: true });
      if (fileKind(file) === 'html') {
        const result = composePage(file, { read });
        for (const issue of result.issues) issues.push({ file: issue.file, message: issue.message, severity: issue.severity });
        await fsp.writeFile(dest, result.html, 'utf8');
        pages++;
      } else if (overlays[file] !== undefined) {
        await fsp.writeFile(dest, overlays[file], 'utf8');
      } else {
        await fsp.copyFile(this.project.abs(file), dest);
      }
      written.push(file);
    }

    return { outDir: outRel, files: written.sort(), pages, issues, ms: Date.now() - started };
  }
}

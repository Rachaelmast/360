// Bundles standalone/app.ts (and the shared engine) into one self-contained HTML file.
import { readFileSync, writeFileSync } from 'node:fs';
import { build } from 'esbuild';

const out = await build({ entryPoints: [new URL('./app.ts', import.meta.url).pathname], bundle: true, minify: true, format: 'iife', target: 'chrome110', write: false });
const js = out.outputFiles[0].text.replace(/<\/script/gi, '<\\/script');
const html = readFileSync(new URL('./template.html', import.meta.url), 'utf8').replace('/*APP*/', () => js);
const dest = new URL('./SkyBridge-Lead-Finder.html', import.meta.url);
writeFileSync(dest, html);
console.log(`wrote ${dest.pathname} (${(html.length / 1024).toFixed(0)} KB)`);

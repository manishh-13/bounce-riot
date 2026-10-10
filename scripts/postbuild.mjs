import { readdir, readFile, writeFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join, relative } from 'node:path';
import { createHash } from 'node:crypto';
const root = fileURLToPath(new URL('../dist/', import.meta.url));
async function collect(dir) {
  const files = [];
  for (const entry of await readdir(dir, { withFileTypes: true })) {
    const path = join(dir, entry.name);
    if (entry.isDirectory()) files.push(...await collect(path)); else files.push(relative(root, path).replaceAll('\\', '/'));
  }
  return files;
}
const files = (await collect(root)).filter(f => !['config.json', 'sw.js', '.nojekyll'].includes(f));
const hash = createHash('sha256');
for (const file of [...files].sort()) { hash.update(file); hash.update(await readFile(join(root, file))); }
const digest = hash.digest('hex').slice(0, 12);
const content = `const CACHE='bounce-riot-${digest}';
const FILES=${JSON.stringify(files.map(f => './' + f))};
self.addEventListener('install',event=>{event.waitUntil(caches.open(CACHE).then(cache=>cache.addAll(FILES)));});
self.addEventListener('activate',event=>{event.waitUntil(caches.keys().then(keys=>Promise.all(keys.filter(k=>k.startsWith('bounce-riot-')&&k!==CACHE).map(k=>caches.delete(k)))).then(()=>self.clients.claim()));});
self.addEventListener('fetch',event=>{
  const url=new URL(event.request.url);
  if(event.request.method!=='GET'||url.origin!==self.location.origin||url.pathname.endsWith('/config.json'))return;
  if(event.request.mode==='navigate'){
    event.respondWith(fetch(event.request).catch(()=>caches.match(new URL('./index.html',self.location).href)));
    return;
  }
  if(!FILES.some(f=>new URL(f,self.location).href===url.href))return;
  event.respondWith(caches.match(event.request,{ignoreVary:true}).then(cached=>cached||fetch(event.request)));
});\n`;
await writeFile(join(root, 'sw.js'), content);
await writeFile(join(root, '.nojekyll'), '');
console.log(`Offline shell ${digest}: ${files.length} files. Room discovery still requires internet.`);

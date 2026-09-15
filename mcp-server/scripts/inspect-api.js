import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import { parse } from 'acorn';
import { simple } from 'acorn-walk';

export const backendRoot = fileURLToPath(new URL('../../backend/', import.meta.url));
const parseSource = source => parse(source, { ecmaVersion: 'latest', sourceType: 'script', locations: true });
const member = n => n?.type === 'MemberExpression' && !n.computed ? `${member(n.object) || n.object.name}.${n.property.name}` : n?.type === 'ChainExpression' ? member(n.expression) : null;
export function inspectApi(root = backendRoot) {
  const source = fs.readFileSync(path.join(root, 'server.js'), 'utf8');
  const ast = parseSource(source); const imports = new Map(); const mounts = []; const direct = [];
  simple(ast, {
    VariableDeclarator(n) { if (n.id.type === 'Identifier' && n.init?.callee?.name === 'require' && n.init.arguments[0]?.value?.startsWith('./routes/')) imports.set(n.id.name, n.init.arguments[0].value); },
    CallExpression(n) {
      if (member(n.callee) === 'app.use' && typeof n.arguments[0]?.value === 'string') {
        const ref = n.arguments[1]; const file = ref?.type === 'Identifier' ? imports.get(ref.name) : ref?.callee?.name === 'require' ? ref.arguments[0]?.value : null;
        if (file?.startsWith('./routes/')) mounts.push({ prefix: n.arguments[0].value, file: `${file.slice(2)}.js` });
      }
      if (/^app\.(get|post|put|patch|delete)$/.test(member(n.callee) || '') && n.arguments[0]?.value?.startsWith('/api/')) direct.push(n);
    },
  });
  const operations = [];
  function collect(n, text, file, prefix = '') {
    const values = n.arguments[0]?.type === 'ArrayExpression' ? n.arguments[0].elements.map(v => v.value) : [n.arguments[0]?.value];
    if (values.some(v => typeof v !== 'string')) throw new Error(`Unresolved route at ${file}:${n.loc.start.line}`);
    for (const suffix of values) {
      const route = `${prefix}${suffix === '/' ? '' : suffix}`;
      const method = n.callee.property.name.toUpperCase();
      const handlerSource = text.slice(n.start, n.end);
      const query = new Set(), body = new Set(); let queryOpen = false, bodyOpen = false;
      simple(n, {
        MemberExpression(m) {
          const p = member(m);
          if (/^req\.query\.[\w]+$/.test(p || '')) query.add(m.property.name);
          if (/^req\.body\.[\w]+$/.test(p || '')) body.add(m.property.name);
        },
        VariableDeclarator(v) {
          const init = v.init?.type === 'LogicalExpression' ? v.init.left : v.init;
          const target = member(init) === 'req.query' ? query : member(init) === 'req.body' ? body : null;
          if (target && v.id.type === 'ObjectPattern') for (const p of v.id.properties) if (p.type === 'Property') target.add(p.key.name || p.key.value);
        },
      });
      // Passed-through payloads are validated by the underlying service. Record this
      // explicitly, rather than inventing an incomplete schema from string matching.
      queryOpen = /\breq\.query\b(?![?.\w])/.test(handlerSource);
      bodyOpen = /\breq\.body\b(?![?.\w])/.test(handlerSource);
      const comments = text.slice(Math.max(0, n.start - 500), n.start).split('\n').filter(l => /^\s*\/\//.test(l)).map(l => l.replace(/^\s*\/\/\s?/, '').trim());
      const comment = `${method} ${route}. ${comments.filter(l => l.startsWith(`${method} ${route}`)).at(-1)?.replace(`${method} ${route}`, '').replace(/^\s*[—-]\s*/, '') || ''}`.trim().slice(0, 300);
      operations.push({ id: `${method.toLowerCase()}_${route.replace(/^\/api\//, '').replace(/:([\w]+)/g, 'by_$1').replace(/[^a-zA-Z0-9]+/g, '_')}`, method, route, domain: route.split('/')[2], source: file, line: n.loc.start.line, description: comment || `${method} ${route}`, params: [...route.matchAll(/:([\w]+)/g)].map(m => m[1]), query: [...query].sort(), body: [...body].sort(), queryOpen, bodyOpen, multipart: /upload\.single\(/.test(handlerSource), stream: /text\/event-stream|handleChat\(/.test(handlerSource) });
    }
  }
  for (const n of direct) collect(n, source, 'server.js');
  for (const mount of mounts) {
    const text = fs.readFileSync(path.join(root, mount.file), 'utf8');
    simple(parseSource(text), { CallExpression(n) {
      if (/^router\.(get|post|put|patch|delete)$/.test(member(n.callee) || '')) collect(n, text, mount.file, mount.prefix);
    } });
  }
  return operations.sort((a,b) => a.id.localeCompare(b.id));
}

if (process.argv[1] && path.resolve(process.argv[1]) === fileURLToPath(import.meta.url)) {
  const ops = inspectApi();
  const target = fileURLToPath(new URL('../remote/api-inventory.json', import.meta.url));
  fs.writeFileSync(target, JSON.stringify(ops, null, 2) + '\n');
  console.log(`Inventoried ${ops.length} operations in ${new Set(ops.map(v => v.domain)).size} domains`);
}

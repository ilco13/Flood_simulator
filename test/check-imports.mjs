// Vérifie que chaque module de src/app/ (et src/main.js) importe tous les noms qu'il utilise
// et qui sont déclarés au premier niveau d'un autre module : un oubli ne se voit qu'à
// l'exécution (« X is not defined »). Usage : node test/check-imports.mjs
import { readFileSync, readdirSync } from 'node:fs';
import { parseAst } from 'rollup/parseAst';

const root = new URL('../src/', import.meta.url);
const files = ['main.js', ...readdirSync(new URL('app/', root)).filter((f) => f.endsWith('.js')).map((f) => `app/${f}`)];

const topLevel = new Map(); // nom -> fichier
const asts = new Map();
for (const f of files) {
  const ast = parseAst(readFileSync(new URL(f, root), 'utf8'));
  asts.set(f, ast);
  for (let node of ast.body) {
    if (node.type === 'ExportNamedDeclaration' && node.declaration) node = node.declaration;
    if (node.type === 'FunctionDeclaration' || node.type === 'ClassDeclaration') topLevel.set(node.id.name, f);
    if (node.type === 'VariableDeclaration') for (const d of node.declarations) if (d.id.type === 'Identifier') topLevel.set(d.id.name, f);
  }
}

function walk(node, parent, key, visit) {
  if (!node || typeof node.type !== 'string') return;
  visit(node, parent, key);
  for (const k of Object.keys(node)) {
    const v = node[k];
    if (Array.isArray(v)) v.forEach((c) => c && typeof c.type === 'string' && walk(c, node, k, visit));
    else if (v && typeof v.type === 'string') walk(v, node, k, visit);
  }
}

function patternNames(p, out) {
  if (!p) return;
  if (p.type === 'Identifier') out.add(p.name);
  else if (p.type === 'ObjectPattern') p.properties.forEach((q) => patternNames(q.type === 'RestElement' ? q.argument : q.value, out));
  else if (p.type === 'ArrayPattern') p.elements.forEach((q) => patternNames(q, out));
  else if (p.type === 'RestElement') patternNames(p.argument, out);
  else if (p.type === 'AssignmentPattern') patternNames(p.left, out);
}

let problems = 0;
for (const [f, ast] of asts) {
  const declared = new Set();
  const used = new Set();
  walk(ast, null, null, (n, parent, key) => {
    if (n.type === 'ImportSpecifier' || n.type === 'ImportDefaultSpecifier' || n.type === 'ImportNamespaceSpecifier') declared.add(n.local.name);
    if (n.type === 'VariableDeclarator') patternNames(n.id, declared);
    if ((n.type === 'FunctionDeclaration' || n.type === 'FunctionExpression' || n.type === 'ClassDeclaration') && n.id) declared.add(n.id.name);
    if (n.type.includes('Function')) n.params.forEach((p) => patternNames(p, declared));
    if (n.type === 'CatchClause') patternNames(n.param, declared);
    if (n.type !== 'Identifier') return;
    if (parent?.type === 'MemberExpression' && key === 'property' && !parent.computed) return;
    if ((parent?.type === 'Property' || parent?.type === 'MethodDefinition' || parent?.type === 'PropertyDefinition') && key === 'key' && !parent.computed) return;
    if (parent?.type?.startsWith('Import') || parent?.type?.startsWith('Export')) return;
    if (parent?.type === 'LabeledStatement' || parent?.type === 'BreakStatement' || parent?.type === 'ContinueStatement') return;
    used.add(n.name);
  });
  for (const name of used) {
    const owner = topLevel.get(name);
    if (owner && owner !== f && !declared.has(name)) {
      console.log(`${f} : « ${name} » (déclaré dans ${owner}) n'est pas importé`);
      problems++;
    }
  }
}
console.log(problems ? `${problems} import(s) manquant(s)` : `Imports complets (${files.length} fichiers).`);
process.exit(problems ? 1 : 0);

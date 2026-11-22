import { zod } from "./inputs.ts";
import { capture, evidenceSchema } from "./parity-proof.ts";

const reducer = String.raw`
import sys, os, hashlib, gzip, json, re, sqlite3
name = sys.argv[1]
with open(name, 'rb') as raw:
    limit = 64 * 1024 * 1024
    encoded = raw.read(limit + 1)
    if len(encoded) > limit: raise ValueError('Capture exceeds the 64 MiB reducer limit')
    digest = hashlib.sha256(encoded).hexdigest()
    raw.seek(0)
    if encoded.startswith(b'\x1f\x8b'):
        with gzip.GzipFile(fileobj=raw) as body: data = body.read(limit + 1)
    else:
        data = encoded
if len(data) > 64 * 1024 * 1024:
    raise ValueError('Capture exceeds the 64 MiB reducer limit')
try: doc = json.loads(data)
except (ValueError, UnicodeError): doc = None
db = sqlite3.connect(os.path.join(os.environ['TMPDIR'], 'trace.sqlite'))
db.executescript("""
CREATE TABLE sample(symbol TEXT, file TEXT, line INTEGER, weight REAL, detail TEXT);
CREATE TABLE retained(origin INTEGER, target INTEGER, type TEXT);
""")
fmt = None
if isinstance(doc, dict) and all(k in doc for k in ('nodes', 'samples', 'timeDeltas')):
    fmt = 'cpuprofile'
    nodes = {n['id']: n for n in doc['nodes']}
    parents = {c: n['id'] for n in doc['nodes'] for c in n.get('children', [])}
    if len(doc['samples']) != len(doc['timeDeltas']): raise ValueError('Sample/time mismatch')
    def samples():
        for node, weight in zip(doc['samples'], doc['timeDeltas']):
            if weight < 0: raise ValueError('Negative sample duration')
            f = nodes[node]['callFrame']
            p, trail = node, []
            while p in nodes and len(trail) < 64:
                trail.append(nodes[p]['callFrame'].get('functionName', ''))
                if p not in parents: break
                p = parents[p]
            yield (f.get('functionName', ''), f.get('url', ''), f.get('lineNumber', -1) + 1, weight, ' > '.join(reversed(trail)))
    db.executemany('INSERT INTO sample VALUES (?,?,?,?,?)', samples())
elif isinstance(doc, dict) and 'snapshot' in doc and 'nodes' in doc and 'edges' in doc:
    fmt = 'heapsnapshot'
    meta = doc['snapshot']['meta']
    nf, ef = meta['node_fields'], meta['edge_fields']
    n, e, strings = doc['nodes'], doc['edges'], doc['strings']
    heap_types = meta['edge_types'][ef.index('type')]
    edge = 0
    roots = {0}
    for offset in range(0, len(n), len(nf)):
        name = strings[n[offset + nf.index('name')]]
        size = n[offset + nf.index('self_size')]
        db.execute('INSERT INTO sample VALUES (?,?,?,?,?)', (name, '', 0, size, str(offset)))
        for _ in range(n[offset + nf.index('edge_count')]):
            target = e[edge + ef.index('to_node')]
            kind = heap_types[e[edge + ef.index('type')]]
            db.execute('INSERT INTO retained VALUES (?,?,?)', (offset, target, kind))
            edge += len(ef)
    db.execute('CREATE INDEX retention_target ON retained(target)')
elif isinstance(doc, (list, dict)) and isinstance(doc if isinstance(doc, list) else doc.get('traceEvents'), list):
    fmt = 'chrome-trace'
    events = doc if isinstance(doc, list) else doc['traceEvents']
    def samples():
        for event in events:
            if event.get('ph') != 'X' or not isinstance(event.get('dur'), (int, float)): continue
            args = event.get('args', {})
            frame = args.get('data', args)
            raw_line = frame.get('lineNumber', 0)
            line = int(raw_line) if str(raw_line).isdigit() else 0
            yield (event.get('name', ''), frame.get('url', ''), line, event['dur'], str(event.get('tid', '')))
    db.executemany('INSERT INTO sample VALUES (?,?,?,?,?)', samples())
elif doc is None:
    lines = data.decode('utf-8').splitlines()
    if not any('Spindump' in line or 'Heaviest stack' in line or 'Thread 0x' in line for line in lines):
        raise ValueError('Unrecognized text trace')
    fmt = 'spindump'
    frames = []
    thread = ''
    for line in lines:
        if 'Thread 0x' in line:
            thread = line.strip()[:300]
        match = re.match(r'^\s*(\d+)\s+(.+?)(?:\s+\(.*\)|$)', line)
        if match:
            loc = re.search(r'([\w./-]+\.[a-zA-Z]+):(\d+)', line)
            frames.append((match[2].strip(), loc[1] if loc else '', int(loc[2]) if loc else 0, int(match[1]), thread))
    db.executemany('INSERT INTO sample VALUES (?,?,?,?,?)', frames)
if fmt is None: raise ValueError('Unsupported capture format')
db.commit()
hot = db.execute('SELECT symbol,file,line,SUM(weight),MIN(detail) FROM sample GROUP BY symbol,file,line ORDER BY SUM(weight) DESC,symbol,file,line LIMIT 4').fetchall()
focus = None
if len(sys.argv) == 5:
    focus = db.execute('SELECT COALESCE(SUM(weight),0) FROM sample WHERE symbol=? AND file=? AND line=?',
                       (sys.argv[2], sys.argv[3], int(sys.argv[4]))).fetchone()[0]
chains = []
if fmt == 'heapsnapshot':
    from collections import deque
    for target, in db.execute('SELECT CAST(detail AS INTEGER) FROM sample ORDER BY weight DESC LIMIT 3'):
        todo, visited = deque([(target, [target])]), {target}
        while todo and len(visited) < 10000:
            child, path = todo.popleft()
            if child in roots:
                chains.append(path)
                break
            for parent, in db.execute("SELECT origin FROM retained WHERE target=? AND type!='weak' LIMIT 500", (child,)):
                if parent not in visited:
                    visited.add(parent)
                    todo.append((parent, path + [parent]))
def compact(rows):
    return [[field[:160] if isinstance(field,str) else field for field in row] for row in rows]
count, weight = db.execute('SELECT COUNT(*), COALESCE(SUM(weight),0) FROM sample').fetchone()
print(json.dumps({'format':fmt,'sha256':digest,'count':count,'weight':weight,'focus':focus,
                  'hot':compact(hot),'retainers':chains}))
`;

export function traceResultSchema() {
  const z = zod();
  return z.strictObject({
    format: z.string(), sha256: z.string().regex(/^[a-f0-9]{64}$/), count: z.number().int().nonnegative(),
    weight: z.number().nonnegative(), focus: z.number().nonnegative().nullable(),
    hot: z.array(z.tuple([z.string(), z.string(), z.number(), z.number(), z.string()])),
    retainers: z.array(z.array(z.number())),
  });
}

export function traceCaptureSchema() {
  const z = zod();
  return z.strictObject({ path: z.string(), receipt: evidenceSchema(), reduced: traceResultSchema().nullable() });
}

export async function reduceTrace(key: string, cwd: string, path: string, focus?: { symbol: string; file: string; line: number }) {
  const receipt = await capture(key, cwd, ["python3", "-c", reducer, path,
    ...(focus ? [focus.symbol, focus.file, String(focus.line)] : []),
  ]);
  let reduced: ReturnType<typeof traceResultSchema>["_output"] | null = null;
  if (receipt.complete && receipt.exit === 0) {
    try {
      reduced = traceResultSchema().parse(JSON.parse(receipt.tail));
    } catch {
      // A partial or malformed artifact cannot support attribution.
    }
  }
  return { path, receipt, reduced };
}

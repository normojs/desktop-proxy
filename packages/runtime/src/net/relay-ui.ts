/**
 * Local web viewer + cost dashboard for the standalone relay daemon.
 *
 * The injected runtime has the full Network inspector; the standalone daemon
 * (no-injection path) gets this lightweight browser UI instead. It serves a
 * single self-contained page plus a small JSON API over recent in-memory entries:
 *   GET /             → dashboard
 *   GET /api/traffic  → recent entries (newest first)
 *   GET /api/stats    → aggregate cost / tokens by model & service
 */

import http from "node:http";

export interface UiUsage {
  promptTokens?: number;
  completionTokens?: number;
  totalTokens?: number;
  costUsd?: number;
}

export interface UiEntry {
  startedDateTime?: string;
  method?: string;
  url?: string;
  status?: number;
  service?: string;
  model?: string;
  usage?: UiUsage | null;
  reqBody?: string | null;
  resBody?: string | null;
}

export interface RelayBucket {
  count: number;
  tokens: number;
  costUsd: number;
}

export interface RelayStats {
  count: number;
  errors: number;
  totalTokens: number;
  totalCostUsd: number;
  byModel: Record<string, RelayBucket>;
  byService: Record<string, RelayBucket>;
}

export function renderStats(entries: UiEntry[]): RelayStats {
  const stats: RelayStats = { count: entries.length, errors: 0, totalTokens: 0, totalCostUsd: 0, byModel: {}, byService: {} };
  for (const e of entries) {
    const tokens = e.usage?.totalTokens ?? 0;
    const cost = e.usage?.costUsd ?? 0;
    stats.totalTokens += tokens;
    stats.totalCostUsd += cost;
    if ((e.status ?? 0) >= 400) stats.errors++;
    const model = e.model || "—";
    const svc = e.service || "—";
    const bm = (stats.byModel[model] ??= { count: 0, tokens: 0, costUsd: 0 });
    bm.count++;
    bm.tokens += tokens;
    bm.costUsd += cost;
    const bs = (stats.byService[svc] ??= { count: 0, tokens: 0, costUsd: 0 });
    bs.count++;
    bs.tokens += tokens;
    bs.costUsd += cost;
  }
  return stats;
}

export const RELAY_UI_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/>
<title>dprox relay</title>
<style>
:root{--bg:#f7f8fa;--card:#fff;--bd:#e4e7ec;--fg:#1a2230;--mut:#6b7280;--ac:#2563eb;--err:#dc2626;--ok:#16a34a}
*{box-sizing:border-box}body{margin:0;font:13px/1.5 -apple-system,BlinkMacSystemFont,"Segoe UI",Roboto,sans-serif;background:var(--bg);color:var(--fg)}
header{padding:14px 20px;background:var(--card);border-bottom:1px solid var(--bd);display:flex;align-items:center;gap:16px;position:sticky;top:0;z-index:2}
header h1{font-size:15px;margin:0;font-weight:600}header .dot{width:8px;height:8px;border-radius:50%;background:var(--ok)}
.cards{display:flex;gap:12px;padding:16px 20px;flex-wrap:wrap}
.card{background:var(--card);border:1px solid var(--bd);border-radius:10px;padding:12px 16px;min-width:120px}
.card .k{color:var(--mut);font-size:11px;text-transform:uppercase;letter-spacing:.04em}.card .v{font-size:20px;font-weight:650;margin-top:2px}
.grid{display:grid;grid-template-columns:1.3fr 1fr;gap:16px;padding:0 20px 20px}
@media(max-width:880px){.grid{grid-template-columns:1fr}}
.panel{background:var(--card);border:1px solid var(--bd);border-radius:10px;overflow:hidden}
.panel h2{font-size:12px;margin:0;padding:10px 14px;border-bottom:1px solid var(--bd);color:var(--mut);text-transform:uppercase;letter-spacing:.04em}
table{width:100%;border-collapse:collapse}th,td{text-align:left;padding:7px 14px;border-bottom:1px solid var(--bd);font-variant-numeric:tabular-nums}
th{color:var(--mut);font-weight:500;font-size:11px}tbody tr{cursor:pointer}tbody tr:hover{background:#f1f5ff}
.s2{color:var(--ok)}.s4,.s5{color:var(--err)}.r{text-align:right}.mut{color:var(--mut)}
#detail{position:fixed;inset:0;background:rgba(20,28,40,.45);display:none;align-items:center;justify-content:center;padding:20px;z-index:5}
#detail .box{background:var(--card);border-radius:12px;max-width:920px;width:100%;max-height:86vh;overflow:auto;padding:18px}
#detail pre{background:#0f1729;color:#d7e0f0;padding:12px;border-radius:8px;overflow:auto;font-size:12px;white-space:pre-wrap;word-break:break-word}
#detail h3{margin:14px 0 6px;font-size:12px;color:var(--mut)}
.x{float:right;cursor:pointer;color:var(--mut);font-size:18px;border:none;background:none}
</style></head>
<body>
<header><span class="dot"></span><h1>dprox relay</h1><span class="mut" id="sub">model-traffic dashboard</span></header>
<div class="cards" id="cards"></div>
<div class="grid">
  <div class="panel"><h2>Recent requests</h2><table><thead><tr><th>Time</th><th>Status</th><th>Service</th><th>Model</th><th class="r">Tokens</th><th class="r">Cost</th></tr></thead><tbody id="rows"></tbody></table></div>
  <div class="panel"><h2>By model</h2><table><thead><tr><th>Model</th><th class="r">Calls</th><th class="r">Tokens</th><th class="r">Cost</th></tr></thead><tbody id="models"></tbody></table></div>
</div>
<div id="detail" onclick="if(event.target===this)this.style.display='none'"><div class="box"><button class="x" onclick="document.getElementById('detail').style.display='none'">×</button><div id="dbody"></div></div></div>
<script>
let data=[];
const usd=n=>'$'+(n||0).toFixed(5), num=n=>(n||0).toLocaleString();
function cls(s){return s>=500?'s5':s>=400?'s4':s>=200?'s2':''}
async function refresh(){
  try{
    const [t,s]=await Promise.all([fetch('/api/traffic').then(r=>r.json()),fetch('/api/stats').then(r=>r.json())]);
    data=t;
    document.getElementById('cards').innerHTML=[
      ['Requests',s.count],['Errors',s.errors],['Tokens',num(s.totalTokens)],['Est. cost',usd(s.totalCostUsd)]
    ].map(([k,v])=>'<div class="card"><div class="k">'+k+'</div><div class="v">'+v+'</div></div>').join('');
    document.getElementById('rows').innerHTML=t.map((e,i)=>'<tr onclick="show('+i+')"><td class="mut">'+(e.startedDateTime||'').slice(11,19)+'</td><td class="'+cls(e.status)+'">'+(e.status||'')+'</td><td>'+(e.service||'—')+'</td><td>'+(e.model||'—')+'</td><td class="r">'+num(e.usage&&e.usage.totalTokens)+'</td><td class="r">'+usd(e.usage&&e.usage.costUsd)+'</td></tr>').join('')||'<tr><td colspan=6 class=mut>No traffic yet — send a request through the relay.</td></tr>';
    const m=Object.entries(s.byModel).sort((a,b)=>b[1].costUsd-a[1].costUsd);
    document.getElementById('models').innerHTML=m.map(([k,v])=>'<tr><td>'+k+'</td><td class="r">'+v.count+'</td><td class="r">'+num(v.tokens)+'</td><td class="r">'+usd(v.costUsd)+'</td></tr>').join('')||'<tr><td colspan=4 class=mut>—</td></tr>';
  }catch(e){document.getElementById('sub').textContent='disconnected'}
}
function show(i){const e=data[i];if(!e)return;
  document.getElementById('dbody').innerHTML='<b>'+(e.method||'')+' '+(e.status||'')+'</b> <span class=mut>'+(e.url||'')+'</span>'+
    '<h3>Request body</h3><pre>'+esc(e.reqBody)+'</pre><h3>Response body</h3><pre>'+esc(e.resBody)+'</pre>';
  document.getElementById('detail').style.display='flex';
}
function esc(s){return (s==null?'(none)':String(s)).replace(/[&<]/g,c=>c==='&'?'&amp;':'&lt;').slice(0,20000)}
refresh();setInterval(refresh,3000);
</script></body></html>`;

export function startRelayUi(
  port: number,
  getEntries: () => UiEntry[],
  log: (level: string, ...args: unknown[]) => void,
  host = "127.0.0.1",
): http.Server {
  const server = http.createServer((req, res) => {
    const url = req.url ?? "/";
    if (url.startsWith("/api/traffic")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(getEntries().slice(-300).reverse()));
      return;
    }
    if (url.startsWith("/api/stats")) {
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(renderStats(getEntries())));
      return;
    }
    if (url === "/" || url.startsWith("/index")) {
      res.writeHead(200, { "content-type": "text/html; charset=utf-8" });
      res.end(RELAY_UI_HTML);
      return;
    }
    res.writeHead(404);
    res.end("not found");
  });
  server.on("error", (e) => log("warn", "relay UI server error:", String(e)));
  server.listen(port, host, () => log("info", `dashboard on http://${host}:${port}`));
  return server;
}

#!/usr/bin/env python3
"""READ-ONLY check of the three synthetic pilot flows (A, B, C) created by hand in the editor. Writes nothing.
Usage: verify_pilot_flows.py [--json dump.json]   (default: reads the production database through docker exec psql)"""
import json, subprocess, sys

ACCOUNT = "bbbbbbbb-bbbb-4bbb-8bbb-bbbbbbbbbbbb"
M1, M2, M3, M4 = "P8 PRUEBA 1/4 — Información inicial", "P8 PRUEBA 2/4 — Seguimiento", "P8 PRUEBA 3/4 — Segunda secuencia", "P8 PRUEBA 4/4 — Finalización"
NAMES = {"A": "P8 A", "B": "P8 B", "C": "P8 C"}

def load():
    if "--json" in sys.argv:
        return json.load(open(sys.argv[sys.argv.index("--json") + 1]))
    sql = f"""select coalesce(json_agg(json_build_object('id',f.id,'name',f.name,'status',f.status,'trigger_type',f.trigger_type,'trigger_config',f.trigger_config,'entry',f.entry_node_id,
      'nodes',(select coalesce(json_agg(json_build_object('k',n.node_key,'t',n.node_type,'c',n.config)),'[]'::json) from flow_nodes n where n.flow_id=f.id))),'[]'::json)
      from flows f where f.account_id='{ACCOUNT}' and f.name in ('P8 A','P8 B','P8 C')"""
    out = subprocess.run(["docker", "exec", "supabase-db", "psql", "-U", "postgres", "-d", "postgres", "-At", "-c", sql], capture_output=True, text=True, check=True).stdout
    return json.loads(out)

def edges(node):
    c = node["c"]; t = node["t"]
    if t == "condition": return [c.get("true_next"), c.get("false_next")]
    if t in ("send_buttons", "send_list"): return [b.get("next_node_key") for b in c.get("buttons", [])]
    return [c.get("next_node_key")] if c.get("next_node_key") else []

def check(flows, require_active=False):
    results = []
    def ok(name, cond, detail=""): results.append((name, bool(cond), detail))
    by = {f["name"]: f for f in flows}
    for key, name in NAMES.items(): ok(f"existe exactamente un flujo «{name}»", sum(1 for f in flows if f["name"] == name) == 1)
    if not all(n in by for n in NAMES.values()): return results
    A, B, C = by["P8 A"], by["P8 B"], by["P8 C"]
    nodes = {f["name"]: {n["k"]: n for n in f["nodes"]} for f in flows}
    for f in flows:
        ids = {n["k"] for n in f["nodes"]}
        ok(f"{f['name']}: todas las conexiones apuntan a nodos existentes", all(e in ids for n in f["nodes"] for e in edges(n)))
        # reachability + no cycles inside the flow
        seen, stack, cyc = set(), [], False
        def walk(k):
            nonlocal cyc
            if k in stack: cyc = True; return
            if k in seen: return
            seen.add(k); stack.append(k)
            for e in edges(nodes[f["name"]][k]): 
                if e in nodes[f["name"]]: walk(e)
            stack.pop()
        walk(f["entry"] or "start")
        ok(f"{f['name']}: sin ciclos y sin nodos inalcanzables", not cyc and seen == set(nodes[f["name"]].keys()), f"alcanzables {len(seen)}/{len(nodes[f['name']])}")
        ok(f"{f['name']}: solo nodos de la prueba (inicio, enviar mensaje, retraso, condición, ejecutar flujo, fin)", all(n["t"] in ("start", "send_message", "delay", "condition", "execute_flow", "end") for n in f["nodes"]))
    msgs = [(f["name"], n["c"].get("text")) for f in flows for n in f["nodes"] if n["t"] == "send_message"]
    ok("exactamente 4 mensajes en total, con los textos autorizados", sorted(t for _, t in msgs) == sorted([M1, M2, M3, M4]), str(len(msgs)))
    ok("no hay medios, botones, listas, etiquetas, handoff ni HTTP", not any(n["t"] in ("send_media", "send_buttons", "send_list", "set_tag", "handoff", "http_fetch", "collect_input", "set_contact_field") for f in flows for n in f["nodes"]))
    # A
    ok("A: disparador por palabra clave exclusiva prueba-p8", A["trigger_type"] == "keyword" and [k.lower() for k in A["trigger_config"].get("keywords", [])] == ["prueba-p8"], json.dumps(A["trigger_config"]))
    ok("A: coincidencia exacta (recomendado) o contiene", A["trigger_config"].get("match_type", "contains") in ("exact", "contains"), A["trigger_config"].get("match_type", "contains (por defecto)"))
    ok("B y C: disparador manual", B["trigger_type"] == "manual" and C["trigger_type"] == "manual")
    a = nodes["P8 A"]; seq = []; k = A["entry"] or "start"
    while k in a and len(seq) < 12:
        seq.append(a[k]); nxt = edges(a[k]); k = nxt[0] if nxt else None
    types = [n["t"] for n in seq]
    ok("A: secuencia inicio → mensaje 1/4 → ejecutar B → ejecutar C → mensaje 4/4 → fin", types == ["start", "send_message", "execute_flow", "execute_flow", "send_message", "end"], " → ".join(types))
    if types == ["start", "send_message", "execute_flow", "execute_flow", "send_message", "end"]:
        _, m1, cb, cc, m4, end = seq
        ok("A: mensaje inicial = «P8 PRUEBA 1/4 — Información inicial»", m1["c"].get("text") == M1)
        ok("A: la primera llamada va a B, con el mensaje inicial como referencia, política «detener»", cb["c"].get("target_flow_id") == B["id"] and cb["c"].get("reference_node_key") == m1["k"] and cb["c"].get("on_customer_reply", "stop") == "stop")
        ok("A: la segunda llamada va a C", cc["c"].get("target_flow_id") == C["id"])
        ok("A: tras B continúa en la llamada a C; tras C continúa en el mensaje 4/4", cb["c"].get("next_node_key") == cc["k"] and cc["c"].get("next_node_key") == m4["k"])
        ok("A: cierre = «P8 PRUEBA 4/4 — Finalización» y Fin de toda la ejecución", m4["c"].get("text") == M4 and end["c"].get("scope", "run") == "run")
    b = nodes["P8 B"]
    waits = [n for n in B["nodes"] if n["t"] == "delay"]; conds = [n for n in B["nodes"] if n["t"] == "condition"]; ends = [n for n in B["nodes"] if n["t"] == "end"]
    ok("B: una espera de exactamente 13 minutos", len(waits) == 1 and waits[0]["c"].get("amount") == 13 and waits[0]["c"].get("unit") == "minutes", json.dumps([w["c"] for w in waits]))
    ok("B: una condición «Actividad del cliente» con referencia heredada", len(conds) == 1 and conds[0]["c"].get("subject") == "customer_activity" and conds[0]["c"].get("subject_key") == "$inherited" and conds[0]["c"].get("operator") == "replied_after_reference")
    if len(conds) == 1 and len(waits) == 1:
        c0 = conds[0]["c"]; yes = b.get(c0.get("true_next")); no = b.get(c0.get("false_next"))
        ok("B: la espera precede a la condición", waits[0]["c"].get("next_node_key") == conds[0]["k"])
        ok("B: SÍ respondió → Fin de toda la ejecución", yes and yes["t"] == "end" and yes["c"].get("scope", "run") == "run")
        ok("B: NO respondió → «P8 PRUEBA 2/4 — Seguimiento» → Fin «volver al flujo llamador»", no and no["t"] == "send_message" and no["c"].get("text") == M2 and b.get(no["c"].get("next_node_key"), {}).get("t") == "end" and b[no["c"]["next_node_key"]]["c"].get("scope") == "subflow")
    c = nodes["P8 C"]; csend = [n for n in C["nodes"] if n["t"] == "send_message"]
    ok("C: un mensaje «P8 PRUEBA 3/4 — Segunda secuencia» y Fin «volver al flujo llamador»", len(csend) == 1 and csend[0]["c"].get("text") == M3 and all(n["c"].get("scope") == "subflow" for n in C["nodes"] if n["t"] == "end") and any(n["t"] == "end" for n in C["nodes"]))
    ok("no hay ciclos entre flujos y la profundidad es 1 (A llama a B y a C; B y C no llaman a nadie)", not any(n["t"] == "execute_flow" for n in B["nodes"] + C["nodes"]))
    if require_active: ok("los tres flujos están activos", all(f["status"] == "active" for f in flows), ", ".join(f"{f['name']}={f['status']}" for f in flows))
    return results

if __name__ == "__main__":
    flows = load(); res = check(flows, require_active="--active" in sys.argv)
    for name, good, detail in res: print(("OK   " if good else "FALLA"), name, f"[{detail}]" if detail and not good else "")
    bad = [r for r in res if not r[1]]; print(f"\n{len(res) - len(bad)}/{len(res)} comprobaciones correctas"); sys.exit(1 if bad else 0)

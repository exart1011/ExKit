"""Merge Claude's per-question commentary (claude/<code>.json) into data.json as field "c".
Each entry: [keys, full_question, explanation]; keys are option letters Claude picks ("" if none)."""
import json, sys
D = json.load(open('data.json'))
bad = 0
for l in D['L']:
    C = json.load(open(f"claude/{l['c']}.json"))
    if len(C) != len(l['q']):
        sys.exit(f"{l['c']}: {len(C)} answers vs {len(l['q'])} questions")
    for q, (k, full, s) in zip(l['q'], C):
        valid = {o[2] for o in q.get('o') or []}
        k = ''.join(ch for ch in k if ch in valid)
        if not valid and k: k = ''
        q['c'] = {'k': k, 'q': full, 's': s}
        if not s: bad += 1
json.dump(D, open('data.json', 'w'), ensure_ascii=False, separators=(',', ':'))
print('merged; empty explanations:', bad)

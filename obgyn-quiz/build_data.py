import re,json,sys
D=json.load(open(sys.argv[2] if len(sys.argv)>2 else 'D.json'))
LAB=r'(?:[A-Ea-e]|[1-6]|[กขคงจ])'
lab_re=re.compile(r'^\s*\(?('+LAB+r')[\.\)]\s*(.*)$',re.S)
split_re=re.compile(r'\s{2,}(?=\(?'+LAB+r'[\.\)]\s)')
def norm(k):
    k=k.strip()
    if k in 'abcde': return k.upper()
    if k in '123456': return 'ABCDEF'['123456'.index(k)]
    if k in 'กขคงจ': return 'ABCDE'['กขคงจ'.index(k)]
    return k.upper()
def opts(o):
    parts=[]
    if all(re.match(r'^\s*[-•]\s',x) for x in o):
        for x in o: parts+=[p for p in re.split(r'\s*[-•]\s+',x) if p.strip()]
        parts=[p for p in parts if p.strip() not in ('(?)',)]
        out=[{'k':'ABCDEFGH'[i],'d':'ABCDEFGH'[i],'t':p.strip()} for i,p in enumerate(parts[:8])]
        return out if len(out)>=2 else None
    for x in o:
        parts+= [p for p in split_re.split(x) if p.strip()]
    out=[]
    for p in parts:
        m=lab_re.match(p)
        if not m: return None
        out.append({'k':norm(m.group(1)),'d':m.group(1),'t':m.group(2).strip()})
    ks=[x['k'] for x in out]
    if len(set(ks))!=len(ks) or len(out)<2: return None
    return out
import difflib
def nt(t):
    t=re.sub(r'\([^)]*\)','',t.lower()); t=re.sub(r'[^\w\u0e00-\u0e7f]+',' ',t)
    return t.strip()
def tmatch(text,o):
    a=nt(text)
    if len(a)<2: return None
    best=None;bs=0
    for x in o:
        b=nt(x['t'])
        if not b: continue
        r=difflib.SequenceMatcher(None,a,b).ratio()
        if a==b or (len(b)>=4 and b in a and len(b)>=0.5*len(a)) or (len(a)>=4 and a in b): r=max(r,0.95)
        if r>bs: bs=r;best=x['k']
    return best if bs>=0.72 else None
def keys2(a,o,first,single):
    valid={x['k'] for x in o}; found=[]
    for seg in re.split(r'\s/\s',a):
        seg=re.sub(r'^(ในไฟล์|โน้ต|เฉลย)\s*:\s*','',seg.strip())
        m=re.match(r'^\(?('+LAB+r')(?:[\.\)]\s*|\s+|$)(.*)$',seg,re.S)
        rest=m.group(2) if m else seg
        k=tmatch(rest,o)
        if not k and m and norm(m.group(1)) in valid and (first or single) and not nt(rest).strip() or (not k and m and norm(m.group(1)) in valid and first):
            k=norm(m.group(1))
        if not k and not m:
            k=tmatch(seg,o)
        if k and k not in found: found.append(k)
    return found
def keys(a,valid):
    # leading label(s): "B. xx", "B. xx / E. yy", "ในไฟล์: B มี * / C ติ๊กถูก"
    found=[]
    for seg in re.split(r'\s/\s',a):
        seg=re.sub(r'^(ในไฟล์|โน้ต|เฉลย)\s*:\s*','',seg.strip())
        m=re.match(r'^\(?('+LAB+r')(?:[\.\)]|\s|$)',seg)
        if m and norm(m.group(1)) in valid: found.append(norm(m.group(1)))
    return found
stats={'mcq':0,'mcq_noans':0,'open':0}
out=[]
for l in D['L']:
    qs=[]
    for q in l['q']:
        o=opts(q['o']) if q['o'] else None
        rec={'s':q['s'],'n':q['n'],'r':q['r'],'a':[[a['a'],a['f']] for a in q['ans']],
             'src':' · '.join(dict.fromkeys(f"{s['f']} น.{s['p']}" for s in q['src']))}
        if o:
            valid={x['k'] for x in o}
            ks=[]
            for i,a in enumerate(q['ans']):
                for k in keys2(a['a'],o,i==0,len(q['ans'])==1):
                    if k not in ks: ks.append(k)
            if not ks:
                for a in q['ans']:
                    m=re.search(r'(?:ไฮไลต์|เลือก|วง|กากบาท|ตอบ|ติ๊ก)\s*([A-Ea-eกขคงจ1-5])(?![A-Za-z0-9])',a['a'])
                    if m and norm(m.group(1)) in valid and norm(m.group(1)) not in ks: ks.append(norm(m.group(1)))
            rec['o']=[[x['d'],x['t'],x['k']] for x in o]; rec['k']=ks
            if ks: stats['mcq']+=1
            else: stats['mcq_noans']+=1
        else:
            if q['o']: rec['raw']=q['o']
            stats['open']+=1
        qs.append(rec)
    out.append({'c':l['c'],'t':l['t'],'w':l['w'],'d':l.get('d',''),'tc':l.get('tc',''),'ty':l.get('ty',''),'q':qs})
print(stats,file=sys.stderr)
json.dump({'L':out,'SRC':D['SRC']},open('data.json','w'),ensure_ascii=False,separators=(',',':'))
# debug samples
import random;random.seed(3)
allq=[q for l in out for q in l['q']]
if len(sys.argv)>1:
    mode=sys.argv[1]
    sel=[q for q in allq if (mode=='noans' and 'o' in q and not q['k']) or (mode=='raw' and 'raw' in q) or (mode=='multi' and 'o' in q and len(q['k'])>1)]
    for q in random.sample(sel,min(15,len(sel))): print(json.dumps({'o':q.get('o') or q.get('raw'),'k':q.get('k'),'a':q['a']},ensure_ascii=False)[:260])

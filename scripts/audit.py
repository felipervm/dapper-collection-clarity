"""Read-only audit of repository snapshots, not a live platform or chain audit."""
import json,collections,hashlib,pathlib,datetime,sqlite3
root=pathlib.Path(__file__).resolve().parents[1]
results=[]
for file in sorted((root/'data'/'sample').glob('*.json')):
    raw=file.read_bytes();p=json.loads(raw);owners=p.get('owners',[]);editions=p.get('editions',[])
    counts=collections.Counter();ids=[];unattributed=0
    for edition in editions:
        for serial in edition.get('serialsSampled',[]):
            ids.append(serial.get('flowId'))
            if serial.get('ownerFlowAddress'):counts[serial['ownerFlowAddress'].lower()]+=1
            else:unattributed+=1
    owner_addresses=[str(o.get('flowAddress','')).lower() for o in owners]
    db=sqlite3.connect(':memory:')
    db.execute('CREATE TABLE holders(address TEXT, reported INTEGER)')
    db.execute('CREATE TABLE observed(serial TEXT, address TEXT)')
    db.executemany('INSERT INTO holders VALUES (?,?)',[(str(o.get('flowAddress','')).lower(),o.get('holdings')) for o in owners])
    db.executemany('INSERT INTO observed VALUES (?,?)',[(str(s.get('flowId')),str(s.get('ownerFlowAddress','')).lower()) for e in editions for s in e.get('serialsSampled',[])])
    sql_count=db.execute((root/'scripts'/'audit.sql').read_text()).fetchone()[0]
    py_count=sum(o.get('holdings')!=counts[str(o.get('flowAddress','')).lower()] for o in owners)
    assert sql_count==py_count, 'Independent Python and SQL reconciliation must agree'
    db.close()
    results.append(dict(player=p.get('name'),file=str(file.relative_to(root)),sha256=hashlib.sha256(raw).hexdigest(),
        declaredPartial=p.get('partial'),reportedMintedSupply=p.get('totalMintedMomentCount'),editions=len(editions),owners=len(owners),
        observedSerials=len(ids),serialsWithoutOwner=unattributed,
        duplicateSerialIds=len(ids)-len(set(ids)),duplicateOwnerAddresses=len(owner_addresses)-len(set(owner_addresses)),
        ownerCountMismatches=sql_count,
        snapshotUpdateTime=p.get('generatedAt',p.get('updatedAt')),notes='Supply, sampled serials and holder counts are different quantities. partial is a source flag, not proof of an error.'))
report={'auditedAt':datetime.datetime.now(datetime.timezone.utc).isoformat(),'scope':'Three upstream repository samples only; no live API or independent on-chain reconciliation.','samples':results}
out=root/'case'/'audit.json';out.parent.mkdir(exist_ok=True);out.write_text(json.dumps(report,indent=2)+'\n',encoding='utf8')
print(json.dumps(report,indent=2))

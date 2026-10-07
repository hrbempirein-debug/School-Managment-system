import { describe, it, expect, beforeAll, afterAll, beforeEach, afterEach } from 'vitest';
import { randomUUID } from 'node:crypto';
import pg from 'pg';
import { getEnv } from '@sms/config';
const enabled = process.env.RUN_RUNTIME_SECURITY_TESTS === '1';
const describeDb = enabled ? describe : describe.skip;
let migrator: pg.Client; let app: pg.Client;
const uid: Record<string,string>={};
const u=(k:string)=>{const v=uid[k]; if(!v) throw new Error('m'); return v;};
type Row=Record<string,unknown>; const mig=async(s:string)=> (await migrator.query(s)).rows as Row[];
const q=(v:string)=>`'${v}'`;
const reject = async(sql:string, code:string)=>{
  const tag=randomUUID().replace(/-/g,'');
  await migrator.query(`savepoint r_${tag}`);
  try{await migrator.query(sql);}catch(e:any){await migrator.query(`rollback to savepoint r_${tag}`); if(e.code!==code) throw e; return e.message;}
  await migrator.query(`rollback to savepoint r_${tag}`); throw new Error('should fail');
};
describeDb('0027 reconciliation',()=>{
  beforeAll(async()=>{
    const env=getEnv(); migrator=new pg.Client({connectionString:env.DATABASE_URL_MIGRATOR}); app=new pg.Client({connectionString:env.DATABASE_URL_APP});
    await migrator.connect(); await app.connect();
    for(const k of ['tenantA','tenantB','userA']) uid[k]=randomUUID();
    await mig(`insert into tenants (id,slug,name) values (${q(u('tenantA'))},'a-${randomUUID().slice(0,8)}','A')`);
    await mig(`insert into tenants (id,slug,name) values (${q(u('tenantB'))},'b-${randomUUID().slice(0,8)}','B')`);
    await mig(`insert into users (id,email) values (${q(u('userA'))},'u${randomUUID().slice(0,8)}@x')`);
  });
  afterAll(async()=>{await app.end().catch(()=>{}); await migrator.end().catch(()=>{});});
  beforeEach(async()=>{await app.query('begin');});
  afterEach(async()=>{await app.query('rollback').catch(()=>{});});
  it('objects exist', async()=>{
    const t=await mig("select count(*)::int n from pg_tables where tablename like 'fin_recon%'");
    expect(t[0]!.n).toBe(2);
    const trig=await mig("select count(*)::int n from pg_proc p join pg_namespace n on n.oid=p.pronamespace where p.proname in ('trg_fin_recon_is_final','trg_fin_recon_batch_derive_totals','trg_fin_recon_batch_stamp_matches') and n.nspname='public'");
    expect(trig[0]!.n).toBe(3);
    const idx=await mig("select count(*)::int n from pg_index x join pg_class c on c.oid=x.indexrelid join pg_namespace n on n.oid=c.relnamespace where c.relname='fin_recon_payment_final_uq' and n.nspname='public' and x.indpred is not null");
    expect(idx[0]!.n).toBe(1);
  });
});

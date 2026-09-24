import {beforeEach,describe,it,expect,vi} from 'vitest';
const mocks=vi.hoisted(()=>({query:vi.fn(),encrypt:vi.fn(()=>({ciphertext:'encrypted',nonce:'nonce',authTag:'tag',keyId:'key',fingerprint:'a'.repeat(64)})),decrypt:vi.fn(()=> '123 Private Business St')}));
vi.mock('../../src/db.js',()=>({db:{query:mocks.query,transaction:(work:(q:unknown)=>unknown)=>work(mocks.query)}}));
vi.mock('../../src/services/TaskLocationCrypto.js',()=>({encryptTaskLocation:mocks.encrypt,decryptTaskLocation:mocks.decrypt}));
vi.mock('../../src/services/BusinessTestPayoutDestinationService.js',()=>({ensureBusinessTestPayoutDestination:vi.fn()}));
vi.mock('../../src/logger.js',()=>({logger:{child:()=>({warn:vi.fn(),error:vi.fn()})}}));
import {saveBusinessAddress,getBusinessAddress,selectBusinessServices} from '../../src/services/BusinessWorkspaceService.js';
const organizationId='10000000-0000-4000-8000-000000000001';
const actorId='20000000-0000-4000-8000-000000000001';
const id='30000000-0000-4000-8000-000000000001';
function defaults(sql:string){
  if(sql.includes('business_require_action')) return {rows:[{id:organizationId}]};
  if(sql.includes('SELECT id FROM business_locations')) return {rows:[{id}]};
  if(sql.includes('FROM service_categories')) return {rows:[{id,code:'cleaning',display_name:'Cleaning'},{id:actorId,code:'plumbing',display_name:'Plumbing'}]};
  return {rows:[],rowCount:1};
}
describe('Stage-1 business setup',()=>{
  beforeEach(()=>{vi.clearAllMocks();mocks.query.mockImplementation(async(sql:string)=>defaults(sql));});
  it('updates the authoritative business address using encryption and never customer task storage',async()=>{
    const exactAddress='123 Private Business St';
    expect(await saveBusinessAddress({actorId,organizationId,exactAddress,roughLocation:'Seattle',postalCode:'98101',regionCode:'US-WA',timezone:'America/Los_Angeles'})).toEqual({id});
    expect(mocks.encrypt).toHaveBeenCalledWith(id,exactAddress);
    const insert=mocks.query.mock.calls.find(([sql])=>sql.includes('INSERT INTO business_locations'));
    expect(insert?.[0]).toContain("'BUSINESS_ADDRESS'");
    expect(insert?.[1]).not.toContain(exactAddress);
    expect(mocks.query.mock.calls.map(([sql])=>sql).join('\n')).not.toContain('task_locations');
  });
  it('requires current permission before decrypting address',async()=>{
    mocks.query.mockResolvedValue({rows:[]});
    await expect(getBusinessAddress(actorId,organizationId)).rejects.toMatchObject({code:'FORBIDDEN'});
    expect(mocks.decrypt).not.toHaveBeenCalled();
  });
  it('selects multiple canonical services without operational activation, coverage or payout checks',async()=>{
    expect(await selectBusinessServices({actorId,organizationId,serviceCodes:['cleaning','plumbing']})).toEqual({ok:true});
    const inserts=mocks.query.mock.calls.filter(([sql])=>sql.includes('INSERT INTO business_service_profiles'));
    expect(inserts).toHaveLength(2);
    expect(inserts[0][0]).toContain('ON CONFLICT(organization_id,service_code)');
    expect(inserts[0][0]).toContain("'DRAFT',true,'DECLARED'");
    const sql=mocks.query.mock.calls.map(([value])=>value).join('\n');
    expect(sql).not.toMatch(/activate_business|payout_status|coverage_postal_codes|weekly_capacity_slots/);
  });
  it('fails closed for unknown categories before changing selections',async()=>{
    await expect(selectBusinessServices({actorId,organizationId,serviceCodes:['custom_unknown']})).rejects.toMatchObject({code:'BAD_REQUEST'});
    expect(mocks.query.mock.calls.some(([sql])=>sql.includes('UPDATE business_service_profiles'))).toBe(false);
  });
  it('de-selects services without deleting historical profiles or credentials',async()=>{
    mocks.query.mockImplementation(async(sql:string)=>sql.includes('FROM service_categories')?{rows:[]}:defaults(sql));
    await selectBusinessServices({actorId,organizationId,serviceCodes:[]});
    expect(mocks.query.mock.calls.map(([sql])=>sql).join('\n')).toContain('selected_by_business=false');
    expect(mocks.query.mock.calls.map(([sql])=>sql).join('\n')).not.toMatch(/DELETE FROM|UPDATE business_credentials/);
  });
});

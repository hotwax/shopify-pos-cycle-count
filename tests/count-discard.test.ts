import assert from 'node:assert/strict';
import {test} from 'node:test';
import {handleWorkflow} from '../shared/oms-count-workflows.ts';
import {configureDirectOms, type OmsConnection} from '../shared/oms-connection.ts';
import type {Context} from '../shared/oms-count.ts';

const path='/rest/s1/inventory-cycle-count/cycleCounts/workEfforts/count-1';
const identity={shop:'https://gorjana-sandbox.myshopify.com',shopifyUserId:'1',shopifyLocationId:'2',shopifyStaffMemberId:'1'};
const ctx={facilityId:'brooklyn',canDiscard:true} as Context;
configureDirectOms('https://test-maarg.hotwax.io');

// Exercise the POS adapter's request order and retry behavior. The deployed
// API contract is defined by the existing Inventory Count client and REST service.
test('discard retries the count update after its sessions have been voided',async()=>{
  const work={workEffortId:'count-1',facilityId:'brooklyn',workEffortTypeId:'CYCLE_COUNT_RUN',
    workEffortPurposeTypeId:'DYNAMIC_COUNT',statusId:'CYCLE_CNT_IN_PRGS'};
  const sessions=[{inventoryCountImportId:'session-1',statusId:'SESSION_ASSIGNED'},
    {inventoryCountImportId:'session-2',statusId:'SESSION_SUBMITTED'}];
  const writes:unknown[]=[];
  let fail=true;
  const oms={
    get:async(url:string)=>url===path?{...work}:sessions.map(session=>({...session})),
    mutate:async(url:string,payload:{statusId?:string;InventoryCountImport?:typeof sessions},method:string)=>{
      assert.equal(url,path);assert.equal(method,'PUT');
      writes.push(payload);
      if(payload.InventoryCountImport) {
        for(const session of sessions)session.statusId='SESSION_VOIDED';
      } else {
        if(fail){fail=false;throw Error('Interrupted before count update');}
        work.statusId=payload.statusId!;
      }
    },
  } as unknown as OmsConnection;
  const discard=()=>handleWorkflow(identity,{action:'discardCount',workEffortId:'count-1'},ctx,oms);
  await assert.rejects(discard(),/Interrupted/);
  const result=await discard() as {statusId:string};
  assert.equal(result.statusId,'CYCLE_CNT_CNCL');
  assert.deepEqual(writes,[
    {workEffortId:'count-1',InventoryCountImport:[
      {inventoryCountImportId:'session-1',statusId:'SESSION_VOIDED'},
      {inventoryCountImportId:'session-2',statusId:'SESSION_VOIDED'},
    ]},
    {workEffortId:'count-1',statusId:'CYCLE_CNT_CNCL'},
    {workEffortId:'count-1',statusId:'CYCLE_CNT_CNCL'},
  ]);
});

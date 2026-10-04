import {OmsConnection, OmsLookupError, rows, text, requireCountConnection, type OmsRow} from './oms-connection';
import {BASE, countWork, sessionRows, resource, type Context, type CountIdentity} from './oms-count';
import {countableProducts} from './oms-count-products';
import {COUNT_TYPES} from './count-types';

// Date pickers return a calendar day. Convert its wall-clock boundary in the
// facility zone, including a DST offset change between the start and due days.
export function countDate(day: string, zone: string, end=false) {
  if(!/^\d{4}-\d{2}-\d{2}$/.test(day))throw new OmsLookupError('Choose a valid count date.',400);
  const [y,m,d]=day.split('-').map(Number),wall=Date.UTC(y,m-1,d,end?23:0,end?59:0,end?59:0);
  if(new Date(wall).toISOString().slice(0,10)!==day)throw new OmsLookupError('Choose a valid count date.',400);
  let stamp=wall;
  const format=new Intl.DateTimeFormat('en-GB',{timeZone:zone,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit',second:'2-digit',hourCycle:'h23'});
  for(let i=0;i<3;i++){
    const parts=Object.fromEntries(format.formatToParts(stamp).map(p=>[p.type,p.value]));
    const local=Date.UTC(Number(parts.year),Number(parts.month)-1,Number(parts.day),Number(parts.hour),Number(parts.minute),Number(parts.second));
    stamp+=wall-local;
  }
  return stamp+(end?999:0);
}

export function countSchedule(payload: OmsRow, zone: string, now=Date.now()) {
  const start=payload.startDate?countDate(text(payload.startDate),zone):undefined;
  const due=payload.dueDate?countDate(text(payload.dueDate),zone,true):undefined;
  if(due!==undefined&&(due<now||(start!==undefined&&start>due)))
    throw new OmsLookupError('Choose a due date on or after the start date and today.',400);
  return {...(start!==undefined?{estimatedStartDate:start}:{}),...(due!==undefined?{estimatedCompletionDate:due}:{})};
}

export async function handleCountCreation(identity: CountIdentity,payload: OmsRow,ctx: Context,oms: OmsConnection) {
  if(payload.action!=='createCount')return undefined;
  requireCountConnection(identity.shop);
  if(!ctx.canCreate)throw new OmsLookupError('Your OMS account cannot create a count.',403);
  const operation=text(payload.operationId),name=text(payload.name).trim(),type=text(payload.type);
  if(!/^[a-f0-9]{15}$/.test(operation)||!name||name.length>100||!COUNT_TYPES.includes(type))throw new OmsLookupError('Enter a name and choose a count type.',400);
  const ids=Array.isArray(payload.productIds)?payload.productIds.map(text):[];
  if(ids.length>2000||new Set(ids).size!==ids.length||ids.some(id=>!id||id.length>80)||(!ids.length&&type==='DIRECTED_COUNT'))throw new OmsLookupError('Select up to 2,000 products for this count. Directed counts need a product list.',400);
  if(type==='DYNAMIC_COUNT'&&ids.length)throw new OmsLookupError('Dynamic counts build their product list as you count. Leave the starting list empty.',400);
  if(!Number.isFinite(Number(payload.createdAt))||Number(payload.createdAt)<=0)throw new OmsLookupError('The count creation time is missing. Reopen Create count.',400);
  const zone=ctx.timeZone||text(payload.timeZone)||'UTC';
  const schedule=countSchedule(payload,zone);
  if(type==='DYNAMIC_COUNT'){
    const enabled=rows(await oms.get('/rest/s1/admin/enums?enumTypeId=CYCLE_CNT_PURPOSE&enumId=DYNAMIC_COUNT&pageSize=2'));
    if(!enabled.some(item=>text(item.enumId)==='DYNAMIC_COUNT'))throw new OmsLookupError('Dynamic counting needs to be enabled in this OMS by your administrator.',409);
  }
  let id=`POSC_${operation}`;
  const found=await oms.get(`${BASE}/workEfforts?${new URLSearchParams({facilityId:ctx.facilityId,statusId:'CYCLE_CNT_CREATED,CYCLE_CNT_IN_PRGS',keyword:name,pageSize:'101'})}`);
  const counts=rows(found.cycleCounts),own=counts.find(w=>text(w.workEffortId)===id);
  if(!own){
    const duplicate=counts.filter(w=>text(w.workEffortName)===name);
    if(duplicate.length&&!payload.existingCountId)return {duplicate:duplicate.map(w=>({workEffortId:text(w.workEffortId),name:text(w.workEffortName),type:text(w.workEffortPurposeTypeId)}))};
    if(payload.existingCountId){
      const chosen=await countWork(text(payload.existingCountId),ctx,oms);
      if(text(chosen.workEffortName)!==name||text(chosen.workEffortPurposeTypeId)!==type||!['CYCLE_CNT_CREATED','CYCLE_CNT_IN_PRGS'].includes(text(chosen.statusId)))throw new OmsLookupError('The existing count changed. Choose a different name or refresh.',409);
      if(!ids.length)throw new OmsLookupError('Select products to add to the existing count.',400);
      id=text(chosen.workEffortId);
    }
  }
  // A creation operation owns one seed session even when appending to an
  // existing count. Stable row IDs allow an interrupted seed to be resumed.
  const sessionId=`POSI_${operation}`;
  const products=await countableProducts(ids,ctx.preferences,oms,true);
  if(!own&&!payload.existingCountId)await oms.mutate(`${BASE}/workEfforts`,{workEffortId:id,workEffortName:name,workEffortTypeId:'CYCLE_COUNT_RUN',workEffortPurposeTypeId:type,
    statusId:'CYCLE_CNT_CREATED',facilityId:ctx.facilityId,createdByUserLogin:ctx.username,createdDate:Number(payload.createdAt),...schedule});
  const work=await countWork(id,ctx,oms);
  if(text(work.workEffortName)!==name||text(work.workEffortPurposeTypeId)!==type)throw new OmsLookupError('Count creation identity conflict.',409);
  const sessions=rows(await oms.get(`${BASE}/workEfforts/${encodeURIComponent(id)}/sessions?pageSize=501`));
  const existing=sessions.find(s=>text(s.inventoryCountImportId)===sessionId);
  if(existing&&text(existing.uploadedByUserLogin)!==ctx.username)throw new OmsLookupError('Session creation identity conflict.',409);
  if(!existing)await oms.mutate(`${BASE}/workEfforts/${encodeURIComponent(id)}/sessions`,{inventoryCountImportId:sessionId,workEffortId:id,countImportName:name,facilityAreaId:'register',statusId:'SESSION_CREATED',uploadedByUserLogin:ctx.username,createdDate:Date.now()});
  const present=new Set((await sessionRows(sessionId,oms)).map(row=>text(row.productId))),missing=ids.filter(productId=>!present.has(productId));
  for(let i=0;i<Math.min(missing.length,1000);i+=250)await oms.mutate(`${resource(sessionId)}/items`,{items:missing.slice(i,i+250).map(productId=>({uuid:`${sessionId}:${productId}`,productId,productIdentifier:products.get(productId)!.sku,isRequested:'Y',createdByUserLoginId:ctx.username,createdDate:Date.now()}))},'PUT');
  return {workEffortId:id,sessionId,preparing:missing.length>1000,remaining:Math.max(0,missing.length-1000)};
}

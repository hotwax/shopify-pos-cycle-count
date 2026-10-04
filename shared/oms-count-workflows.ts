import {sessionLease,activeSessionLease,describe as describeLease,leaseDevice} from './oms-count-lease';
import {COUNT_TYPES} from './count-types';
import {OmsConnection, OmsLookupError, rows, text, requireCountConnection, type OmsRow} from './oms-connection';
import {BASE, EDITABLE, countWork, countDetail, sessionRows, productDetails, validId, resource, number, type Context, type CountIdentity, canPreviewCount, requirePreview, ownedCount, withCountLock} from './oms-count';

export const AREAS = [
  {id: 'back_stock', name: 'Back stock'}, {id: 'display', name: 'Display'},
  {id: 'floor_wall', name: 'Floor wall'}, {id: 'floor_shelf', name: 'Floor shelf'},
  {id: 'overflow', name: 'Overflow'}, {id: 'register', name: 'Register'},
];
const workPath = (id: string) => `${BASE}/workEfforts/${validId(id)}`;
function page(value: unknown) {
  const index = Number(value ?? 0);
  if (!Number.isSafeInteger(index) || index < 0 || index > 10000) throw new OmsLookupError('Invalid page.', 400);
  return index;
}
function operation(value: unknown) {
  const id = text(value);
  if (!/^[a-f0-9]{15}$/.test(id)) throw new OmsLookupError('Invalid operation ID.', 400);
  return id;
}
function summary(work: OmsRow) {
  return {workEffortId: text(work.workEffortId), name: text(work.workEffortName), type: text(work.workEffortPurposeTypeId),
    statusId: text(work.statusId), startDate: work.estimatedStartDate, dueDate: work.estimatedCompletionDate,
    createdDate: work.createdDate, completedDate: work.actualCompletionDate};
}
export async function countSessions(id: string, oms: OmsConnection) {
  const sessions = rows(await oms.get(`${workPath(id)}/sessions?pageSize=501&orderByField=createdDate,inventoryCountImportId`));
  if (sessions.length > 500) throw new OmsLookupError('This count has more than 500 sessions. Manage it in HotWax.');
  return sessions;
}
function sessionSummary(s: OmsRow, ctx: Context, work: OmsRow) {
  return {sessionId: text(s.inventoryCountImportId), name: text(s.countImportName), area: text(s.facilityAreaId),
    operator: text(s.uploadedByUserLogin), statusId: text(s.statusId), createdDate: s.createdDate,
    mine: text(s.uploadedByUserLogin) === ctx.username,
    editable: EDITABLE.has(text(s.statusId)) && text(work.statusId) === 'CYCLE_CNT_IN_PRGS'};
}
async function overview(id: string, ctx: Context, oms: OmsConnection) {
  const work = await countWork(id, ctx, oms), sessions = await countSessions(id, oms);
  return {...summary(work), sessions: sessions.map(s => sessionSummary(s, ctx, work)), areas: AREAS,
    canCreateSession: text(work.statusId) === 'CYCLE_CNT_IN_PRGS', canComplete: ctx.canSubmit, canPreview:canPreviewCount(work,ctx),
    canStart: text(work.statusId) === 'CYCLE_CNT_CREATED' && (Number(work.estimatedStartDate || 0) <= Date.now() || ctx.canPrestart)};
}
async function reviewRows(id: string, oms: OmsConnection) {
  const result: OmsRow[] = [];
  for (let index = 0; true; index++) {
    const found = rows(await oms.get(`${workPath(id)}/reviews?${new URLSearchParams({pageSize:'500',pageIndex:String(index),orderByField:'productId'})}`));
    result.push(...found);
    if (found.length < 500) return result;
  }
  throw new OmsLookupError('Count progress could not be fully loaded.');
}
async function facilityProducts(ctx: Context, oms: OmsConnection) {
  const found = new Map<string, OmsRow>();
  for (let index = 0; true; index++) {
    const result = await oms.postRead('/rest/s1/oms/dataDocumentView', {dataDocumentId:'ProductFacilityAndInventoryItem',pageSize:500,pageIndex:index,customParametersMap:{facilityId:ctx.facilityId}});
    if (!Array.isArray(result.entityValueList)) throw new OmsLookupError('HotWax did not return the facility product scope. Completion is unavailable.');
    const list = rows(result.entityValueList);
    for (const item of list) found.set(text(item.productId), item);
    if (list.length < 500) return found;
  }
  throw new OmsLookupError('Facility product scope is incomplete. Completion is unavailable.');
}
export async function countProgress(id: string, ctx: Context, oms: OmsConnection, hydrate = true) {
  const work=await countWork(id,ctx,oms);requirePreview(work,ctx);
  const [info, reviewed] = await Promise.all([overview(id, ctx, oms), reviewRows(id, oms)]);
  const combined = new Map(reviewed.map(row => [text(row.productId), row]));
  if (info.type === 'HARD_COUNT') for (const [productId, item] of await facilityProducts(ctx, oms)) {
    if (!combined.has(productId)) combined.set(productId, {productId,quantity:null,isRequested:'Y',quantityOnHand:item.quantityOnHandTotal});
  }
  const {details} = hydrate ? await productDetails([...combined.keys()], {...ctx, canViewOnHand:false}, oms) : {details:new Map<string,OmsRow>()};
  const items = [...combined].map(([productId, row]) => ({...details.get(productId)?.presentation as object, productId,
    title:text(details.get(productId)?.productName || details.get(productId)?.internalName || row.internalName || productId),
    sku:text(details.get(productId)?.internalName || row.internalName || productId), quantity:number(row.quantity),
    lastUpdatedAt:Number(row.maxLastUpdatedAt || 0),
    isRequested: info.type === 'HARD_COUNT' || text(row.isRequested) !== 'N',
    sessions:Number(row.numberOfSessions || 0), decision:text(row.decisionOutcomeEnumId),
    ...(ctx.canViewOnHand ? {onHand:number(row.quantityOnHand), delta:number(row.quantity) === null || number(row.quantityOnHand) === null ? null : Number(row.quantity)-Number(row.quantityOnHand)} : {}),
  }));
  const live = info.sessions.filter(s => s.statusId !== 'SESSION_VOIDED');
  const openSessions = live.filter(s => EDITABLE.has(s.statusId)).length;
  const uncounted = items.filter(i => i.isRequested && i.quantity === null).length;
  const undirected = items.filter(i => !i.isRequested && i.decision !== 'SKIPPED').length;
  return {...info, items, units:items.reduce((n,i)=>n+(i.quantity ?? 0),0), openSessions, uncounted, undirected,
    allSubmitted: live.length > 0 && live.every(s => ['SESSION_SUBMITTED','SESSION_APPROVED'].includes(s.statusId)),
    canFinish: info.canComplete && info.statusId === 'CYCLE_CNT_IN_PRGS' && live.length > 0 && live.every(s => s.statusId === 'SESSION_SUBMITTED') && uncounted === 0};
}
async function createSession(id: string, payload: OmsRow, ctx: Context, oms: OmsConnection) {
  const work = await countWork(id, ctx, oms);
  if (text(work.statusId) !== 'CYCLE_CNT_IN_PRGS') throw new OmsLookupError('Start this count before creating a session.',409);
  const sessionId = `POSI_${operation(payload.operationId)}`, sessions = await countSessions(id, oms);
  const name = text(payload.name).trim();
  if (!name || name.length > 100 || !AREAS.some(a=>a.id === payload.area)) throw new OmsLookupError('Enter a session name and choose a session location.',400);
  const existing = sessions.find(s=>text(s.inventoryCountImportId)===sessionId);
  if (existing && (text(existing.uploadedByUserLogin)!==ctx.username || text(existing.countImportName)!==name || text(existing.facilityAreaId)!==payload.area))
    throw new OmsLookupError('Session creation identity conflict.',409);
  const directed = text(work.workEffortPurposeTypeId) === 'DIRECTED_COUNT';
  // Seed from the original session, as the HotWax web app does. Stable IDs make
  // an interrupted copy recoverable without creating a second session or row.
  const source = sessions.find(s=>text(s.inventoryCountImportId)!==sessionId && text(s.statusId)!=='SESSION_VOIDED');
  if (directed && !source) throw new OmsLookupError('This directed count has no requested product list. Add its scope in HotWax first.');
  const requested: OmsRow[]=[];
  if(directed)for(const seed of sessions.filter(s=>text(s.inventoryCountImportId)!==sessionId&&text(s.statusId)!=='SESSION_VOIDED'))requested.push(...(await sessionRows(text(seed.inventoryCountImportId),oms)).filter(row=>text(row.isRequested)!=='N'));
  const scope = new Map(requested.map(row=>[text(row.productId),row]));
  if (directed && !scope.size) throw new OmsLookupError('The directed product list is empty. Check its scope in HotWax.');
  if (!existing) await oms.mutate(`${workPath(id)}/sessions`, {inventoryCountImportId:sessionId,workEffortId:id,countImportName:name,
    statusId:'SESSION_CREATED',uploadedByUserLogin:ctx.username,createdDate:Date.now(),facilityAreaId:payload.area});
  if (directed) {
    const present = new Set((await sessionRows(sessionId,oms)).map(row=>text(row.productId)));
    const missing = [...scope].filter(([productId])=>!present.has(productId));
    // At most 1,000 seeds per request keeps work within the native operation deadline.
    for (let offset=0;offset<Math.min(missing.length,1000);offset+=250) await oms.mutate(`${resource(sessionId)}/items`, {items:missing.slice(offset,offset+250).map(([productId,row])=>({
      uuid:`${sessionId}:${productId}`,productId,productIdentifier:row.productIdentifier,isRequested:'Y',createdByUserLoginId:ctx.username,createdDate:Date.now(),
    }))},'PUT');
    if (missing.length>1000) return {preparing:true,sessionId,remaining:missing.length-1000};
  }
  return {preparing:false,session:await countDetail(sessionId,ctx,oms)};
}

export async function handleWorkflow(identity: CountIdentity, payload: OmsRow, ctx: Context, oms: OmsConnection): Promise<unknown> {
  const action=text(payload.action), id=text(payload.workEffortId);
  if (action==='storeCounts') {
    const pageIndex=page(payload.pageIndex), group=text(payload.group)||'active';
    const statusId = {active:'CYCLE_CNT_CREATED,CYCLE_CNT_IN_PRGS',submitted:'CYCLE_CNT_CMPLTD',history:'CYCLE_CNT_CLOSED,CYCLE_CNT_CNCL'}[group];
    if (!statusId) throw new OmsLookupError('Invalid count list.',400);
    const type = text(payload.type);
    if (type && !COUNT_TYPES.includes(type)) throw new OmsLookupError('Invalid count type.',400);
    const result=await oms.get(`${BASE}/workEfforts?${new URLSearchParams({facilityId:ctx.facilityId,statusId,pageIndex:String(pageIndex),pageSize:'20',orderByField:'-createdDate',keyword:text(payload.search).trim().slice(0,100),...(type?{countType:type}:{})})}`);
    return {facilityName:ctx.facilityName,userName:ctx.userName,canCreate:ctx.canCreate,canSubmit:ctx.canSubmit,canViewOnHand:ctx.canViewOnHand,timeZone:ctx.timeZone,barcodeType:ctx.preferences.barcode,
      pageIndex,total:Number(result.cycleCountsCount),nextPage:(pageIndex+1)*20<Number(result.cycleCountsCount)?pageIndex+1:null,
      counts:rows(result.cycleCounts).filter(w=>COUNT_TYPES.includes(text(w.workEffortPurposeTypeId))).map(w=>({...summary(w),sessions:rows(w.sessions).length,
        mySessions:rows(w.sessions).filter(s=>text(s.uploadedByUserLogin)===ctx.username).length}))};
  }
  if (action==='overview') return overview(id,ctx,oms);
  if (action==='sessionLocks') {
    await countWork(id,ctx,oms);
    const ids=Array.isArray(payload.sessionIds)?[...new Set(payload.sessionIds.map(text))]:[];
    if(ids.length>20)throw new OmsLookupError('Request session locks one page at a time.',400);
    const sessions=await countSessions(id,oms),allowed=new Set(sessions.filter(s=>EDITABLE.has(text(s.statusId))).map(s=>text(s.inventoryCountImportId)));
    if(ids.some(sessionId=>!allowed.has(sessionId)))throw new OmsLookupError('Refresh the session list before checking its locks.',409);
    if(!ids.length)return {items:[]};
    const result=await oms.postRead('/rest/s1/oms/dataDocumentView',{dataDocumentId:'InventoryCountImportLock',filterByDate:true,pageIndex:0,pageSize:101,
      customParametersMap:{inventoryCountImportId:ids.join(','),inventoryCountImportId_op:'in'}});
    if(!Array.isArray(result.entityValueList)||result.entityValueList.length>100)throw new OmsLookupError('Session locks could not be verified. Refresh the summary.');
    const locks=rows(result.entityValueList),device=leaseDevice(identity.deviceId);
    return {items:ids.map(sessionId=>({sessionId,...describeLease(activeSessionLease(locks.filter(row=>text(row.inventoryCountImportId)===sessionId)),ctx.username,device)}))};
  }
  if (action==='progress') return countProgress(id,ctx,oms);
  if (action==='contributions') {
    requirePreview(await countWork(id,ctx,oms),ctx);
    const productId=text(payload.productId);validId(productId);
    const values=rows(await oms.get(`${workPath(id)}/count?${new URLSearchParams({productId,pageSize:'501',orderByField:'inventoryCountImportId'})}`));
    if(values.length>500) throw new OmsLookupError('Too many session contributions. Review in HotWax.');
    return {items:values.filter(s=>text(s.statusId)!=='SESSION_VOIDED').map(s=>({sessionId:text(s.inventoryCountImportId),name:text(s.countImportName),operator:text(s.uploadedByUserLogin),quantity:number(s.counted),statusId:text(s.statusId),editable:ctx.canSubmit&&text(s.statusId)!=='SESSION_APPROVED'}))};
  }
  if(action==='editContribution'){
    requireCountConnection(identity.shop);
    if(!ctx.canSubmit)throw new OmsLookupError('Your OMS account cannot edit team contributions.',403);
    const sessionId=text(payload.sessionId),productId=text(payload.productId),quantity=Number(payload.quantity);
    const {session,work}=await ownedCount(sessionId,ctx,oms,true);
    if(text(work.workEffortId)!==id||!['SESSION_CREATED','SESSION_ASSIGNED','SESSION_SUBMITTED'].includes(text(session.statusId)))throw new OmsLookupError('This contribution is no longer editable.',409);
    if(!Number.isSafeInteger(quantity)||quantity<0||quantity>1000000)throw new OmsLookupError('Enter a whole quantity between 0 and 1,000,000.',400);
    const edit=async()=>{
      const latest=await ownedCount(sessionId,ctx,oms,true);
      if(!['SESSION_CREATED','SESSION_ASSIGNED','SESSION_SUBMITTED'].includes(text(latest.session.statusId)))throw new OmsLookupError('This session is no longer editable.',409);
      const records=await sessionRows(sessionId,oms,productId);
      const current=records.some(r=>number(r.quantity)!==null)?records.reduce((sum,r)=>sum+(number(r.quantity)||0),0):null;
      if(!records.length||(current!==number(payload.expectedQuantity)&&current!==quantity))throw new OmsLookupError('This contribution changed. Refresh the team total before editing.',409);
      if(records.some(r=>!r.uuid))throw new OmsLookupError('This session has legacy rows without unique IDs. Reopen it in HotWax before editing.',409);
      await oms.mutate(`${resource(sessionId)}/items`,{items:records.map((r,i)=>({uuid:r.uuid,productId,quantity:i===0?quantity:0,countedByUserLoginId:ctx.username}))},'PUT');
      const saved=await sessionRows(sessionId,oms,productId);
      if(saved.reduce((sum,r)=>sum+(number(r.quantity)||0),0)!==quantity)throw new OmsLookupError('HotWax did not confirm the updated contribution. Refresh before retrying.',409);
      return {saved:true};
    };
    // OMS only issues counting leases for CREATED/ASSIGNED sessions. Ionic's
    // submitted-contribution edit uses the item API without reopening the session.
    if(text(session.statusId)==='SESSION_SUBMITTED'){
      if(await sessionLease(sessionId,oms))throw new OmsLookupError('This session is still locked. Release it before editing its contribution.',409);
      return edit();
    }
    return withCountLock(sessionId,ctx,oms,edit,undefined,identity.deviceId);
  }
  if (!['createSession','startCount','completeCount','confirmZero','discardUndirected'].includes(action)) return undefined;
  requireCountConnection(identity.shop);
  if (action==='createSession') return createSession(id,payload,ctx,oms);
  const work=await countWork(id,ctx,oms);
  if (action==='startCount') {
    if (text(work.statusId)==='CYCLE_CNT_IN_PRGS') return overview(id,ctx,oms);
    if(text(work.statusId)!=='CYCLE_CNT_CREATED' || (Number(work.estimatedStartDate || 0)>Date.now() && !ctx.canPrestart)) throw new OmsLookupError('This scheduled count cannot be started yet.',403);
    await oms.mutate(workPath(id),{statusId:'CYCLE_CNT_IN_PRGS',actualStartDate:Date.now()},'PUT');
    return overview(id,ctx,oms);
  }
  if(!ctx.canSubmit) throw new OmsLookupError('Your OMS account cannot manage count completion.',403);
  if(action==='completeCount' && text(work.statusId)==='CYCLE_CNT_CMPLTD') return overview(id,ctx,oms);
  if(text(work.statusId)!=='CYCLE_CNT_IN_PRGS') throw new OmsLookupError('This count is no longer open.',409);
  const progress=await countProgress(id,ctx,oms,false);
  if(action==='completeCount') {
    if(!progress.canFinish) throw new OmsLookupError('Submit every session and explicitly count or confirm zero for every requested product first.',409);
    // The existing OMS REST contract has no atomic count-wide completion service.
    // Recheck sessions immediately before transition; never approve/apply inventory.
    const fresh=await countSessions(id,oms);
    if(fresh.some(s=>EDITABLE.has(text(s.statusId)))) throw new OmsLookupError('A session was opened while you reviewed. Refresh progress.',409);
    await oms.mutate(workPath(id),{statusId:'CYCLE_CNT_CMPLTD'},'PUT');
    return overview(id,ctx,oms);
  }
  if(!progress.allSubmitted) throw new OmsLookupError('Submit all sessions before confirming missing products or discarding extras.',409);
  const selected=Array.isArray(payload.productIds)?payload.productIds.map(text):[];
  if(!selected.length || selected.length>25 || new Set(selected).size!==selected.length) throw new OmsLookupError('Choose between 1 and 25 products.',400);
  const items=selected.map(productId=>progress.items.find(i=>i.productId===productId));
  if(items.some(i=>!i)) throw new OmsLookupError('A selected product is no longer in this count.',409);
  if(action==='confirmZero') {
    const sessionId=`POSZ_${operation(payload.operationId)}`;
    // A repeated request may already have written zeros. It must never zero a
    // product counted meanwhile by another operator.
    const prior=await countSessions(id,oms), existing=prior.find(s=>text(s.inventoryCountImportId)===sessionId);
    if(existing && text(existing.uploadedByUserLogin)!==ctx.username) throw new OmsLookupError('Zero confirmation identity conflict.',409);
    const already=existing ? await sessionRows(sessionId,oms) : [];
    if(items.some(i=>!i!.isRequested || (i!.quantity!==null && !(i!.quantity===0 && already.some(row=>text(row.productId)===i!.productId)))))
      throw new OmsLookupError('A selected product has already been counted. Refresh progress.',409);
    if(!existing) await oms.mutate(`${workPath(id)}/sessions`,{inventoryCountImportId:sessionId,workEffortId:id,countImportName:'Confirmed zero in POS',statusId:'SESSION_SUBMITTED',uploadedByUserLogin:ctx.username,createdDate:Date.now(),facilityAreaId:'register'});
    const zeroBalances=rows(await oms.get(`/rest/s1/oms/productFacilities/inventory?${new URLSearchParams({facilityId:ctx.facilityId,productId:selected.join(','),productId_op:'in',pageSize:'26'})}`));
    await oms.mutate(`${resource(sessionId)}/items`,{items:items.map(i=>({uuid:`${sessionId}:${i!.productId}`,productId:i!.productId,productIdentifier:i!.sku,quantity:0,isRequested:'Y',countedByUserLoginId:ctx.username,createdByUserLoginId:ctx.username,createdDate:Date.now(),systemQuantityOnHand:number(zeroBalances.find(row=>text(row.productId)===i!.productId)?.quantityOnHand)}))},'PUT');
    return {saved:true,sessionId};
  }
  if(items.some(i=>i!.isRequested || i!.quantity===null)) throw new OmsLookupError('Only counted, undirected products can be discarded.',409);
  // SKIPPED follows the web app's real decision API. No APPLIED outcome is sent.
  // Require an existing facility inventory record to avoid the service's implicit
  // creation of inventory records for unmapped products.
  const balances=rows(await oms.get(`/rest/s1/oms/productFacilities/inventory?${new URLSearchParams({facilityId:ctx.facilityId,productId:selected.join(','),productId_op:'in',pageSize:'26'})}`));
  if(selected.some(productId=>!balances.some(row=>text(row.productId)===productId))) throw new OmsLookupError('An extra product has no facility inventory record. Review it in HotWax.');
  const pending=items.filter(i=>i!.decision!=='SKIPPED');
  if(pending.length) await oms.mutate(`${BASE}/submit`,{inventoryCountProductsList:pending.map(i=>({productId:i!.productId,facilityId:ctx.facilityId,workEffortId:id,countedQuantity:i!.quantity,decisionOutcomeEnumId:'SKIPPED',comments:'Undirected product discarded during POS count completion'}))});
  return {saved:true};
}

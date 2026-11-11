import {rows,text,type OmsConnection,type OmsRow} from '../../../shared/oms-connection';
import type {InventoryEvent} from './Inventory';

export type EventSource = {name?: string; actor?: string};
type SourceRecord = {name?: string; userLoginId?: string; workEffortId?: string};
type EventReference = Pick<InventoryEvent,'eventType' | 'reference'>;
type GraphConnection = {edges: {node: OmsRow | null}[]};

const RECEIPTS = new Set(['RECEIPT','TRANSFER_RECEIPT','RETURN_RESTOCK']);
const RESERVATIONS = new Set(['RESERVATION_CREATE','RESERVATION_RELEASE','TRANSFER_RESERVATION_CREATE','TRANSFER_RESERVATION_RELEASE']);
const PHYSICAL = new Set(['PHYSICAL_INVENTORY','CYCLE_COUNT']);
const eventType = (event: EventReference) => event.eventType.replace(/^SIE_/,'');
const field = (value: unknown) => text(value).trim();
const keyFilter = (ids: string[]) => [...new Set(ids)].filter(id=>/^[\w.@-]+$/.test(id));

export const eventSourceKey = (event: EventReference) => eventType(event)+'|'+event.reference;

function path(resource: string, filters: Record<string,string>) {
  return resource+'?'+new URLSearchParams(filters);
}

function orderName(order: OmsRow | undefined) {
  if (!order) return '';
  const name = field(order.orderName || order.orderId);
  if (!name) return '';
  const label = order.orderTypeId==='TRANSFER_ORDER' ? 'Transfer order' :
    order.orderTypeId==='PURCHASE_ORDER' ? 'Purchase order' : 'Order';
  return label+' '+name;
}

async function movements(oms: OmsConnection, events: EventReference[], kind: 'receipt' | 'issuance') {
  const ids = keyFilter(events.map(event=>event.reference));
  const records = new Map<string,SourceRecord>();
  if (!ids.length) return records;
  const root = kind==='receipt' ? 'shipmentReceipts' : 'itemIssuances';
  const idField = kind==='receipt' ? 'receiptId' : 'itemIssuanceId';
  const actorField = kind==='receipt' ? 'receivedByUserLoginId' : 'issuedByUserLoginId';
  const data = await oms.graphqlRead<Record<string,GraphConnection>>(`query StoreEventMovements($filter: String!, $first: Int!) {
    ${root}(query: $filter, first: $first) {
      edges { node {
        ${idField} ${actorField} orderId shipmentId returnId
        order { orderId orderName orderTypeId }
      } }
    }
  }`,{filter:idField+':'+ids.join(','),first:ids.length});
  for (const {node} of data[root].edges) {
    if (!node) continue;
    const name = orderName(node.order as OmsRow | undefined) ||
      (node.orderId ? 'Order '+field(node.orderId) : node.returnId ? 'Return '+field(node.returnId) :
        node.shipmentId ? 'Shipment '+field(node.shipmentId) : '');
    records.set(field(node[idField]),{name,userLoginId:field(node[actorField])});
  }
  return records;
}

async function physicalSources(oms: OmsConnection, events: EventReference[]) {
  const ids = keyFilter(events.map(event=>event.reference));
  const records = new Map<string,SourceRecord>();
  if (!ids.length) return records;
  const data = await oms.graphqlRead<{inventoryItemVariances: GraphConnection}>(`query StoreEventVariances($filter: String!) {
    inventoryItemVariances(query: $filter, first: 100) {
      edges { node {
        physicalInventoryId changeByUserLoginId comments
        physicalInventory { generalComments }
      } }
    }
  }`,{filter:'physicalInventoryId:'+ids.join(',')});
  for (const {node} of data.inventoryItemVariances.edges) {
    if (!node) continue;
    const reference = field(node.physicalInventoryId);
    const physical = node.physicalInventory as OmsRow | undefined;
    const name = field(physical?.generalComments || node.comments);
    const userLoginId = field(node.changeByUserLoginId);
    const existing = records.get(reference);
    if (!existing) records.set(reference,{name,userLoginId});
    else if (existing.userLoginId!==userLoginId) existing.userLoginId=undefined;
  }
  return records;
}

async function countSources(oms: OmsConnection, facilityId: string, events: EventReference[]) {
  const ids = keyFilter(events.map(event=>event.reference));
  if (!ids.length) return new Map<string,SourceRecord>();
  const result = await oms.get(path('/rest/s1/inventory-cycle-count/varianceDecisions',{
    facilityId,physicalInventoryId:ids.join(','),physicalInventoryId_op:'in',pageSize:'100',
  }));
  return new Map(rows(result).filter(row=>field(row.facilityId)===facilityId && ids.includes(field(row.physicalInventoryId)))
    .map(row=>[field(row.physicalInventoryId),{
      name:field(row.workEffortName),workEffortId:field(row.workEffortId),userLoginId:field(row.decidedByUserLoginId),
    }] as const));
}

async function reservationSource(oms: OmsConnection, facilityId: string, reference: string): Promise<SourceRecord> {
  const [item,seq,...extra] = reference.split(':');
  if (!item || !seq || extra.length) return {};
  const result = await oms.get(path('/rest/s1/oms/inventoryItem/'+encodeURIComponent(item)+'/detail',{
    inventoryItemDetailSeqId:seq,pageSize:'1',
  }));
  const row = rows(result).find(entry=>field(entry.inventoryItemId)===item &&
    field(entry.inventoryItemDetailSeqId)===seq && (!entry.facilityId || field(entry.facilityId)===facilityId));
  return row ? {name:orderName(row),workEffortId:field(row.workEffortId)} : {};
}

async function externalResetSource(oms: OmsConnection, reference: string): Promise<SourceRecord> {
  const reset = await oms.get('/rest/s1/poorti/externalInventoryResets/'+encodeURIComponent(reference));
  return field(reset.resetItemId)===reference ? {name:field(reset.description) || 'Inventory reset '+reference} : {};
}

async function workEffort(oms: OmsConnection, workEffortId: string): Promise<SourceRecord> {
  const result = await oms.get(path('/rest/s1/admin/workEfforts',{workEffortId,pageSize:'1'}));
  const row = rows(result).find(entry=>field(entry.workEffortId)===workEffortId);
  return row ? {name:field(row.workEffortName || row.description),userLoginId:field(row.createdByUserLogin)} : {};
}

async function actorName(oms: OmsConnection, userLoginId: string) {
  const result = await oms.get(path('/rest/s1/oms/users',{userLoginId,pageSize:'1'}));
  const row = rows(result).find(entry=>field(entry.userLoginId)===userLoginId);
  return row ? [field(row.firstName),field(row.lastName)].filter(Boolean).join(' ') || field(row.groupName) : '';
}

export async function readEventSources(oms: OmsConnection, facilityId: string, events: EventReference[]) {
  const unique = [...new Map(events.filter(event=>event.reference).map(event=>[eventSourceKey(event),event])).values()];
  const [receipt,issuance,physical,counts] = await Promise.all([
    movements(oms,unique.filter(event=>RECEIPTS.has(eventType(event))),'receipt').catch(()=>new Map<string,SourceRecord>()),
    movements(oms,unique.filter(event=>eventType(event)==='POS_ISSUANCE'),'issuance').catch(()=>new Map<string,SourceRecord>()),
    physicalSources(oms,unique.filter(event=>PHYSICAL.has(eventType(event)))).catch(()=>new Map<string,SourceRecord>()),
    countSources(oms,facilityId,unique.filter(event=>eventType(event)==='CYCLE_COUNT')).catch(()=>new Map<string,SourceRecord>()),
  ]);
  const sources = await Promise.all(unique.map(async event=>{
    const type = eventType(event);
    const {reference} = event;
    let record: SourceRecord | undefined;
    if (RECEIPTS.has(type)) record = receipt.get(reference);
    else if (type==='POS_ISSUANCE') record = issuance.get(reference);
    else if (PHYSICAL.has(type)) record = counts.get(reference) ?? physical.get(reference);
    else if (RESERVATIONS.has(type)) record = await reservationSource(oms,facilityId,reference).catch(()=>({}));
    else if (type==='EXTERNAL_RESET') record = await externalResetSource(oms,reference).catch(()=>({}));

    if (!record?.name && record?.workEffortId) {
      const effort = await workEffort(oms,record.workEffortId).catch(():SourceRecord=>({}));
      record = {name:effort.name,userLoginId:record.userLoginId || effort.userLoginId};
    }
    const actor = record?.userLoginId ? await actorName(oms,record.userLoginId).catch(()=>'') : '';
    return [eventSourceKey(event),{name:record?.name,actor}] as const;
  }));
  return new Map<string,EventSource>(sources);
}

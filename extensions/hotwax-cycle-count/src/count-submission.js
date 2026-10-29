// A timeout is not evidence that a write failed. Read before retrying, and only
// repeat reads after a failed write. The caller retains its journal throughout.
export async function recoverSubmission({read,write,done,checking=()=>{},current=()=>true,wait=ms=>new Promise(resolve=>setTimeout(resolve,ms))}) {
  const assertCurrent=()=>{if(!current())throw new Error('Counting user changed. Reopen the count.');};
  assertCurrent();
  const before=await read();assertCurrent();
  if(done(before))return before;
  try {const result=await write();assertCurrent();if(done(result))return result;}
  catch(error){
    assertCurrent();
    // Permission/validation refusals still get one read, in case an earlier
    // request completed. They do not need a network-recovery polling loop.
    const attempts=[400,401,403,404,409].includes(error?.status)?1:3;
    checking();
    for(let n=0;n<attempts;n++){
      if(n)await wait(n*1500);
      assertCurrent();
      let value;
      try {value=await read();} catch {continue;}
      assertCurrent();
      if(done(value))return value;
    }
    if(attempts===1)throw error;
  }
  throw new Error('Your quantities are saved. We could not confirm submission yet. Check again when connected.');
}

export const sessionSubmitted=value=>['SESSION_SUBMITTED','SESSION_APPROVED'].includes(value?.statusId);
export const countSubmitted=value=>['CYCLE_CNT_CMPLTD','CYCLE_CNT_CLOSED'].includes(value?.statusId);

// Only bypass session selection when there is one clear session for this user.
export function directSession(info) {
  const sessions=info.sessions.filter(s=>s.mine&&['SESSION_CREATED','SESSION_ASSIGNED'].includes(s.statusId));
  return sessions.length===1?sessions[0]:null;
}

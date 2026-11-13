export const internalEmail = email => typeof email === 'string' && email.endsWith('@pi-auth.invalid');
export function requireChallenge(row, now=Date.now()) {
 if (!row || !Number.isFinite(Date.parse(row.expires_at)) || Date.parse(row.expires_at)<=now || ['consumed','cancelled'].includes(row.state)) throw new Error('expired');
 return row;
}
export function validateIdentity(me) {
 if (!me || typeof me.uid!=='string' || !me.uid.trim() || me.uid.length>256 || typeof me.username!=='string' || !me.username.trim() || me.username.length>128) throw new Error('pi_identity_invalid');
 return {uid:me.uid, username:me.username};
}
export function requireOwner(row, userId) {
 if(row.purpose==='link' && (!userId || row.owner_id!==userId)) throw new Error('unauthorized');
}
export const validSecret = x => typeof x==='string' && /^[a-f0-9]{64}$/.test(x);
export function publicUser(user, username) {
 return {id:user.id,email:internalEmail(user.email)?null:user.email,pi_username:username};
}
// The store callback must compare-and-swap approved -> consumed atomically.
export async function consumeChallenge(row, userId, confirm, consume) {
 requireChallenge(row); requireOwner(row,userId);
 if(row.state!=='approved'||confirm!==true)throw new Error('confirmation_required');
 await consume(row);
}

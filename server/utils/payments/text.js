/*
  Postgres cannot store a NUL byte in a text or jsonb value, so one anywhere in what is about to be
  written can only end in a failed insert. Found by testing, twice over:

  - From a caller. On a payment that meant a processor intent was created first and cancelled again
    once the insert failed; on a refund it was worse — the processor had already moved the money
    when the insert failed, and the caller got a 500 for a refund that had happened. So what a
    caller hands over is checked up front (`hasNulByte`) and refused as a 400 before any provider
    is contacted.
  - From the processor. That same refund's reason came back on the webhook, and could not be
    recorded either. There is nothing to refuse there — the money has moved — so what the processor
    sends is cleaned (`stripNulBytes`) rather than rejected.
*/

export const hasNulByte = (...values) => {
  let found = false;

  for(const value of values){
    JSON.stringify(value ?? null, (key, entry) => {
      if(typeof entry === 'string' && entry.includes('\u0000')) found = true;
      return entry;
    });
    if(found) return true;
  }
  return false;
};

/*
  Works on a string or on anything JSON-shaped, so a whole webhook event can be cleaned before it is
  stored: the event is kept verbatim as a jsonb log entry, and one NUL anywhere inside it fails
  that insert and with it the whole delivery.
*/
export const stripNulBytes = value => {
  const clean = entry => typeof entry === 'string' ? entry.replaceAll('\u0000', '') : entry;

  if(value && typeof value === 'object') return JSON.parse(JSON.stringify(value, (key, entry) => clean(entry)));
  return clean(value);
};

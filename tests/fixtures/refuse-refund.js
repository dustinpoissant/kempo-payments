/*
  A payment:refunding guard that refuses every refund, the way an extension would.
*/
export default () => {
  throw { code: 409, msg: 'Refused by the test guard' };
};
